#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const supportedManagers = new Set(["pnpm", "yarn"]);

function fail(message) {
  throw new Error(message);
}

function assertCommandSucceeded(result, label) {
  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  if (result.signal) fail(`${label} was terminated by ${result.signal}`);
  if (result.status !== 0) {
    fail(`${label} failed with exit code ${result.status}`);
  }
}

export function corepackExecutable(platform = process.platform) {
  return platform === "win32" ? "corepack.cmd" : "corepack";
}

export function spawnCorepack(
  execute,
  args,
  options,
  platform = process.platform,
  environment = process.env,
) {
  const executable = corepackExecutable(platform);
  if (platform === "win32") {
    return execute(
      environment.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", executable, ...args],
      options,
    );
  }
  return execute(executable, args, options);
}

export function runWithCorepackShim(manager, args, options = {}) {
  if (!supportedManagers.has(manager)) {
    fail("Corepack manager must be pnpm or yarn");
  }
  if (!Array.isArray(args) || args.length === 0) {
    fail("a package-manager command is required");
  }
  const execute = options.runCommand || spawnSync;
  const environment = options.environment || process.env;
  const platform = options.platform || process.platform;
  const cwd = options.cwd || process.cwd();
  const shimDirectory = mkdtempSync(
    join(options.temporaryDirectory || tmpdir(), "parallel-slices-corepack-"),
  );
  const commandOptions = {
    cwd,
    env: environment,
    stdio: options.stdio || "inherit",
  };

  try {
    const enabled = spawnCorepack(
      execute,
      ["enable", manager, "--install-directory", shimDirectory],
      commandOptions,
      platform,
      environment,
    );
    assertCommandSucceeded(enabled, "Corepack shim setup");
    const path = environment.PATH
      ? `${shimDirectory}${delimiter}${environment.PATH}`
      : shimDirectory;
    const result = spawnCorepack(
      execute,
      [manager, ...args],
      {
        ...commandOptions,
        env: { ...environment, PATH: path },
      },
      platform,
      environment,
    );
    assertCommandSucceeded(result, `${manager} command`);
    return result.status;
  } finally {
    rmSync(shimDirectory, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    const [manager, ...args] = process.argv.slice(2);
    runWithCorepackShim(manager, args);
  } catch (error) {
    console.error(`PACKAGE MANAGER RUNNER FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
