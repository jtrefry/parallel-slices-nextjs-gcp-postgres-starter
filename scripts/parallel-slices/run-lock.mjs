#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertAgentEnabled } from "./agent-profile.mjs";
import { readRunState } from "./run-state.mjs";
import {
  ensureRunTracking,
  listActiveWorkerMetadata,
} from "./run-tracking.mjs";

const terminalStatuses = new Set([
  "pull_request_ready",
  "blocked",
  "failed",
  "finished",
]);

function fail(message) {
  throw new Error(message);
}

function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    fail(error.stderr?.toString().trim() || `git ${args.join(" ")} failed`);
  }
}

function repositoryRoot() {
  return git(process.cwd(), ["rev-parse", "--show-toplevel"]);
}

function lockPath(root) {
  return resolve(root, ".parallel-slices/runtime/run.lock.json");
}

function expectedLock(root, controller, statePath) {
  assertAgentEnabled(controller, root);
  const state = readRunState(root, statePath);
  if (state.controller !== controller) {
    fail(
      `run state assigns ${state.controller}; ${controller} cannot own this run`,
    );
  }
  const branch = git(root, ["branch", "--show-current"]);
  if (branch !== state.goalBranch) {
    fail(
      `run state requires branch ${state.goalBranch}; current branch is ${branch}`,
    );
  }
  return {
    version: 1,
    controller,
    state: statePath,
    runId: state.runId,
    branch,
  };
}

function readLock(path) {
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink())
    fail(`refusing symlinked run lock: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`invalid run lock ${path}: ${error.message}`);
  }
}

function sameLock(left, right) {
  return ["version", "controller", "state", "runId", "branch"].every(
    (key) => left?.[key] === right[key],
  );
}

export function acquireRunLock(root, controller, statePath) {
  const expected = expectedLock(root, controller, statePath);
  ensureRunTracking(root, statePath);
  const path = lockPath(root);
  mkdirSync(resolve(root, ".parallel-slices/runtime"), { recursive: true });
  const existing = readLock(path);
  if (existing) {
    if (!sameLock(existing, expected)) {
      fail(
        `run is already owned by ${existing.controller || "an unknown controller"}; inspect ${path}`,
      );
    }
    return { path, lock: existing, created: false };
  }
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(expected, null, 2)}\n`);
  } catch (error) {
    if (error.code === "EEXIST") {
      fail(`another controller acquired the run lock: ${path}`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return { path, lock: expected, created: true };
}

export function assertRunLock(root, controller, statePath) {
  const expected = expectedLock(root, controller, statePath);
  const path = lockPath(root);
  const existing = readLock(path);
  if (!existing)
    fail(`run lock is missing; acquire it before spawning workers`);
  if (!sameLock(existing, expected))
    fail(`run lock does not match this controller and state`);
  return { path, lock: existing };
}

export function releaseRunLock(root, controller, statePath, options = {}) {
  const { path, lock } = assertRunLock(root, controller, statePath);
  const state = readRunState(root, statePath);
  const workers = listActiveWorkerMetadata(root, statePath);
  if (workers.length) {
    fail(
      `cannot release run lock with active worker metadata: ${workers[0].workerId}`,
    );
  }
  if (git(root, ["status", "--porcelain=v1"])) {
    fail("run-lock release requires a clean working tree");
  }
  if (!options.handoff && !terminalStatuses.has(state.status)) {
    fail("run is not terminal; use --handoff only at a clean slice boundary");
  }
  if (
    options.handoff &&
    Object.values(state.slices).some((slice) => slice.status === "in_progress")
  ) {
    fail("controller handoff requires no in-progress slice");
  }
  unlinkSync(path);
  return lock;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { handoff: false };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--handoff") {
      options.handoff = true;
      continue;
    }
    if (!["--controller", "--state"].includes(flag))
      fail(`unknown argument: ${flag}`);
    const value = rest[index + 1];
    if (!value) fail(`${flag} requires a value`);
    options[flag.slice(2)] = value;
    index += 1;
  }
  if (!options.controller || !options.state) {
    fail("--controller and --state are required");
  }
  if (!["acquire", "status", "release"].includes(command)) {
    fail(
      "usage: run-lock.mjs acquire|status|release --controller <id> --state <path> [--handoff]",
    );
  }
  return { command, ...options };
}

function runCli(argv) {
  const options = parseArgs(argv);
  const root = repositoryRoot();
  if (options.command === "acquire") {
    const result = acquireRunLock(root, options.controller, options.state);
    console.log(
      `${result.created ? "acquired" : "current"} run lock: ${result.path}`,
    );
  } else if (options.command === "status") {
    const result = assertRunLock(root, options.controller, options.state);
    console.log(`run lock valid: ${result.path}`);
  } else {
    releaseRunLock(root, options.controller, options.state, {
      handoff: options.handoff,
    });
    console.log("run lock released");
  }
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`RUN LOCK FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
