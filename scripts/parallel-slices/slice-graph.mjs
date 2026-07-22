#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadQualityConfig } from "./project-quality.mjs";
import { readRunState } from "./run-state.mjs";
import {
  assertSafeRelativePath,
  parseManifestText,
  patternsMayOverlap,
  validateManifest,
} from "./scope-policy.mjs";

function fail(message) {
  throw new Error(message);
}

function dependencies(manifest) {
  return manifest.depends_on === "none" ? [] : manifest.depends_on.split(",");
}

function collectScopeFiles(directory, root, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) collectScopeFiles(absolute, root, files);
    else if (
      entry.isFile() &&
      entry.name.endsWith(".scope") &&
      !basename(entry.name).startsWith("_")
    ) {
      files.push(absolute.slice(root.length + 1).replaceAll("\\", "/"));
    }
  }
  return files;
}

export function loadPlanManifests(root, planPath) {
  assertSafeRelativePath(planPath, "plan");
  const scopeRoot = resolve(root, "docs/plans/scopes");
  if (!existsSync(scopeRoot)) fail("docs/plans/scopes does not exist");
  const config = loadQualityConfig(root);
  const manifests = [];
  for (const path of collectScopeFiles(scopeRoot, root).sort()) {
    const manifest = parseManifestText(
      readFileSync(resolve(root, path), "utf8"),
    );
    if (manifest.plan !== planPath) continue;
    validateManifest(manifest, path, root, config);
    if (manifest.version !== "2") {
      fail(`parallel slice graph requires version 2 manifest: ${path}`);
    }
    manifests.push({ ...manifest, path });
  }
  if (!manifests.length) fail(`plan has no version 2 manifests: ${planPath}`);
  return validateSliceGraph(resolveActiveManifestRevisions(manifests));
}

export function resolveActiveManifestRevisions(manifests) {
  const byPath = new Map(
    manifests.map((manifest) => [manifest.path, manifest]),
  );
  const successorByPath = new Map();
  for (const manifest of manifests) {
    const revision = Number(manifest.revision ?? "1");
    if (revision === 1) continue;
    const predecessor = byPath.get(manifest.supersedes);
    if (!predecessor) {
      fail(
        `scope manifest ${manifest.path} supersedes an unavailable manifest: ${manifest.supersedes}`,
      );
    }
    if (
      predecessor.plan !== manifest.plan ||
      predecessor.state !== manifest.state ||
      predecessor.slice !== manifest.slice
    ) {
      fail(
        `scope manifest revision changes plan, state, or slice: ${manifest.path}`,
      );
    }
    const predecessorRevision = Number(predecessor.revision ?? "1");
    if (revision !== predecessorRevision + 1) {
      fail(`scope manifest revision is not consecutive: ${manifest.path}`);
    }
    if (successorByPath.has(predecessor.path)) {
      fail(
        `scope manifest has multiple correction successors: ${predecessor.path}`,
      );
    }
    successorByPath.set(predecessor.path, manifest.path);
  }
  const active = manifests.filter(
    (manifest) => !successorByPath.has(manifest.path),
  );
  const activeSlices = new Set();
  for (const manifest of active) {
    if (activeSlices.has(manifest.slice)) {
      fail(`slice has multiple active manifest revisions: ${manifest.slice}`);
    }
    activeSlices.add(manifest.slice);
  }
  return active;
}

