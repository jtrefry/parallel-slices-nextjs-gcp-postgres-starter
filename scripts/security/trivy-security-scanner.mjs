#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  throw new Error(message);
}

export function parseTrivyVersion(output) {
  const match = /(?:Trivy\s+)?Version:\s*v?(\d+\.\d+\.\d+)/i.exec(output);
  return match?.[1] || null;
}

function runCommand(command, args, root, stdio) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    stdio,
  });
}

export function runTrivy(options = {}) {
  const root = resolve(options.root || process.cwd());
  const command = options.command || "trivy";
  const versionPath = resolve(root, ".trivy-version");
  const configPath = resolve(root, "trivy.yaml");
  if (!existsSync(versionPath)) fail(".trivy-version is missing");
  if (!existsSync(configPath)) fail("trivy.yaml is missing");
  const expected = readFileSync(versionPath, "utf8").trim();
  if (!/^\d+\.\d+\.\d+$/.test(expected)) fail("invalid .trivy-version");

  const version = runCommand(command, ["--version"], root, [
    "ignore",
    "pipe",
    "pipe",
  ]);
  if (version.error?.code === "ENOENT") {
    fail(
      `Trivy ${expected} is required. Install that exact version and retry.`,
    );
  }
  if (version.error) fail(`Trivy could not start: ${version.error.message}`);
  if (version.status !== 0) fail("Trivy failed to report its version");
  const actual = parseTrivyVersion(`${version.stdout}\n${version.stderr}`);
  if (actual !== expected) {
    fail(`Trivy ${expected} is required, but ${actual || "unknown"} is active`);
  }

  const result = runCommand(
    command,
    ["--config", "trivy.yaml", "fs", "."],
    root,
    "inherit",
  );
  if (result.error) fail(`Trivy scan could not start: ${result.error.message}`);
  if (result.signal) fail(`Trivy scan was terminated by ${result.signal}`);
  if (result.status !== 0) {
    fail(
      `Trivy found blocking findings or failed with exit code ${result.status}`,
    );
  }
  console.log(`Trivy ${actual} repository scan passed`);
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    runTrivy();
  } catch (error) {
    console.error(`TRIVY SCAN FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
