#!/usr/bin/env node

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ScannerConfig = {
  version: number;
  roots: string[];
  extensions: string[];
  excludeDirectories: string[];
  maximumFileBytes: number;
};

type Finding = {
  file: string;
  line: number;
  rule: string;
  message: string;
  remediation: string;
};

type LineRule = {
  id: string;
  extensions: ReadonlySet<string>;
  pattern: RegExp;
  message: string;
  remediation: string;
};

const lineRules: LineRule[] = [
  {
    id: "SQL001",
    extensions: new Set([".sql"]),
    pattern: /\bEXECUTE\b[^;]{0,2000}(?:\|\||\bconcat\s*\()/i,
    message: "Dynamic SQL is assembled through concatenation.",
    remediation:
      "Use EXECUTE ... USING for values and format('%I', identifier) for allow-listed identifiers.",
  },
  {
    id: "SQL002",
    extensions: new Set([".sql"]),
    pattern: /\bEXECUTE\s+format\s*\([^;]{0,2000}%s/i,
    message: "Dynamic SQL uses format('%s'), which does not quote SQL values.",
    remediation:
      "Use %I for identifiers, %L for literals, or USING parameters.",
  },
  {
    id: "APP001",
    extensions: new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]),
    pattern: /\b(?:query|execute|raw)\s*\(\s*`[^`]*\$\{/i,
    message:
      "A database call receives an interpolated, untagged template string.",
    remediation:
      "Use the database driver's parameter API or a safe tagged template.",
  },
  {
    id: "APP002",
    extensions: new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]),
    pattern: /(?:\$queryRawUnsafe|\$executeRawUnsafe|\.unsafe)\s*\(/,
    message: "An explicitly unsafe database API is used.",
    remediation: "Replace it with the driver's parameterized query API.",
  },
  {
    id: "APP003",
    extensions: new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]),
    pattern: /\b(?:query|execute|raw)\s*\(\s*["'][^"']*["']\s*\+/i,
    message: "A database call receives a concatenated SQL string.",
    remediation:
      "Pass values as query parameters instead of concatenating them.",
  },
];

const migrationDirectory = "apps/backend/migrations/";
const migrationNamePattern = /^\d{14}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const migrationTemplate = `${migrationDirectory}_MIGRATION_TEMPLATE.sql`;

function fail(message: string): never {
  throw new Error(message);
}

function readConfig(root: string): ScannerConfig {
  const path = resolve(root, ".parallel-slices/sql-security.json");
  if (!existsSync(path)) fail(".parallel-slices/sql-security.json is missing");
  if (lstatSync(path).isSymbolicLink()) {
    fail(".parallel-slices/sql-security.json must not be a symbolic link");
  }
  const config = JSON.parse(readFileSync(path, "utf8")) as ScannerConfig;
  if (
    config.version !== 1 ||
    !Array.isArray(config.roots) ||
    config.roots.length === 0 ||
    config.roots.some(
      (root) =>
        typeof root !== "string" ||
        root.startsWith("/") ||
        root.includes("\\") ||
        root.split("/").some((segment) => ["", ".", ".."].includes(segment)),
    ) ||
    !Array.isArray(config.extensions) ||
    config.extensions.length === 0 ||
    config.extensions.some(
      (extension) =>
        typeof extension !== "string" || !/^\.[a-z0-9]+$/i.test(extension),
    ) ||
    !Array.isArray(config.excludeDirectories) ||
    config.excludeDirectories.some(
      (directory) =>
        typeof directory !== "string" ||
        !/^[A-Za-z0-9._-]+$/.test(directory) ||
        directory === "." ||
        directory === "..",
    ) ||
    !Number.isInteger(config.maximumFileBytes) ||
    config.maximumFileBytes < 1 ||
    config.maximumFileBytes > 10_000_000
  ) {
    fail("invalid SQL security scanner configuration");
  }
  return config;
}

function collectFiles(
  root: string,
  path: string,
  config: ScannerConfig,
  findings: Finding[],
): string[] {
  if (!existsSync(path)) return [];
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) {
    findings.push({
      file: relative(root, path).replaceAll("\\", "/"),
      line: 1,
      rule: "SCAN001",
      message: "A scan root contains a symbolic link.",
      remediation: "Replace the symlink with reviewed repository content.",
    });
    return [];
  }
  if (metadata.isFile()) {
    return config.extensions.includes(extname(path)) ? [path] : [];
  }
  if (!metadata.isDirectory()) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && config.excludeDirectories.includes(entry.name)) {
      return [];
    }
    return collectFiles(root, resolve(path, entry.name), config, findings);
  });
}

function isSuppressed(lines: string[], index: number, rule: string): boolean {
  const annotation = new RegExp(
    `sql-security-ignore\\s+${rule}:\\s+.{10,}`,
    "i",
  );
  return (
    annotation.test(lines[index] || "") ||
    annotation.test(lines[index - 1] || "")
  );
}

