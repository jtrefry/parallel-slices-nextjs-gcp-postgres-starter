#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readRunState } from "./run-state.mjs";
import { listRunAttempts } from "./run-tracking.mjs";
import { loadPlanManifests } from "./slice-graph.mjs";
import {
  assertSafeRelativePath,
  pathMatches,
  workingChangedFiles,
} from "./scope-policy.mjs";

const terminalRunStatuses = new Set([
  "pull_request_ready",
  "blocked",
  "failed",
  "finished",
]);

const workerProgress = Object.freeze({
  claimed: 2,
  worktree_ready: 5,
  preflight_passed: 10,
  implementing: 25,
  pipeline_running: 35,
  pipeline_failed: 35,
  pipeline_passed: 55,
  candidate_ready: 60,
  blocked: 25,
  failed: 25,
  interrupted: 25,
});

const integrationProgress = Object.freeze({
  waiting_for_candidate: 0,
  candidate_verified: 65,
  integration_claimed: 68,
  candidate_applied: 70,
  pipeline_running: 75,
  pipeline_failed: 75,
  pipeline_passed: 88,
  review_running: 92,
  review_failed: 92,
  review_approved: 96,
  retry_requested: 60,
  accepted: 100,
  cleanup_completed: 100,
  interrupted: 75,
});

function fail(message) {
  throw new Error(message);
}

function git(root, args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (options.allowFailure) return null;
    fail(error.stderr?.toString().trim() || `git ${args.join(" ")} failed`);
  }
}

function repositoryRoot() {
  return realpathSync(git(process.cwd(), ["rev-parse", "--show-toplevel"]));
}

