#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readArchitectureProfile } from "./architecture-profile.mjs";
import { hasInitializationMarker, readProjectState } from "./project-state.mjs";

export const generatedBaselinePath = ".parallel-slices/generated-baseline.json";

const safePathPattern =
  /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$)[A-Za-z0-9._/-]+$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(message);
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function assertSafePath(path) {
  if (!safePathPattern.test(path || "")) {
    fail(`generated baseline contains an unsafe path: ${path}`);
  }
  return path;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readCandidatePaths(root) {
  const output = git(root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
  ]);
  return output
    .split("\0")
    .filter((path) => path && path !== generatedBaselinePath)
    .map(assertSafePath)
    .sort();
}

function describeFile(root, path) {
  const absolute = resolve(root, path);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`generated baseline accepts regular files only: ${path}`);
  }
  return {
    path,
    sha256: sha256(absolute),
    executable: Boolean(stat.mode & 0o111),
  };
}

function expectedArchitecture(root) {
  const profile = readArchitectureProfile(root);
  return {
    id: profile.id,
    packageVersion: profile.packageVersion,
    manifestSha256: profile.manifestSha256,
  };
}

function assertPristineProjectState(root) {
  const state = readProjectState(root);
  if (state.stage !== "initialization-required") {
    fail(
      "generated baseline is valid only while project initialization is required",
    );
  }
  const agentsPath = resolve(root, "AGENTS.md");
  if (
    !existsSync(agentsPath) ||
    !hasInitializationMarker(readFileSync(agentsPath, "utf8"))
  ) {
    fail("generated baseline requires the bootstrap AGENTS.md marker");
  }
}

function validateShape(baseline) {
  if (
    baseline?.version !== 1 ||
    !baseline.architecture ||
    typeof baseline.architecture !== "object" ||
    Array.isArray(baseline.architecture) ||
    !Array.isArray(baseline.files) ||
    Object.keys(baseline).some(
      (key) => !["version", "architecture", "files"].includes(key),
    )
  ) {
    fail("generated baseline has an invalid version or shape");
  }
  const architectureKeys = Object.keys(baseline.architecture);
  if (
    architectureKeys.length !== 3 ||
    architectureKeys.some(
      (key) => !["id", "packageVersion", "manifestSha256"].includes(key),
    ) ||
    typeof baseline.architecture.id !== "string" ||
    typeof baseline.architecture.packageVersion !== "string" ||
    !sha256Pattern.test(baseline.architecture.manifestSha256 || "")
  ) {
    fail("generated baseline has invalid architecture identity");
  }
  const seen = new Set();
  for (const file of baseline.files) {
    if (
      !file ||
      typeof file !== "object" ||
      Array.isArray(file) ||
      Object.keys(file).length !== 3 ||
      Object.keys(file).some(
        (key) => !["path", "sha256", "executable"].includes(key),
      ) ||
      !sha256Pattern.test(file.sha256 || "") ||
      typeof file.executable !== "boolean"
    ) {
      fail("generated baseline contains an invalid file record");
    }
    assertSafePath(file.path);
    if (file.path === generatedBaselinePath || seen.has(file.path)) {
      fail(
        `generated baseline contains a duplicate or recursive path: ${file.path}`,
      );
    }
    seen.add(file.path);
  }
  const paths = baseline.files.map((file) => file.path);
  if (JSON.stringify(paths) !== JSON.stringify([...paths].sort())) {
    fail("generated baseline file records must be sorted by path");
  }
  return baseline;
}

export function recordGeneratedBaseline(root) {
  assertPristineProjectState(root);
  const path = resolve(root, generatedBaselinePath);
  if (existsSync(path)) {
    fail(`refusing to overwrite existing ${generatedBaselinePath}`);
  }
  const baseline = {
    version: 1,
    architecture: expectedArchitecture(root),
    files: readCandidatePaths(root).map((file) => describeFile(root, file)),
  };
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return baseline;
}

export function verifyGeneratedBaseline(root) {
  assertPristineProjectState(root);
  const path = resolve(root, generatedBaselinePath);
  if (!existsSync(path)) {
    fail(`${generatedBaselinePath} is missing`);
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${generatedBaselinePath} must be a regular file`);
  }
  let baseline;
  try {
    baseline = validateShape(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail(`${generatedBaselinePath} is invalid JSON`);
    }
    throw error;
  }
  if (
    JSON.stringify(baseline.architecture) !==
    JSON.stringify(expectedArchitecture(root))
  ) {
    fail("generated baseline architecture identity does not match selection");
  }
  const actualPaths = readCandidatePaths(root);
  const expectedPaths = baseline.files.map((file) => file.path);
  const missing = expectedPaths.filter((file) => !actualPaths.includes(file));
  const unexpected = actualPaths.filter(
    (file) => !expectedPaths.includes(file),
  );
  if (missing.length || unexpected.length) {
    fail(
      `generated baseline file set changed${missing.length ? `; missing: ${missing.join(", ")}` : ""}${unexpected.length ? `; unexpected: ${unexpected.join(", ")}` : ""}`,
    );
  }
  for (const expected of baseline.files) {
    const actual = describeFile(root, expected.path);
    if (
      actual.sha256 !== expected.sha256 ||
      actual.executable !== expected.executable
    ) {
      fail(`generated baseline file changed: ${expected.path}`);
    }
  }
  return baseline;
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    if (process.argv.length > 3) {
      fail("usage: generated-baseline.mjs [root]");
    }
    const baseline = verifyGeneratedBaseline(
      resolve(process.argv[2] || process.cwd()),
    );
    console.log(`generated baseline verified: ${baseline.files.length} files`);
  } catch (error) {
    console.error(`GENERATED BASELINE ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
