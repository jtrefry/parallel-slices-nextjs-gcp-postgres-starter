#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const profileRelativePath = ".parallel-slices/architecture.json";
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const capabilityPattern = /^[a-z][a-z0-9]*(?::[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const safePathPattern =
  /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$)[A-Za-z0-9._/-]+$/;
const controllers = Object.freeze(["cursor", "codex", "claude-code"]);
const entrypoints = Object.freeze([
  "generatedBaseline",
  "preCommit",
  "prePush",
  "ci",
  "loop",
]);

function fail(message) {
  throw new Error(message);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
}

function assertUniqueStrings(values, pattern, label) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => typeof value !== "string" || !pattern.test(value)) ||
    new Set(values).size !== values.length
  ) {
    fail(`${label} must contain unique valid values`);
  }
}

export function validateArchitectureProfile(profile) {
  assertObject(profile, "architecture profile");
  const allowed = new Set([
    "$schema",
    "version",
    "id",
    "packageName",
    "packageVersion",
    "manifestSha256",
    "components",
    "capabilities",
    "options",
    "entrypointCapabilityFloors",
    "projectDocuments",
    "installedFiles",
    "installedVerifier",
    "controllerCommands",
  ]);
  const unknown = Object.keys(profile).filter((key) => !allowed.has(key));
  if (unknown.length)
    fail(`architecture profile has unknown fields: ${unknown.join(", ")}`);
  if (
    profile.$schema !== "./architecture.schema.json" ||
    profile.version !== 1 ||
    !idPattern.test(profile.id || "") ||
    profile.packageName !== `@parallel-slices/architecture-${profile.id}` ||
    !/^\d+\.\d+\.\d+$/.test(profile.packageVersion || "") ||
    !/^[a-f0-9]{64}$/.test(profile.manifestSha256 || "")
  ) {
    fail("architecture profile identity is invalid");
  }
  if (!Array.isArray(profile.components) || profile.components.length === 0) {
    fail("architecture profile must include components");
  }
  assertUniqueStrings(
    profile.capabilities,
    capabilityPattern,
    "architecture capabilities",
  );
  assertObject(profile.options, "architecture options");
  assertObject(
    profile.entrypointCapabilityFloors,
    "entrypoint capability floors",
  );
  for (const entrypoint of entrypoints) {
    assertUniqueStrings(
      profile.entrypointCapabilityFloors[entrypoint],
      capabilityPattern,
      `${entrypoint} capability floor`,
    );
  }
  assertUniqueStrings(
    profile.projectDocuments,
    safePathPattern,
    "project documents",
  );
  assertUniqueStrings(
    profile.installedFiles,
    safePathPattern,
    "installed architecture files",
  );
  if (!safePathPattern.test(profile.installedVerifier || "")) {
    fail("installed architecture verifier path is unsafe");
  }
  assertObject(profile.controllerCommands, "controller commands");
  if (
    Object.keys(profile.controllerCommands).length !== controllers.length ||
    controllers.some(
      (controller) =>
        typeof profile.controllerCommands[controller] !== "string" ||
        !profile.controllerCommands[controller].trim(),
    )
  ) {
    fail("architecture profile must define every controller command");
  }
  return profile;
}

export function readArchitectureProfile(root = process.cwd()) {
  const path = resolve(root, profileRelativePath);
  if (!existsSync(path)) fail(`${profileRelativePath} is missing`);
  if (lstatSync(path).isSymbolicLink()) {
    fail(`refusing symlinked architecture profile: ${path}`);
  }
  try {
    return validateArchitectureProfile(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    fail(`invalid architecture profile: ${error.message}`);
  }
}

export function initializeCommandForController(
  controller,
  root = process.cwd(),
) {
  if (!controllers.includes(controller))
    fail(`unknown controller: ${controller}`);
  return readArchitectureProfile(root).controllerCommands[controller];
}

function parseRoot(value) {
  const root = value || process.cwd();
  if (!isAbsolute(root)) fail("target must be an absolute path");
  return resolve(root);
}

function runCli(argv) {
  const [command, value, target] = argv;
  if (command === "show" && argv.length <= 2) {
    const profile = readArchitectureProfile(parseRoot(value));
    console.log(`${profile.id}@${profile.packageVersion}`);
    return;
  }
  if (command === "id" && argv.length <= 2) {
    console.log(readArchitectureProfile(parseRoot(value)).id);
    return;
  }
  if (command === "installed-verifier" && argv.length <= 2) {
    console.log(readArchitectureProfile(parseRoot(value)).installedVerifier);
    return;
  }
  if (command === "initialize-command" && value && argv.length <= 3) {
    console.log(initializeCommandForController(value, parseRoot(target)));
    return;
  }
  if (command === "verify" && argv.length <= 2) {
    const root = parseRoot(value);
    const profile = readArchitectureProfile(root);
    const verifier = resolve(root, profile.installedVerifier);
    if (!verifier.startsWith(`${root}/`) || !existsSync(verifier)) {
      fail(
        `installed architecture verifier is missing: ${profile.installedVerifier}`,
      );
    }
    console.log(
      `selected architecture valid: ${profile.id}@${profile.packageVersion}`,
    );
    return;
  }
  fail(
    "usage: architecture-profile.mjs show|id|installed-verifier|verify [absolute-target] | " +
      "initialize-command <controller> [absolute-target]",
  );
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`ARCHITECTURE PROFILE ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