function scanPatternRules(
  file: string,
  content: string,
  extension: string,
): Finding[] {
  const lines = content.split(/\r?\n/);
  const findings: Finding[] = [];
  for (const rule of lineRules) {
    if (!rule.extensions.has(extension)) continue;
    const pattern = new RegExp(rule.pattern.source, `${rule.pattern.flags}g`);
    for (const match of content.matchAll(pattern)) {
      const index = content.slice(0, match.index).split(/\r?\n/).length - 1;
      if (/^\s*(?:\/\/|--|#)/.test(lines[index] || "")) continue;
      if (isSuppressed(lines, index, rule.id)) continue;
      findings.push({
        file,
        line: index + 1,
        rule: rule.id,
        message: rule.message,
        remediation: rule.remediation,
      });
    }
  }
  return findings;
}

function scanMigrationContract(file: string, content: string): Finding[] {
  if (!file.startsWith(migrationDirectory) || file === migrationTemplate) {
    return [];
  }

  const findings: Finding[] = [];
  const name = file.slice(migrationDirectory.length);
  if (name.includes("/") || !migrationNamePattern.test(name)) {
    findings.push({
      file,
      line: 1,
      rule: "MIG001",
      message: "Migration filename does not match the ordered naming contract.",
      remediation:
        "Use a UTC timestamp and snake_case description: YYYYMMDDHHMMSS_description.sql.",
    });
  }
  if (!content.trim()) {
    findings.push({
      file,
      line: 1,
      rule: "MIG002",
      message: "Migration file is empty.",
      remediation:
        "Add the reviewed forward migration or delete the empty file.",
    });
  }

  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;\s*(?:--.*)?$/i.test(line)) {
      continue;
    }
    if (isSuppressed(lines, index, "MIG003")) continue;
    findings.push({
      file,
      line: index + 1,
      rule: "MIG003",
      message: "Migration contains explicit transaction control.",
      remediation:
        "Remove BEGIN, COMMIT, or ROLLBACK; the migration runner owns the transaction.",
    });
  }
  return findings;
}

function scanSecurityDefiner(file: string, content: string): Finding[] {
  const findings: Finding[] = [];
  const pattern =
    /CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION[\s\S]*?SECURITY\s+DEFINER[\s\S]*?(?=CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION|$)/gi;
  for (const match of content.matchAll(pattern)) {
    if (/\bSET\s+search_path\s*=/i.test(match[0])) continue;
    const line = content.slice(0, match.index).split(/\r?\n/).length;
    const lines = content.split(/\r?\n/);
    if (isSuppressed(lines, line - 1, "SQL003")) continue;
    findings.push({
      file,
      line,
      rule: "SQL003",
      message: "SECURITY DEFINER function does not set a trusted search_path.",
      remediation:
        "Set an explicit trusted search_path and schema-qualify referenced objects.",
    });
  }
  return findings;
}

function scanFile(
  root: string,
  path: string,
  config: ScannerConfig,
): Finding[] {
  const relativePath = relative(root, path).replaceAll("\\", "/");
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      return [
        {
          file: relativePath,
          line: 1,
          rule: "SCAN001",
          message: "A scanned file became a symbolic link.",
          remediation: "Replace the symlink with reviewed repository content.",
        },
      ];
    }
    throw error;
  }
  try {
    const metadata = fstatSync(descriptor);
    if (metadata.size > config.maximumFileBytes) {
      return [
        {
          file: relativePath,
          line: 1,
          rule: "SCAN002",
          message: `File exceeds ${config.maximumFileBytes} bytes and was not scanned.`,
          remediation:
            "Split the file or explicitly adjust the reviewed scanner limit.",
        },
      ];
    }
    const content = readFileSync(descriptor, "utf8");
    const findings = scanPatternRules(relativePath, content, extname(path));
    if (extname(path) === ".sql") {
      findings.push(...scanSecurityDefiner(relativePath, content));
      findings.push(...scanMigrationContract(relativePath, content));
    }
    return findings;
  } finally {
    closeSync(descriptor);
  }
}

export function scanRepository(root = process.cwd()): Finding[] {
  const repositoryRoot = resolve(root);
  const config = readConfig(repositoryRoot);
  const findings: Finding[] = [];
  const files = config.roots.flatMap((path) =>
    collectFiles(
      repositoryRoot,
      resolve(repositoryRoot, path),
      config,
      findings,
    ),
  );
  for (const path of [...new Set(files)].sort()) {
    findings.push(...scanFile(repositoryRoot, path, config));
  }
  return findings;
}

function main(): void {
  const findings = scanRepository();
  if (findings.length === 0) {
    console.log("SQL security scan passed");
    return;
  }
  for (const finding of findings) {
    console.error(
      `${finding.file}:${finding.line} ${finding.rule} ${finding.message}\n  ${finding.remediation}`,
    );
  }
  console.error(`SQL SECURITY SCAN FAILED: ${findings.length} finding(s)`);
  process.exitCode = 1;
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) main();
