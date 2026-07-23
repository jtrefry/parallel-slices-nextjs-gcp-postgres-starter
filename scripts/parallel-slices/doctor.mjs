#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertBranchAllowed,
  detectPackageManager,
  entrypointStepIds,
  loadQualityConfig,
  packageManagerCommand,
  readPackageManagerSpec,
} from "./project-quality.mjs";
import {
  hasInitializationMarker,
  projectStages,
  readProjectState,
  requiredProjectDocuments,
} from "./project-state.mjs";
import { readRepositoryProfile } from "./repository-profile.mjs";
import { loadReviewConfig } from "./review-config.mjs";
import { readArchitectureProfile } from "./architecture-profile.mjs";

export function isSupportedNodeMajor(major) {
  return major === 22 || major === 24;
}

export function parseNodePinMajor(content, source) {
  const pattern =
    source === ".tool-versions"
      ? /^nodejs\s+v?(\d+)(?:\.|\s|$)/m
      : /^\s*v?(\d+)(?:\.|\s|$)/;
  const match = pattern.exec(content);
  return match ? Number(match[1]) : null;
}

export function classifyDockerContext(context) {
  if (/rancher-desktop/i.test(context)) return "rancher-desktop";
  if (/desktop-linux|docker-desktop/i.test(context)) return "docker-desktop";
  return "other";
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commandResult(command, args, root) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function architectureVerification(root, foundationReady) {
  const profile = readArchitectureProfile(root);
  const resolvedRoot = resolve(root);
  const verifier = resolve(resolvedRoot, profile.installedVerifier);
  if (!verifier.startsWith(`${resolvedRoot}${sep}`) || !existsSync(verifier)) {
    throw new Error(
      `installed architecture verifier is missing: ${profile.installedVerifier}`,
    );
  }
  if (lstatSync(verifier).isSymbolicLink()) {
    throw new Error("refusing symlinked installed architecture verifier");
  }
  const result = commandResult(
    process.execPath,
    [verifier, foundationReady ? "foundation" : "inspect", root],
    root,
  );
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || `${profile.id} architecture verification failed`,
    );
  }
  return profile;
}

