#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const forbiddenTailwindPackages = [
  "@tailwindcss/cli",
  "@tailwindcss/forms",
  "@tailwindcss/postcss",
  "@tailwindcss/typography",
  "prettier-plugin-tailwindcss",
  "tailwindcss",
];

const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const tailwindConfigPattern = /^tailwind\.config\.(cjs|js|mjs|ts)$/;

function fail(message) {
  throw new Error(message);
}

function readJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function collectRepositoryFiles(root, directory = root, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if ([".git", ".next", "coverage", "node_modules"].includes(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) collectRepositoryFiles(root, path, files);
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function dependencyVersion(manifest, name) {
  for (const section of dependencySections) {
    if (manifest[section]?.[name]) return manifest[section][name];
  }
  return undefined;
}

function repositoryPackageManifests(root) {
  return collectRepositoryFiles(root)
    .filter((path) => path.endsWith("package.json"))
    .map((path) => [
      relative(root, path),
      readJsonFile(path, relative(root, path)),
    ]);
}

function assertExactRootDependency(manifest, name, section) {
  const version = manifest[section]?.[name];
  if (!version) {
    fail(`root package.json must declare ${name} in ${section}`);
  }
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) {
    fail(`root ${name} dependency must pin an exact version`);
  }
}

function verifyProfileShape(profile) {
  if (profile.schemaVersion !== 1) fail("unsupported scaffold profile version");
  if (profile.ui?.library !== "mantine" || profile.ui?.tailwind !== false) {
    fail("scaffold profile must select Mantine and prohibit Tailwind");
  }
  if (!/^\d+\.\d+\.\d+$/.test(profile.framework?.version || "")) {
    fail("scaffold profile must pin an exact Next.js version");
  }
  if (!/^\d+\.\d+\.\d+$/.test(profile.ui?.version || "")) {
    fail("scaffold profile must pin an exact Mantine version");
  }
  if (
    !Array.isArray(profile.applications) ||
    profile.applications.length === 0
  ) {
    fail("scaffold profile must list at least one Next.js application");
  }
  if (
    !/^(npm|pnpm|yarn|bun)@\d+\.\d+\.\d+$/.test(profile.packageManager || "")
  ) {
    fail("scaffold profile must pin an exact supported package manager");
  }
  if (!/^\d+\.\d+\.\d+$/.test(profile.securityOverrides?.postcss || "")) {
    fail("scaffold profile must pin the PostCSS security override");
  }
}

function assertExactDependency(manifest, packagePath, name, expected) {
  const actual = dependencyVersion(manifest, name);
  if (actual !== expected) {
    fail(
      `${packagePath} must declare ${name}@${expected}; found ${actual || "missing"}`,
    );
  }
}

function verifyApplication(root, application, profile) {
  const packagePath = `${application}/package.json`;
  const manifestPath = join(root, packagePath);
  if (!existsSync(manifestPath))
    fail(`missing generated application: ${application}`);
  const manifest = readJsonFile(manifestPath, packagePath);
  assertExactDependency(
    manifest,
    packagePath,
    "next",
    profile.framework.version,
  );
  assertExactDependency(manifest, packagePath, "react", profile.react.version);
  assertExactDependency(
    manifest,
    packagePath,
    "react-dom",
    profile.react.version,
  );
  for (const name of ["@mantine/core", "@mantine/hooks"]) {
    assertExactDependency(manifest, packagePath, name, profile.ui.version);
  }

  const layoutPath = join(root, application, "app/layout.tsx");
  const layout = existsSync(layoutPath) ? readFileSync(layoutPath, "utf8") : "";
  for (const marker of [
    "@mantine/core/styles.css",
    "<ColorSchemeScript",
    "<MantineProvider",
    "mantineHtmlProps",
  ]) {
    if (!layout.includes(marker)) {
      fail(`${application}/app/layout.tsx is missing Mantine setup: ${marker}`);
    }
  }
  if (!existsSync(join(root, application, "postcss.config.mjs"))) {
    fail(`${application} is missing postcss.config.mjs for Mantine`);
  }
}

function verifyNoTailwind(root) {
  for (const path of collectRepositoryFiles(root)) {
    const repositoryPath = relative(root, path);
    if (tailwindConfigPattern.test(repositoryPath.split("/").at(-1))) {
      fail(`Tailwind configuration is prohibited: ${repositoryPath}`);
    }
    if (repositoryPath.endsWith("package.json")) {
      const manifest = readJsonFile(path, repositoryPath);
      for (const name of forbiddenTailwindPackages) {
        if (dependencyVersion(manifest, name)) {
          fail(
            `Tailwind dependency is prohibited in ${repositoryPath}: ${name}`,
          );
        }
      }
    }
    if (/\.(css|pcss|postcss)$/.test(repositoryPath)) {
      const content = readFileSync(path, "utf8");
      if (/(@tailwind\b|@import\s+["']tailwindcss["'])/.test(content)) {
        fail(`Tailwind directive is prohibited: ${repositoryPath}`);
      }
    }
  }
}

function verifyDependencyUpdatesEnabled(root) {
  const configPath = join(root, ".github/dependabot.yml");
  if (!existsSync(configPath)) {
    fail("initialized repository must include .github/dependabot.yml");
  }
  if (lstatSync(configPath).isSymbolicLink()) {
    fail("refusing symlinked .github/dependabot.yml");
  }
  const config = readFileSync(configPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, ""))
    .join("\n");
  if (/^\s*open-pull-requests-limit:\s*0\s*$/m.test(config)) {
    fail(
      "initialization must enable routine Dependabot version updates by removing open-pull-requests-limit: 0",
    );
  }
  for (const ecosystem of ["npm", "github-actions"]) {
    if (
      !new RegExp(
        `^\\s*-\\s+package-ecosystem:\\s*["']?${ecosystem}["']?\\s*$`,
        "m",
      ).test(config)
    ) {
      fail(`initialized Dependabot config must include ${ecosystem} updates`);
    }
  }
  const weeklySchedules = config.match(
    /^\s*interval:\s*["']?weekly["']?\s*$/gm,
  );
  if ((weeklySchedules || []).length < 2) {
    fail("initialized Dependabot config must schedule both ecosystems weekly");
  }
}

function verifyRootPackage(root, profile) {
  const manifest = readJsonFile(join(root, "package.json"), "package.json");
  if (manifest.packageManager !== profile.packageManager) {
    fail(
      `package.json must declare packageManager ${profile.packageManager}; found ${manifest.packageManager || "missing"}`,
    );
  }
  const postcss = profile.securityOverrides.postcss;
  if (
    manifest.overrides?.postcss !== postcss ||
    manifest.pnpm?.overrides?.postcss !== postcss ||
    manifest.resolutions?.postcss !== postcss
  ) {
    fail(
      `package.json must preserve the PostCSS ${postcss} security overrides`,
    );
  }
}

function verifyGeneratedReadme(root) {
  const readmePath = join(root, "README.md");
  if (!existsSync(readmePath)) fail("generated scaffold is missing README.md");
  if (lstatSync(readmePath).isSymbolicLink()) {
    fail("refusing symlinked generated README.md");
  }
  const readme = readFileSync(readmePath, "utf8");
  const requiredMarkers = [
    [
      "Parallel Slices generation statement",
      "starter project was generated by",
    ],
    [
      "Parallel Slices project link",
      "[Parallel Slices](https://github.com/jtrefry/parallel-slices)",
    ],
    [
      "canonical mechanism documentation",
      "github.com/jtrefry/parallel-slices/blob/main/docs/mechanism-map.md",
    ],
    ["Codex operating guide", "docs/parallel-slices/using-codex.md"],
    ["Cursor operating guide", "docs/parallel-slices/using-cursor.md"],
    [
      "Claude Code operating guide",
      "docs/parallel-slices/using-claude-code.md",
    ],
    ["supported Node.js prerequisites", "Node.js 22 LTS or 24 LTS"],
    ["independent reviewer prerequisite", "independent review provider CLI"],
    ["container prerequisite", "Docker Desktop"],
  ];
  for (const [label, marker] of requiredMarkers) {
    if (!readme.includes(marker)) {
      fail(`generated README.md must preserve ${label}`);
    }
  }
}

export function readScaffoldProfile(root) {
  const profilePath = join(root, ".parallel-slices/scaffold-profile.json");
  if (!existsSync(profilePath)) return null;
  if (lstatSync(profilePath).isSymbolicLink()) {
    fail("refusing symlinked scaffold profile");
  }
  return readJsonFile(profilePath, ".parallel-slices/scaffold-profile.json");
}

export function verifyScaffoldProfile(root) {
  const profile = readScaffoldProfile(root);
  if (!profile) return { status: "not-generated" };
  verifyProfileShape(profile);
  verifyRootPackage(root, profile);
  verifyGeneratedReadme(root);
  for (const application of profile.applications) {
    if (!/^apps\/[a-z0-9][a-z0-9-]*$/.test(application)) {
      fail(`unsafe application path in scaffold profile: ${application}`);
    }
    verifyApplication(root, application, profile);
  }
  verifyNoTailwind(root);
  return { applications: profile.applications, status: "verified" };
}

export function inspectArchitecture(root, options = {}) {
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath)) {
    fail(
      "the Next.js GCP PostgreSQL architecture requires a root package.json",
    );
  }
  if (
    !existsSync(join(root, "turbo.json")) &&
    !existsSync(join(root, "turbo.jsonc"))
  ) {
    fail(
      "the Next.js GCP PostgreSQL architecture requires turbo.json or turbo.jsonc",
    );
  }
  const rootPackage = readJsonFile(packagePath, "package.json");
  if (!dependencyVersion(rootPackage, "turbo")) {
    fail(
      "the Next.js GCP PostgreSQL architecture requires turbo in the root package",
    );
  }
  const manifests = repositoryPackageManifests(root);
  if (!manifests.some(([, manifest]) => dependencyVersion(manifest, "next"))) {
    fail(
      "the Next.js GCP PostgreSQL architecture requires at least one Next.js package",
    );
  }
  const scaffold = verifyScaffoldProfile(root);
  if (options.foundationReady) {
    assertExactRootDependency(rootPackage, "pg", "dependencies");
    assertExactRootDependency(rootPackage, "tsx", "dependencies");
    assertExactRootDependency(rootPackage, "@types/pg", "devDependencies");
    verifyDependencyUpdatesEnabled(root);
  }
  return {
    architecture: "nextjs-gcp-postgres",
    foundationReady: Boolean(options.foundationReady),
    scaffold,
    status: "verified",
  };
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    const command = process.argv[2];
    const target = process.argv[3] ? resolve(process.argv[3]) : process.cwd();
    if (!["inspect", "foundation", "verify-scaffold"].includes(command)) {
      fail(
        "usage: verify.mjs <inspect|foundation|verify-scaffold> [/absolute/path/to/repository]",
      );
    }
    const result =
      command === "verify-scaffold"
        ? verifyScaffoldProfile(target)
        : inspectArchitecture(target, {
            foundationReady: command === "foundation",
          });
    const scaffold = result.scaffold || result;
    if (scaffold.status === "not-generated") {
      console.log(
        "No generated scaffold profile; existing repository preserved",
      );
    } else {
      console.log(
        `Verified Mantine scaffold for ${scaffold.applications.join(", ")}`,
      );
    }
  } catch (error) {
    console.error(`NEXTJS GCP POSTGRES ARCHITECTURE FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
