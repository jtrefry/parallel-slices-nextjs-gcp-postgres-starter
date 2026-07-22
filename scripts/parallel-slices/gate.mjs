#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertBranchAllowed,
  loadQualityConfig,
  resolvePipeline,
  runPipeline,
} from "./project-quality.mjs";
import {
  beginPipelineTracking,
  finishPipelineTracking,
  primaryRepositoryRoot,
  readSliceAttemptTracking,
  updatePipelineStepTracking,
  updateWorkerTracking,
} from "./run-tracking.mjs";
import { assertNoPotentialSecrets } from "./content-safety.mjs";
import {
  assertSafeRelativePath,
  globToRegExp,
  parseManifestText,
  pathMatches,
  requireCommittedContract,
  requireTrackedPaths,
  validateManifest,
  validateReleaseNotes,
  validateScopeCoverage,
  workingChangedFiles,
} from "./scope-policy.mjs";

function fail(message) {
  throw new Error(message);
}

function git(args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail = error.stderr?.toString().trim();
    fail(detail || `git ${args.join(" ")} failed`);
  }
}

function parseArgs(argv) {
  const options = { base: "HEAD", integrated: false, scopeCheckOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scope-check-only") options.scopeCheckOnly = true;
    else if (arg === "--integrated") options.integrated = true;
    else if (
      arg === "--base" ||
      arg === "--scope-file" ||
      arg === "--worker-id"
    ) {
      const value = argv[index + 1];
      if (!value) fail(`${arg} requires a value`);
      options[
        arg === "--base"
          ? "base"
          : arg === "--worker-id"
            ? "workerId"
            : "scopeFile"
      ] = value;
      index += 1;
    } else fail(`unknown argument: ${arg}`);
  }
  if (!options.scopeFile) fail("--scope-file is required");
  return options;
}

export { globToRegExp, parseManifestText, pathMatches, validateScopeCoverage };

export function runGate(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const root = git(["rev-parse", "--show-toplevel"], { cwd: process.cwd() });
  const scopeFile = options.scopeFile.replace(/^\.\//, "");
  assertSafeRelativePath(scopeFile, "scope manifest");
  if (!/^docs\/plans\/scopes\/.+\.scope$/.test(scopeFile)) {
    fail("scope manifest must be under docs/plans/scopes and end in .scope");
  }
  const scopePath = resolve(root, scopeFile);
  if (!existsSync(scopePath)) {
    fail(`scope manifest does not exist: ${scopeFile}`);
  }

  const config = loadQualityConfig(root);
  const manifest = parseManifestText(readFileSync(scopePath, "utf8"));
  validateManifest(manifest, scopeFile, root, config);
  requireCommittedContract(root, [manifest.plan, scopeFile]);
  if (manifest.version === "2") requireTrackedPaths(root, [manifest.state]);

  let trackingRoot;
  if (options.workerId) {
    trackingRoot = primaryRepositoryRoot(root);
    const tracking = readSliceAttemptTracking(trackingRoot, options.workerId);
    if (
      tracking.worker.slice !== manifest.slice ||
      tracking.worker.scopeFile !== scopeFile
    ) {
      fail("worker tracking does not match the requested scope manifest");
    }
    const expectedRoot = options.integrated
      ? trackingRoot
      : realpathSync(tracking.worker.worktree);
    if (realpathSync(root) !== expectedRoot) {
      fail(
        `${options.integrated ? "integrated" : "worker"} gate is running in the wrong worktree`,
      );
    }
    if (
      options.integrated &&
      !options.scopeCheckOnly &&
      ![
        "candidate_applied",
        "pipeline_running",
        "pipeline_failed",
        "pipeline_passed",
      ].includes(tracking.integration.phase)
    ) {
      fail("integrated gate requires an applied tracked candidate");
    }
    if (
      !options.integrated &&
      !options.scopeCheckOnly &&
      ![
        "preflight_passed",
        "implementing",
        "pipeline_running",
        "pipeline_failed",
        "pipeline_passed",
      ].includes(tracking.worker.phase)
    ) {
      fail("worker gate requires a passed scope preflight");
    }
  }
  const branch = git(["branch", "--show-current"], { cwd: root });
  if (branch) {
    assertBranchAllowed(branch, config);
  } else if (options.workerId && !options.integrated) {
    const goalBranch = git(["branch", "--show-current"], {
      cwd: trackingRoot,
    });
    assertBranchAllowed(goalBranch, loadQualityConfig(trackingRoot));
  } else {
    assertBranchAllowed(branch, config);
  }

  const changed = workingChangedFiles(root, options.base);
  const permitted = options.integrated
    ? [...manifest.allow, ...manifest.coordinate]
    : manifest.allow;
  const outside = changed.filter((path) => !pathMatches(path, permitted));
  if (outside.length) {
    fail(
      `changed paths outside slice ${manifest.slice}:\n${outside.map((path) => `  ${path}`).join("\n")}`,
    );
  }
  console.log(
    `scope passed: slice ${manifest.slice} (${manifest.requirements})`,
  );
  if (options.scopeCheckOnly) {
    if (options.workerId && !options.integrated) {
      const tracking = readSliceAttemptTracking(trackingRoot, options.workerId);
      if (["claimed", "worktree_ready"].includes(tracking.worker.phase)) {
        updateWorkerTracking(
          trackingRoot,
          options.workerId,
          "preflight_passed",
        );
      }
    }
    return;
  }

  validateReleaseNotes(root, manifest.release_notes, changed);
  assertNoPotentialSecrets(root, changed, "changed file");
  if (!options.workerId) {
    runPipeline(root, config, manifest.gate);
  } else {
    const steps = resolvePipeline(config, manifest.gate);
    beginPipelineTracking(trackingRoot, options.workerId, {
      integrated: options.integrated,
      pipeline: manifest.gate,
      steps,
    });
    try {
      runPipeline(root, config, manifest.gate, {
        onStepStart: (step) =>
          updatePipelineStepTracking(trackingRoot, options.workerId, {
            integrated: options.integrated,
            step: step.id,
            status: "running",
          }),
        onStepPassed: (step) =>
          updatePipelineStepTracking(trackingRoot, options.workerId, {
            integrated: options.integrated,
            step: step.id,
            status: "passed",
          }),
        onStepFailed: (step, error) =>
          updatePipelineStepTracking(trackingRoot, options.workerId, {
            integrated: options.integrated,
            step: step.id,
            status: "failed",
            error: error.message.slice(0, 500),
          }),
      });
      finishPipelineTracking(trackingRoot, options.workerId, {
        integrated: options.integrated,
        passed: true,
      });
    } catch (error) {
      finishPipelineTracking(trackingRoot, options.workerId, {
        integrated: options.integrated,
        passed: false,
        error: error.message.slice(0, 500),
      });
      throw error;
    }
  }
  console.log(`\nPARALLEL SLICES GATE GREEN: slice ${manifest.slice}`);
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    runGate();
  } catch (error) {
    console.error(`PARALLEL SLICES GATE RED: ${error.message}`);
    process.exitCode = 1;
  }
}