export function runDoctor(options = {}) {
  const root =
    options.root || git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const errors = [];
  const warnings = [];
  const ok = (message) => console.log(`ok: ${message}`);
  const error = (message) => errors.push(message);
  const warn = (message) => warnings.push(message);

  const major = Number(process.versions.node.split(".")[0]);
  if (isSupportedNodeMajor(major)) ok(`Node.js ${process.versions.node}`);
  else error("Node.js 22 LTS or 24 LTS is required; Node.js 24 is recommended");

  try {
    const state = readProjectState(root);
    const stageIndex = projectStages.indexOf(state.stage);
    if (
      options.foundationReady &&
      stageIndex < projectStages.indexOf("foundation-ready")
    ) {
      error(
        `project stage is ${state.stage}; the approved foundation is not ready`,
      );
    } else if (
      options.initialized &&
      stageIndex < projectStages.indexOf("contract-ready")
    ) {
      error(
        `project stage is ${state.stage}; run an enabled tool's initialization workflow`,
      );
    } else if (state.stage === "initialization-required") {
      warn(
        "project initialization is not complete; run an enabled tool's initialization workflow",
      );
    } else ok(`project stage ${state.stage}`);
  } catch (caught) {
    error(caught.message);
  }

  try {
    const repository = readRepositoryProfile(root);
    const label =
      repository.mode === "github"
        ? `${repository.repository} via ${repository.remote}`
        : "local-only";
    ok(`repository publication ${label}`);
  } catch (caught) {
    error(caught.message);
  }

  let config;
  try {
    config = loadQualityConfig(root);
    const branch = options.branch || git(root, ["branch", "--show-current"]);
    if (!(
      options.allowProtectedBranch && config.protectedBranches.includes(branch)
    )) {
      assertBranchAllowed(branch, config, {
        allowAutomation: options.allowAutomation,
      });
    }
    ok(`branch ${branch}`);
  } catch (caught) {
    error(caught.message);
  }

  try {
    const review = loadReviewConfig(root);
    if (review.enabled) {
      ok(
        `multi-agent review enabled with ${review.reviewers.length} reviewer${review.reviewers.length === 1 ? "" : "s"}`,
      );
    } else ok("multi-agent review disabled");
  } catch (caught) {
    error(caught.message);
  }

  const packagePath = resolve(root, "package.json");
  let pkg;
  if (!existsSync(packagePath)) error("root package.json is missing");
  else if (config) {
    pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    const manager = detectPackageManager(root, config.packageManager);
    const [managerCommand, managerArgs] = packageManagerCommand(manager, [
      "--version",
    ]);
    const version = commandResult(managerCommand, managerArgs, root);
    if (version.status === 0) ok(`${manager} ${version.stdout.trim()}`);
    else error(`${manager} is unavailable or failed to report its version`);
    for (const id of entrypointStepIds(config)) {
      const step = config.steps[id];
      const script = step.scripts.find((candidate) => pkg.scripts?.[candidate]);
      if (script) ok(`${step.name} -> ${script}`);
      else if (options.foundationReady) {
        error(
          `required package script is missing for ${step.name}: ${step.scripts.join(" or ")}`,
        );
      } else
        warn(
          `the approved foundation must create a root script for ${step.name} (${id})`,
        );
    }
  }

  if (options.foundationReady && pkg) {
    try {
      const pinnedManager = readPackageManagerSpec(root);
      const lockfiles = {
        npm: ["package-lock.json"],
        pnpm: ["pnpm-lock.yaml"],
        yarn: ["yarn.lock"],
        bun: ["bun.lock", "bun.lockb"],
      }[pinnedManager.manager];
      if (!lockfiles.some((path) => existsSync(resolve(root, path)))) {
        error(
          `the pinned ${pinnedManager.manager} package manager requires its committed lockfile`,
        );
      } else ok(`${pinnedManager.manager} lockfile`);
      const [managerCommand, managerArgs] = packageManagerCommand(
        pinnedManager.manager,
        ["--version"],
      );
      const installed = commandResult(managerCommand, managerArgs, root);
      if (
        installed.status !== 0 ||
        installed.stdout.trim() !== pinnedManager.version
      ) {
        error(
          `${pinnedManager.spec} is required, but the active version is ${installed.stdout.trim() || "unavailable"}`,
        );
      } else ok(`active package manager ${pinnedManager.spec}`);
    } catch (caught) {
      error(caught.message);
    }
    if (!pkg.engines?.node)
      error(
        "root package.json must declare the supported Node.js engine range",
      );
    else ok(`Node.js engine ${pkg.engines.node}`);
    const nodePins = [];
    for (const path of [".node-version", ".nvmrc", ".tool-versions"]) {
      if (!existsSync(resolve(root, path))) continue;
      const pinnedMajor = parseNodePinMajor(
        readFileSync(resolve(root, path), "utf8"),
        path,
      );
      if (pinnedMajor === null)
        error(`could not parse the Node.js version in ${path}`);
      else nodePins.push([path, pinnedMajor]);
    }
    if (pkg.volta?.node) {
      const pinnedMajor = parseNodePinMajor(
        pkg.volta.node,
        "package.json volta.node",
      );
      if (pinnedMajor === null)
        error("could not parse package.json volta.node");
      else nodePins.push(["package.json volta.node", pinnedMajor]);
    }
    if (!nodePins.length) {
      error(
        "pin Node.js with .node-version, .nvmrc, .tool-versions, or package.json volta.node",
      );
    } else {
      const majors = [...new Set(nodePins.map(([, major]) => major))];
      if (majors.length > 1) {
        error(
          `repository Node.js version pins disagree: ${nodePins.map(([path, major]) => `${path}=${major}`).join(", ")}`,
        );
      } else if (!isSupportedNodeMajor(majors[0])) {
        error(
          `repository pins unsupported Node.js ${majors[0]}; use 22 or 24 LTS`,
        );
      } else ok(`repository Node.js ${majors[0]} pin`);
    }
  }

  try {
    const architecture = architectureVerification(
      root,
      Boolean(options.foundationReady),
    );
    ok(`architecture ${architecture.id}@${architecture.packageVersion}`);
  } catch (caught) {
    error(caught.message);
  }

  const agentsPath = resolve(root, "AGENTS.md");
  if (!existsSync(agentsPath)) error("root AGENTS.md is missing");
  else {
    const agents = readFileSync(agentsPath, "utf8");
    if (hasInitializationMarker(agents)) {
      if (options.initialized)
        error("root AGENTS.md still requires /parallel-slices-init");
      else
        warn(
          "project initialization is not complete; run an enabled tool's initialization workflow",
        );
    } else ok("project-specific AGENTS.md");
  }

  if (options.initialized) {
    for (const path of requiredProjectDocuments(root)) {
      if (existsSync(resolve(root, path))) ok(path);
      else error(`initialized project document is missing: ${path}`);
    }
  }

  if (options.requireContainers) {
    const info = commandResult("docker", ["info"], root);
    const compose = commandResult("docker", ["compose", "version"], root);
    if (info.status !== 0)
      error("Docker is unavailable or the local engine is not running");
    else ok("Docker engine is running");
    if (compose.status !== 0) error("Docker Compose is unavailable");
    else ok(compose.stdout.trim());
    if (info.status === 0) {
      const context = commandResult("docker", ["context", "show"], root);
      const name = context.status === 0 ? context.stdout.trim() : "";
      const kind = classifyDockerContext(name);
      if (kind === "docker-desktop")
        ok(`supported Docker Desktop context ${name}`);
      else if (kind === "rancher-desktop") {
        warn(
          "Rancher Desktop Moby is a best-effort alternative, not the guaranteed runtime",
        );
      } else
        warn(
          `unrecognized Docker context ${name || "<unknown>"}; Docker Desktop is supported`,
        );
    }
  }

  for (const message of warnings) console.warn(`warning: ${message}`);
  if (errors.length) {
    for (const message of errors) console.error(`error: ${message}`);
    throw new Error(
      `doctor found ${errors.length} blocking problem${errors.length === 1 ? "" : "s"}`,
    );
  }
  console.log(
    `doctor passed with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`,
  );
  return { warnings };
}

function parseOptions(argv) {
  const allowed = new Set([
    "--initialized",
    "--foundation-ready",
    "--require-containers",
  ]);
  for (const argument of argv) {
    if (!allowed.has(argument))
      throw new Error(`unknown argument: ${argument}`);
  }
  return {
    initialized:
      argv.includes("--initialized") || argv.includes("--foundation-ready"),
    foundationReady: argv.includes("--foundation-ready"),
    requireContainers: argv.includes("--require-containers"),
  };
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    runDoctor(parseOptions(process.argv.slice(2)));
  } catch (caught) {
    console.error(`DOCTOR FAILED: ${caught.message}`);
    process.exitCode = 1;
  }
}