function readJson(path, label) {
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    fail(`refusing unsafe ${label}: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`invalid ${label}: ${error.message}`);
  }
}

function discoverStatePath(root, requested) {
  if (requested) {
    assertSafeRelativePath(requested, "run state path");
    readRunState(root, requested);
    return requested;
  }
  const lock = readJson(
    resolve(root, ".parallel-slices/runtime/run.lock.json"),
    "run lock",
  );
  if (lock?.state) {
    assertSafeRelativePath(lock.state, "run lock state path");
    readRunState(root, lock.state);
    return lock.state;
  }
  const directory = resolve(root, "docs/plans/loop-runs");
  if (!existsSync(directory)) {
    fail("no run state exists under docs/plans/loop-runs");
  }
  if (
    !lstatSync(directory).isDirectory() ||
    lstatSync(directory).isSymbolicLink()
  ) {
    fail("refusing unsafe run-state directory: docs/plans/loop-runs");
  }
  const candidates = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => `docs/plans/loop-runs/${name}`)
    .map((path) => ({ path, state: readRunState(root, path) }));
  const active = candidates.filter(
    ({ state }) => !terminalRunStatuses.has(state.status),
  );
  if (active.length === 1) return active[0].path;
  if (active.length > 1) {
    fail(
      `multiple active run states exist; pass --state with one of: ${active.map(({ path }) => path).join(", ")}`,
    );
  }
  if (candidates.length === 1) return candidates[0].path;
  fail("no unique run state could be inferred; pass --state <path>");
}

function latestPipeline(tracking) {
  return tracking?.pipelines?.at(-1) ?? null;
}

function pipelineProgress(base, ceiling, pipeline) {
  if (!pipeline?.totalSteps) return base;
  const completed = Math.min(pipeline.completedSteps, pipeline.totalSteps);
  return Math.round(
    base + ((ceiling - base) * completed) / pipeline.totalSteps,
  );
}

function attemptProgress(attempt) {
  const worker = attempt.worker;
  const integration = attempt.integration;
  let progress = workerProgress[worker.phase] ?? 0;
  if (
    worker.phase === "pipeline_running" ||
    worker.phase === "pipeline_failed"
  ) {
    progress = pipelineProgress(25, 55, latestPipeline(worker));
  }
  const integrationBase = integrationProgress[integration.phase] ?? 0;
  if (
    integration.phase === "pipeline_running" ||
    integration.phase === "pipeline_failed"
  ) {
    return Math.max(
      progress,
      pipelineProgress(70, 88, latestPipeline(integration)),
    );
  }
  return Math.max(progress, integrationBase);
}

function bar(progress, width = 20) {
  const bounded = Math.max(0, Math.min(100, progress));
  const filled = Math.round((bounded / 100) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function readReviewStatus(root, path) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) return null;
  const ledger = readJson(absolute, `review artifact ${path}`);
  return ledger?.attempts?.at(-1)?.status ?? null;
}

function worktreeCondition(attempt) {
  if (!existsSync(attempt.worker.worktree)) return "missing";
  const changed = git(attempt.worker.worktree, ["status", "--porcelain=v1"], {
    allowFailure: true,
  });
  if (changed === null) return "unreadable";
  return changed ? "dirty" : "clean";
}

function runtimeRecoveryWarnings(root, runId) {
  const runDirectory = resolve(root, `.parallel-slices/runtime/runs/${runId}`);
  if (!existsSync(runDirectory)) return [];
  const warnings = [];
  const pending = [runDirectory];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const display = relative(root, path);
      if (entry.isSymbolicLink()) {
        fail(`refusing symlink in runtime tracking: ${display}`);
      }
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.name.endsWith(".lock")) {
        let owner;
        try {
          const value = JSON.parse(readFileSync(path, "utf8"));
          owner = `pid ${value.pid ?? "unknown"}, started ${value.startedAt ?? "unknown"}`;
        } catch {
          owner = "owner metadata is unreadable";
        }
        warnings.push(
          `tracking update lock exists at ${display} (${owner}); verify the process stopped before clearing it`,
        );
      } else if (entry.name.includes(".incoming-")) {
        warnings.push(
          `incomplete atomic-write staging file exists at ${display}; preserve it while reconciling its destination`,
        );
      }
    }
  }
  return warnings;
}

function recoveryNote(attempt, condition) {
  const worker = attempt.worker;
  const integration = attempt.integration;
  if (["cleanup_completed", "retry_requested"].includes(integration.phase)) {
    return null;
  }
  if (integration.phase === "accepted") {
    return condition === "missing"
      ? "accepted worktree was removed before cleanup was recorded; rerun the remove command"
      : "accepted worktree awaits verified cleanup";
  }
  if (condition === "missing") {
    return `managed worktree is missing; verify the prior process stopped, then run node scripts/parallel-slices/slice-worktree.mjs resume --worker-id ${worker.workerId}`;
  }
  if (condition === "unreadable") {
    return "managed worktree could not be inspected";
  }
  if (worker.phase === "pipeline_running") {
    return "worker pipeline is running or was interrupted; verify the worker session before rerunning it";
  }
  if (integration.phase === "pipeline_running") {
    return "integrated pipeline is running or was interrupted; verify no process remains, then rerun the complete gate";
  }
  if (integration.phase === "review_running") {
    return "review is running or was interrupted; the next review attempt will preserve interruption evidence";
  }
  if (condition === "dirty") {
    return "partial scoped changes are preserved in the worker worktree";
  }
  if (["claimed", "failed"].includes(worker.phase)) {
    return `worktree setup did not reach a durable ready checkpoint; run node scripts/parallel-slices/slice-worktree.mjs resume --worker-id ${worker.workerId}`;
  }
  if (
    worker.phase === "pipeline_passed" &&
    integration.phase === "waiting_for_candidate"
  ) {
    return "worker pipeline passed; create or verify the candidate commit";
  }
  if (integration.phase === "candidate_verified") {
    return `candidate is verified and awaits serial integration; run node scripts/parallel-slices/slice-worktree.mjs apply --worker-id ${worker.workerId}`;
  }
  if (integration.phase === "integration_claimed") {
    return condition === "clean"
      ? `serial integration was claimed before the candidate was applied; verify no process remains, then run node scripts/parallel-slices/slice-worktree.mjs apply --worker-id ${worker.workerId}`
      : "serial integration is claimed and the goal checkout contains preserved candidate changes";
  }
  if (integration.phase === "pipeline_passed") {
    return "integrated gate passed; complete the independent review and record its evidence";
  }
  if (integration.phase === "review_approved") {
    return "tracked review approved; record accepted state and create the slice commit";
  }
  if (integration.phase === "pipeline_failed") {
    return "integrated gate failed; preserve evidence and start a bounded retry";
  }
  if (integration.phase === "review_failed") {
    return "integrated review did not approve; preserve findings and start a bounded retry";
  }
  return null;
}

function effectiveStatus(sliceState, attempt) {
  if (["accepted", "blocked", "failed"].includes(sliceState.status)) {
    return sliceState.status;
  }
  if (!attempt) return "not_started";
  const integration = attempt.integration.phase;
  if (["accepted", "cleanup_completed"].includes(integration)) {
    return "accepted_pending_state";
  }
  if (integration === "retry_requested") return "retrying";
  if (integration.startsWith("review_")) return integration;
  if (integration !== "waiting_for_candidate") return integration;
  return attempt.worker.phase;
}

export function summarizeRunStatus(root, statePath) {
  const { state, attempts, reconciliationNeeded } = listRunAttempts(
    root,
    statePath,
  );
  const manifests = loadPlanManifests(root, state.plan);
  const manifestBySlice = new Map(
    manifests.map((manifest) => [manifest.slice, manifest]),
  );
  const attemptsBySlice = new Map();
  for (const attempt of attempts) {
    const current = attemptsBySlice.get(attempt.worker.slice) ?? [];
    current.push(attempt);
    attemptsBySlice.set(attempt.worker.slice, current);
  }
  const slices = Object.entries(state.slices).map(([slice, sliceState]) => {
    const history = attemptsBySlice.get(slice) ?? [];
    const attempt = history.at(-1) ?? null;
    const condition = attempt ? worktreeCondition(attempt) : null;
    const progress =
      sliceState.status === "accepted"
        ? 100
        : attempt
          ? attemptProgress(attempt)
          : 0;
    let recovery = attempt ? recoveryNote(attempt, condition) : null;
    if (
      sliceState.status === "accepted" &&
      attempt &&
      !["accepted", "cleanup_completed"].includes(attempt.integration.phase)
    ) {
      recovery =
        "committed state accepted this slice before runtime acceptance was recorded; rerun accept and remove";
    }
    return {
      slice,
      status: effectiveStatus(sliceState, attempt),
      progress,
      attempts: history.length,
      observable: manifestBySlice.get(slice)?.observable ?? null,
      workerId: attempt?.worker.workerId ?? null,
      workerPhase: attempt?.worker.phase ?? null,
      integrationPhase: attempt?.integration.phase ?? null,
      worktree: condition,
      pipeline:
        latestPipeline(attempt?.integration) ?? latestPipeline(attempt?.worker),
      review: readReviewStatus(root, sliceState.reviewArtifact),
      recovery,
    };
  });
  const rootChanged = workingChangedFiles(root, "HEAD");
  const warnings = runtimeRecoveryWarnings(root, state.runId);
  if (reconciliationNeeded) {
    warnings.push(
      "the runtime index missed a complete atomic attempt directory; reacquire the run lease to reconcile its index and worker pointer before resuming",
    );
  }
  if (rootChanged.length) {
    const matches = slices.filter((slice) => {
      const history = attemptsBySlice.get(slice.slice) ?? [];
      const attempt = history.at(-1);
      const manifest = manifestBySlice.get(slice.slice);
      if (
        !attempt ||
        !manifest ||
        [
          "waiting_for_candidate",
          "retry_requested",
          "accepted",
          "cleanup_completed",
        ].includes(attempt.integration.phase)
      ) {
        return false;
      }
      return rootChanged.every((path) =>
        pathMatches(path, [...manifest.allow, ...manifest.coordinate]),
      );
    });
    if (matches.length === 1) {
      const match = matches[0];
      match.recovery =
        match.integrationPhase === "integration_claimed"
          ? `goal checkout contains this claimed candidate before application was checkpointed; verify the prior process stopped, then run node scripts/parallel-slices/slice-worktree.mjs apply --worker-id ${match.workerId}`
          : match.integrationPhase === "candidate_verified"
            ? "goal checkout changed before an integration claim was recorded; stop with BLOCKED and inspect it"
            : match.integrationPhase === "pipeline_passed"
              ? "goal checkout contains this slice after its integrated gate passed; complete independent review and record its evidence"
              : match.integrationPhase === "review_approved"
                ? "goal checkout contains this approved slice; record accepted state and create its commit"
                : `goal checkout contains this slice's tracked integration changes; resume from ${match.integrationPhase}`;
    } else {
      warnings.push(
        `dirty goal checkout does not match exactly one active integration (${rootChanged.join(", ")}); stop with BLOCKED and inspect it`,
      );
    }
  }
  const accepted = slices.filter((slice) => slice.status === "accepted").length;
  const progress = Math.round(
    slices.reduce((total, slice) => total + slice.progress, 0) / slices.length,
  );
  const activeAttempts = attempts.filter(
    (attempt) =>
      !["retry_requested", "cleanup_completed"].includes(
        attempt.integration.phase,
      ),
  );
  return {
    statePath,
    runId: state.runId,
    milestone: state.milestone,
    branch: state.goalBranch,
    controller: state.controller,
    committedStatus: state.status,
    status:
      activeAttempts.length && state.status === "not_started"
        ? "in_progress"
        : state.status,
    progress,
    accepted,
    total: slices.length,
    slices,
    rootChanged,
    warnings,
  };
}

