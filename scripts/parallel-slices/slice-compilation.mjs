#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readArchitectureProfile } from "./architecture-profile.mjs";
import {
  loadQualityConfig,
  resolveSliceCompilation,
} from "./project-quality.mjs";

const configRelativePath = ".parallel-slices/config.json";

function fail(message) {
  throw new Error(message);
}

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function readSliceCompilationSnapshot(root = process.cwd()) {
  const configPath = resolve(root, configRelativePath);
  if (!existsSync(configPath)) fail(`${configRelativePath} is missing`);
  if (lstatSync(configPath).isSymbolicLink()) {
    fail(`refusing symlinked slice-compilation configuration: ${configPath}`);
  }
  const configContent = readFileSync(configPath, "utf8");
  const config = loadQualityConfig(root);
  const architecture = readArchitectureProfile(root);
  return {
    sizingStrategy: resolveSliceCompilation(config).sizingStrategy,
    configSha256: sha256(configContent),
    architectureManifestSha256: architecture.manifestSha256,
  };
}

function parseRoot(value) {
  const root = value || process.cwd();
  if (!isAbsolute(root)) fail("target must be an absolute path");
  return resolve(root);
}

function runCli(argv) {
  const [command, target] = argv;
  if (command === "snapshot" && argv.length <= 2) {
    console.log(
      JSON.stringify(readSliceCompilationSnapshot(parseRoot(target)), null, 2),
    );
    return;
  }
  fail("usage: slice-compilation.mjs snapshot [absolute-target]");
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`SLICE COMPILATION FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
