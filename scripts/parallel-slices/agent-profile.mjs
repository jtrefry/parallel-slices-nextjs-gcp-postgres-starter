#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const agentDefinitions = Object.freeze({
  cursor: Object.freeze({
    id: "cursor",
    label: "Cursor",
    skillDirectory: ".cursor/skills",
    prepareCommand: "/parallel-slices-prepare",
    continuationCommand: "/loop",
  }),
  codex: Object.freeze({
    id: "codex",
    label: "Codex",
    skillDirectory: ".agents/skills",
    prepareCommand: "$parallel-slices-prepare",
    continuationCommand: "/goal",
  }),
  "claude-code": Object.freeze({
    id: "claude-code",
    label: "Claude Code",
    skillDirectory: ".claude/skills",
    prepareCommand: "/parallel-slices-prepare",
    continuationCommand: "/goal",
  }),
});

export const supportedAgents = Object.freeze(Object.keys(agentDefinitions));
const profileRelativePath = ".parallel-slices/agent.json";

function fail(message) {
  throw new Error(message);
}

export function validateAgent(agent) {
  if (!supportedAgents.includes(agent)) {
    fail(`agent must be one of: ${supportedAgents.join(", ")}`);
  }
  return agent;
}

function profilePath(root) {
  return resolve(root, profileRelativePath);
}

function assertProfilePathSafe(root) {
  const directory = dirname(profilePath(root));
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) {
    fail(`refusing symlinked agent profile directory: ${directory}`);
  }
}

function normalizeProfile(profile) {
  if (profile?.schema === 1) {
    validateAgent(profile.agent);
    return {
      $schema: "./agent.schema.json",
      version: 2,
      enabledControllers: [...supportedAgents],
      defaultController: profile.agent,
      migratedFromVersion: 1,
    };
  }
  if (!profile || profile.version !== 2) {
    fail("invalid agent profile version");
  }
  if (profile.$schema !== "./agent.schema.json") {
    fail("agent profile must reference ./agent.schema.json");
  }
  if (
    !Array.isArray(profile.enabledControllers) ||
    profile.enabledControllers.length !== supportedAgents.length ||
    supportedAgents.some(
      (agent, index) => profile.enabledControllers[index] !== agent,
    )
  ) {
    fail(
      `enabledControllers must contain every supported controller in this order: ${supportedAgents.join(", ")}`,
    );
  }
  validateAgent(profile.defaultController);
  return {
    $schema: profile.$schema,
    version: profile.version,
    enabledControllers: [...profile.enabledControllers],
    defaultController: profile.defaultController,
  };
}

export function readAgentProfile(root = process.cwd()) {
  assertProfilePathSafe(root);
  const path = profilePath(root);
  if (!existsSync(path)) fail(`${profileRelativePath} is missing`);
  if (lstatSync(path).isSymbolicLink()) {
    fail(`refusing symlinked agent profile: ${path}`);
  }
  let profile;
  try {
    profile = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`invalid agent profile JSON: ${error.message}`);
  }
  return normalizeProfile(profile);
}

export function skillDirectoryForAgent(agent) {
  return agentDefinitions[validateAgent(agent)].skillDirectory;
}

export function assertAgentEnabled(expected, root = process.cwd()) {
  validateAgent(expected);
  const profile = readAgentProfile(root);
  if (!profile.enabledControllers.includes(expected)) {
    fail(
      `${agentDefinitions[expected].label} is not enabled in this repository`,
    );
  }
  return expected;
}

// Kept for installed adapters created by earlier Parallel Slices releases. Selection is
// now per run; this compatibility name verifies that the controller is enabled.
export const assertSelectedAgent = assertAgentEnabled;

function writeProfile(root, defaultController) {
  assertProfilePathSafe(root);
  const path = profilePath(root);
  mkdirSync(dirname(path), { recursive: true });
  const incoming = `${path}.incoming-${process.pid}`;
  if (existsSync(incoming)) fail(`stale agent profile exists: ${incoming}`);
  const profile = {
    $schema: "./agent.schema.json",
    version: 2,
    enabledControllers: [...supportedAgents],
    defaultController,
  };
  writeFileSync(incoming, `${JSON.stringify(profile, null, 2)}\n`);
  renameSync(incoming, path);
}

export function configureAgent(root, agent) {
  validateAgent(agent);
  assertProfilePathSafe(root);
  const path = profilePath(root);
  if (existsSync(path)) {
    const current = readAgentProfile(root);
    if (!current.migratedFromVersion && current.defaultController === agent) {
      return false;
    }
  }
  writeProfile(root, agent);
  return true;
}

function parseRoot(value) {
  const root = value || process.cwd();
  if (!isAbsolute(root)) fail("target must be an absolute path");
  return resolve(root);
}

function runCli(argv) {
  const [command, agent, target] = argv;
  if (command === "show" && argv.length <= 2) {
    console.log(readAgentProfile(parseRoot(agent)).defaultController);
    return;
  }
  if (command === "list" && argv.length <= 2) {
    for (const enabled of readAgentProfile(parseRoot(agent))
      .enabledControllers) {
      console.log(enabled);
    }
    return;
  }
  if (
    ["require", "require-enabled"].includes(command) &&
    agent &&
    argv.length <= 3
  ) {
    assertAgentEnabled(agent, parseRoot(target));
    console.log(`enabled controller: ${agent}`);
    return;
  }
  if (command === "configure" && agent && target && argv.length === 3) {
    const changed = configureAgent(parseRoot(target), agent);
    console.log(
      `${changed ? "configured" : "current"} default controller: ${agent}`,
    );
    return;
  }
  fail(
    "usage: agent-profile.mjs show|list [absolute-target] | " +
      "require-enabled <agent> [absolute-target] | " +
      "configure <agent> <absolute-target>",
  );
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`AGENT PROFILE FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