export function validateSliceGraph(manifests) {
  const byId = new Map();
  for (const manifest of manifests) {
    if (byId.has(manifest.slice)) {
      fail(`duplicate slice ID in execution graph: ${manifest.slice}`);
    }
    byId.set(manifest.slice, manifest);
  }
  for (const manifest of manifests) {
    for (const dependency of dependencies(manifest)) {
      if (dependency === manifest.slice) {
        fail(`slice ${manifest.slice} cannot depend on itself`);
      }
      if (!byId.has(dependency)) {
        fail(`slice ${manifest.slice} has unknown dependency: ${dependency}`);
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(slice) {
    if (visiting.has(slice)) fail(`slice dependency cycle includes ${slice}`);
    if (visited.has(slice)) return;
    visiting.add(slice);
    for (const dependency of dependencies(byId.get(slice))) visit(dependency);
    visiting.delete(slice);
    visited.add(slice);
  }
  for (const slice of byId.keys()) visit(slice);
  return [...manifests].sort((left, right) =>
    left.slice.localeCompare(right.slice, "en", { numeric: true }),
  );
}

export function manifestsConflict(left, right) {
  if (left.parallel === "forbidden" || right.parallel === "forbidden") {
    return true;
  }
  if (left.lock.some((lock) => right.lock.includes(lock))) return true;
  return left.allow.some((leftPattern) =>
    right.allow.some((rightPattern) =>
      patternsMayOverlap(leftPattern, rightPattern),
    ),
  );
}

export function computeExecutionSets(manifests) {
  const ordered = validateSliceGraph(manifests);
  const remaining = new Map(
    ordered.map((manifest) => [manifest.slice, manifest]),
  );
  const completed = new Set();
  const executionSets = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter((manifest) =>
      dependencies(manifest).every((dependency) => completed.has(dependency)),
    );
    if (!ready.length) fail("slice graph has no schedulable node");
    const readySet = [];
    for (const candidate of ready) {
      if (
        readySet.every((selected) => !manifestsConflict(candidate, selected))
      ) {
        readySet.push(candidate);
      }
    }
    if (!readySet.length) readySet.push(ready[0]);
    executionSets.push(readySet.map((manifest) => manifest.slice));
    for (const manifest of readySet) {
      completed.add(manifest.slice);
      remaining.delete(manifest.slice);
    }
  }
  return executionSets;
}

export function computeReadySlices(manifests, state) {
  const ordered = validateSliceGraph(manifests);
  if (state.plan !== ordered[0].plan) {
    fail(`run state plan does not match execution graph: ${state.plan}`);
  }
  const manifestIds = new Set(ordered.map((manifest) => manifest.slice));
  const stateIds = Object.keys(state.slices);
  for (const manifest of ordered) {
    const sliceState = state.slices[manifest.slice];
    if (!sliceState) fail(`run state is missing slice ${manifest.slice}`);
    if (sliceState.manifest !== manifest.path) {
      fail(`run state manifest mismatch for slice ${manifest.slice}`);
    }
    if (sliceState.reviewArtifact !== manifest.review) {
      fail(`run state review artifact mismatch for slice ${manifest.slice}`);
    }
  }
  for (const slice of stateIds) {
    if (!manifestIds.has(slice)) fail(`run state has unknown slice ${slice}`);
  }
  const accepted = new Set(
    stateIds.filter((slice) => state.slices[slice].status === "accepted"),
  );
  const eligible = ordered.filter(
    (manifest) =>
      ["not_started", "in_progress"].includes(
        state.slices[manifest.slice].status,
      ) &&
      dependencies(manifest).every((dependency) => accepted.has(dependency)),
  );
  const ready = [];
  for (const candidate of eligible) {
    if (ready.every((selected) => !manifestsConflict(candidate, selected))) {
      ready.push(candidate);
    }
  }
  return ready;
}

function repositoryRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    fail(error.stderr?.toString().trim() || "not inside a Git repository");
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!["--plan", "--state"].includes(flag))
      fail(`unknown argument: ${flag}`);
    const value = rest[index + 1];
    if (!value) fail(`${flag} requires a value`);
    options[flag.slice(2)] = value;
    index += 1;
  }
  if (!["validate", "sets", "ready"].includes(command) || !options.plan) {
    fail(
      "usage: slice-graph.mjs validate|sets --plan <plan> | ready --plan <plan> --state <state>",
    );
  }
  if (command === "ready" && !options.state) fail("ready requires --state");
  return { command, ...options };
}

function runCli(argv) {
  const options = parseArgs(argv);
  const root = repositoryRoot();
  const manifests = loadPlanManifests(root, options.plan);
  if (options.command === "validate") {
    console.log(`slice graph valid: ${manifests.length} slices`);
  } else if (options.command === "sets") {
    console.log(JSON.stringify(computeExecutionSets(manifests)));
  } else {
    const state = readRunState(root, options.state);
    console.log(
      JSON.stringify(
        computeReadySlices(manifests, state).map((manifest) => ({
          slice: manifest.slice,
          scopeFile: manifest.path,
        })),
      ),
    );
  }
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`SLICE GRAPH FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
