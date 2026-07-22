#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const profileRelativePath = ".parallel-slices/repository.json";
const accountPattern = /^[A-Za-z0-9-]+$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const refPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/;
const remotePattern = /^[A-Za-z0-9._-]+$/;
const visibilities = new Set(["private", "public", "internal"]);

function fail(message) {
  throw new Error(message);
}

function assertProfilePathSafe(root) {
  const path = resolve(root, profileRelativePath);
  const directory = dirname(path);
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) {
    fail(`refusing symlinked repository profile directory: ${directory}`);
  }
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    fail(`refusing symlinked repository profile: ${path}`);
  }
  return path;
}

export function validateRepositoryProfile(profile) {
  const allowedKeys = new Set([
    "$schema",
    "version",
    "mode",
    "remote",
    "baseBranch",
    "repository",
    "account",
    "visibility",
    "createIfMissing",
  ]);
  for (const key of Object.keys(profile || {})) {
    if (!allowedKeys.has(key)) fail(`unknown repository profile key: ${key}`);
  }
  if (!profile || profile.$schema !== "./repository.schema.json") {
    fail("repository profile must reference ./repository.schema.json");
  }
  if (profile.version !== 1) fail("invalid repository profile version");
  if (!remotePattern.test(profile.remote || "")) {
    fail("repository profile remote is invalid");
  }
  if (!refPattern.test(profile.baseBranch || "")) {
    fail("repository profile baseBranch is invalid");
  }
  if (profile.mode === "local-only") {
    for (const key of [
      "repository",
      "account",
      "visibility",
      "createIfMissing",
    ]) {
      if (key in profile) fail(`local-only repository profile forbids ${key}`);
    }
    return profile;
  }
  if (profile.mode !== "github") fail("repository profile mode is invalid");
  if (!repositoryPattern.test(profile.repository || "")) {
    fail("GitHub repository must use OWNER/NAME");
  }
  if (!accountPattern.test(profile.account || "")) {
    fail("GitHub account must be an explicit username");
  }
  if (!visibilities.has(profile.visibility)) {
    fail("GitHub visibility must be private, public, or internal");
  }
  if (typeof profile.createIfMissing !== "boolean") {
    fail("GitHub createIfMissing must be boolean");
  }
  return profile;
}

export function readRepositoryProfile(root = process.cwd()) {
  const path = assertProfilePathSafe(root);
  if (!existsSync(path)) fail(`${profileRelativePath} is missing`);
  return validateRepositoryProfile(JSON.parse(readFileSync(path, "utf8")));
}

function parseRoot(value) {
  const root = value || process.cwd();
  if (!isAbsolute(root)) fail("target must be an absolute path");
  return resolve(root);
}

function runCli(argv) {
  const [command, target] = argv;
  if (command === "verify" && argv.length <= 2) {
    const profile = readRepositoryProfile(parseRoot(target));
    console.log(`repository publication mode: ${profile.mode}`);
    return;
  }
  fail("usage: repository-profile.mjs verify [absolute-target]");
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`REPOSITORY PROFILE FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
