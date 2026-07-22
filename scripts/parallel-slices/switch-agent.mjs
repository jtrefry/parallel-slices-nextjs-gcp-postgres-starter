#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  agentDefinitions,
  configureAgent,
  readAgentProfile,
  validateAgent,
} from "./agent-profile.mjs";
import { initializeCommandForController } from "./architecture-profile.mjs";
import { installCuratedSkills } from "./install-curated-skills.mjs";
import { assertBranchAllowed, loadQualityConfig } from "./project-quality.mjs";

function fail(message) {
  throw new Error(message);
}

function git(args, root) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    fail(error.stderr?.toString().trim() || `git ${args[0]} failed`);
  }
}

function assertSwitchPreflight(root) {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    fail(`target repository does not exist: ${root}`);
  }
  const topLevel = git(["rev-parse", "--show-toplevel"], root);
  if (realpathSync(resolve(topLevel)) !== realpathSync(root)) {
    fail("target must be the Git repository root");
  }
  const branch = git(["branch", "--show-current"], root);
  assertBranchAllowed(branch, loadQualityConfig(root));
  if (git(["status", "--porcelain=v1"], root)) {
    fail("default-controller changes require a clean working tree");
  }
}

export function switchAgent(root, agent, options = {}) {
  const targetRoot = resolve(root);
  validateAgent(agent);
  assertSwitchPreflight(targetRoot);
  const current = readAgentProfile(targetRoot).defaultController;
  if (current === agent) {
    console.log(`current default controller: ${agent}`);
    return false;
  }
  const installSkills = options.installCuratedSkills || installCuratedSkills;
  installSkills({ target: targetRoot, agent });
  configureAgent(targetRoot, agent);
  const definition = agentDefinitions[agent];
  console.log(`default controller: ${definition.label}`);
  console.log(`initialize: ${initializeCommandForController(agent, root)}`);
  console.log(`prepare continuation: ${definition.prepareCommand}`);
  console.log("all native controllers remain enabled");
  console.log("review and commit the default-controller change before use");
  return true;
}

function runCli(argv) {
  const [agent, target = process.cwd()] = argv;
  if (!agent || argv.length > 2) {
    fail(
      "usage: switch-agent.mjs <cursor|codex|claude-code> [absolute-target]",
    );
  }
  if (!isAbsolute(target)) fail("target must be an absolute path");
  switchAgent(target, agent);
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`AGENT SWITCH FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