export function renderRunStatus(summary) {
  const lines = [
    `Parallel Slices status: ${summary.milestone}`,
    `Run: ${summary.status} | Controller: ${summary.controller} | Branch: ${summary.branch}`,
    `Total ${bar(summary.progress)} ${String(summary.progress).padStart(3)}% (${summary.accepted}/${summary.total} accepted)`,
    "",
    "Slices:",
  ];
  for (const slice of summary.slices) {
    lines.push(
      `  ${slice.slice.padEnd(8)} ${bar(slice.progress)} ${String(slice.progress).padStart(3)}%  ${slice.status}`,
    );
    if (slice.observable) lines.push(`           ${slice.observable}`);
    if (slice.pipeline) {
      const step = slice.pipeline.currentStep
        ? `, current: ${slice.pipeline.currentStep}`
        : "";
      lines.push(
        `           pipeline ${slice.pipeline.pipeline}: ${slice.pipeline.status} (${slice.pipeline.completedSteps}/${slice.pipeline.totalSteps}${step})`,
      );
    }
    if (slice.review) lines.push(`           review: ${slice.review}`);
    if (slice.recovery) lines.push(`           recovery: ${slice.recovery}`);
  }
  if (summary.warnings.length) {
    lines.push("", "Recovery alerts:");
    for (const warning of summary.warnings) lines.push(`  - ${warning}`);
  }
  return `${lines.join("\n")}\n`;
}

function parseArguments(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--state") {
      const value = argv[index + 1];
      if (!value) fail("--state requires a value");
      options.state = value;
      index += 1;
    } else fail(`unknown argument: ${argument}`);
  }
  return options;
}

function runCli(argv) {
  const options = parseArguments(argv);
  const root = repositoryRoot();
  const statePath = discoverStatePath(root, options.state);
  const summary = summarizeRunStatus(root, statePath);
  console.log(
    options.json ? JSON.stringify(summary, null, 2) : renderRunStatus(summary),
  );
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`RUN STATUS FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
