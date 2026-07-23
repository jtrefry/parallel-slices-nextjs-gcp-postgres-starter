#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertRunLock } from "./run-lock.mjs";
import { readRunState } from "./run-state.mjs";
import { validatePlanningReviewEvidence } from "./planning-review.mjs";
import { loadReviewConfig } from "./review-config.mjs";
import {
  claimIntegrationAttempt,
  createSliceAttemptTracking,
  listActiveWorkerMetadata,
  listRunAttempts,
  readSliceAttemptTracking,
  readWorkerMetadata,
  updateIntegrationTracking,
  updateWorkerTracking,
} from "./run-tracking.mjs";
import {
  computeReadySlices,
  loadPlanManifests,
  manifestsConflict,
} from "./slice-graph.mjs";
import { pathMatches, workingChangedFiles } from "./scope-policy.mjs";

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
  return git(process.cwd(), ["rev-parse", "--show-toplevel"]);
}

function readMetadata(root, workerId) {
  const tracking = readSliceAttemptTracking(root, workerId);
  const value = readWorkerMetadata(root, workerId);
  return { tracking, value };
}

function activeMetadata(root, statePath) {
  return listActiveWorkerMetadata(root, statePath);
}

function manifestForMetadata(root, metadata) {
  const state = readRunState(root, metadata.state);
  const manifests = loadPlanManifests(root, state.plan);
  const manifest = manifests.find(
    (candidate) => candidate.path === metadata.scopeFile,
  );
  if (!manifest || manifest.slice !== metadata.slice) {
    fail(`worker metadata no longer matches its committed scope manifest`);
  }
  return { state, manifests, manifest };
}

export function createSliceWorktree(root, options) {
  assertRunLock(root, options.controller, options.state);
  const state = readRunState(root, options.state);
  const reviewConfig = loadReviewConfig(root);
  if (reviewConfig.enabled && !state.compilation?.planningReview) {
    fail("enabled multi-agent review requires planningReview in run state");
  }
  if (!reviewConfig.enabled && state.compilation?.planningReview) {
    fail(
      "disabled multi-agent review requires run state to omit planningReview",
    );
  }
  if (reviewConfig.enabled) {
    validatePlanningReviewEvidence(root, options.state);
  }
  if (state.status !== "not_started" && state.status !== "in_progress") {
    fail(`run state is not writable: ${state.status}`);
  }
  if (git(root, ["status", "--porcelain=v1"])) {
    fail("slice worktree creation requires a clean goal checkout");
  }
  const manifests = loadPlanManifests(root, state.plan);
  const ready = computeReadySlices(manifests, state);
  const manifest = ready.find(
    (candidate) => candidate.path === options.scopeFile,
  );
  if (!manifest) {
    fail(
      `scope manifest is not in the next ready parallel set: ${options.scopeFile}`,
    );
  }
  const active = activeMetadata(root, options.state);
  if (active.some((metadata) => metadata.slice === manifest.slice)) {
    fail(`slice ${manifest.slice} already has an active worker`);
  }
  for (const metadata of active) {
    const activeManifest = manifests.find(
      (candidate) => candidate.path === metadata.scopeFile,
    );
    if (!activeManifest || manifestsConflict(manifest, activeManifest)) {
      fail(
        `slice ${manifest.slice} conflicts with active slice ${metadata.slice}`,
      );
    }
  }

  const baseCommit = git(root, ["rev-parse", "HEAD"]);
  const workerId = randomUUID();
  const worktree = resolve(
    root,
    `.parallel-slices/runtime/worktrees/${state.runId}-${manifest.slice}-${workerId.slice(0, 8)}`,
  );
  if (existsSync(worktree)) fail(`worker worktree already exists: ${worktree}`);
  mkdirSync(resolve(root, ".parallel-slices/runtime/worktrees"), {
    recursive: true,
  });
  createSliceAttemptTracking(root, {
    state: options.state,
    slice: manifest.slice,
    scopeFile: manifest.path,
    workerId,
    baseCommit,
    worktree,
  });
  return resumeSliceWorktree(root, workerId);
}

function registeredWorktrees(root) {
  return git(root, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

export function resumeSliceWorktree(root, workerId) {
  const { tracking, value: metadata } = readMetadata(root, workerId);
  assertRunLock(root, metadata.controller, metadata.state);
  if (
    ["retry_requested", "accepted", "cleanup_completed"].includes(
      tracking.integration.phase,
    )
  ) {
    fail(
      `slice ${metadata.slice} attempt ${tracking.worker.attempt} is already closed`,
    );
  }
  const target = metadata.candidateCommit ?? metadata.baseCommit;
  const recoverCreation = ["claimed", "failed"].includes(tracking.worker.phase);
  if (existsSync(metadata.worktree)) {
    if (!recoverCreation) return metadata;
    if (git(metadata.worktree, ["status", "--porcelain=v1"])) {
      fail(`refusing to resume a dirty claimed worktree: ${metadata.worktree}`);
    }
    if (git(metadata.worktree, ["rev-parse", "HEAD"]) !== target) {
      fail(`claimed worktree does not match its recorded commit: ${target}`);
    }
  } else {
    if (registeredWorktrees(root).includes(metadata.worktree)) {
      git(root, ["worktree", "remove", "--force", metadata.worktree]);
    }
    try {
      git(root, ["worktree", "add", "--detach", metadata.worktree, target]);
    } catch (error) {
      updateWorkerTracking(root, workerId, "failed", {
        blocker: `Worktree recovery failed: ${error.message}`,
      });
      throw error;
    }
  }
  if (recoverCreation) {
    updateWorkerTracking(
      root,
      workerId,
      metadata.candidateCommit ? "candidate_ready" : "worktree_ready",
      { blocker: null },
    );
  }
  return readWorkerMetadata(root, workerId);
}

export function verifySliceCandidate(root, workerId, options = {}) {
  const { tracking, value: metadata } = readMetadata(root, workerId);
  assertRunLock(root, metadata.controller, metadata.state);
  if (!existsSync(metadata.worktree))
    fail(`worker worktree is missing: ${metadata.worktree}`);
  const { manifest } = manifestForMetadata(root, metadata);
  if (git(metadata.worktree, ["status", "--porcelain=v1"])) {
    fail(`slice ${metadata.slice} candidate worktree is not clean`);
  }
  const latestWorkerPipeline = tracking.worker.pipelines.at(-1);
  if (
    tracking.worker.phase !== "candidate_ready" ||
    !latestWorkerPipeline ||
    latestWorkerPipeline.status !== "passed"
  ) {
    fail(
      `slice ${metadata.slice} candidate is not backed by a passed tracked worker gate`,
    );
  }
  const candidateCommit = git(metadata.worktree, ["rev-parse", "HEAD"]);
  if (tracking.worker.candidateCommit !== candidateCommit) {
    fail(
      `slice ${metadata.slice} candidate checkpoint does not match worker HEAD`,
    );
  }
  if (candidateCommit === metadata.baseCommit) {
    fail(`slice ${metadata.slice} has no candidate commit`);
  }
  const count = Number(
    git(metadata.worktree, [
      "rev-list",
      "--count",
      `${metadata.baseCommit}..${candidateCommit}`,
    ]),
  );
  if (count !== 1)
    fail(`slice ${metadata.slice} must produce exactly one candidate commit`);
  const parent = git(metadata.worktree, ["rev-parse", `${candidateCommit}^`]);
  if (parent !== metadata.baseCommit) {
    fail(
      `slice ${metadata.slice} candidate is not based on its assigned commit`,
    );
  }
  const subject = git(metadata.worktree, [
    "show",
    "-s",
    "--format=%s",
    candidateCommit,
  ]);
  if (subject !== manifest.commit) {
    fail(`slice ${metadata.slice} commit subject must be: ${manifest.commit}`);
  }
  const changed = git(metadata.worktree, [
    "diff",
    "--name-only",
    "--diff-filter=ACMRD",
    metadata.baseCommit,
    candidateCommit,
    "--",
  ])
    .split("\n")
    .filter(Boolean);
  if (!changed.length)
    fail(`slice ${metadata.slice} candidate has no changed paths`);
  const outside = changed.filter(
    (candidate) => !pathMatches(candidate, manifest.allow),
  );
  if (outside.length) {
    fail(
      `slice ${metadata.slice} candidate changed paths outside worker scope:\n${outside
        .map((candidate) => `  ${candidate}`)
        .join("\n")}`,
    );
  }
  const updated = { ...metadata, status: "candidate", candidateCommit };
  if (options.record !== false) {
    if (tracking.integration.phase === "waiting_for_candidate") {
      updateIntegrationTracking(root, workerId, "candidate_verified", {
        candidateCommit,
        blocker: null,
      });
    } else if (tracking.integration.candidateCommit !== candidateCommit) {
      fail(
        `slice ${metadata.slice} tracked integration candidate does not match worker HEAD`,
      );
    }
  }
  return { metadata: updated, manifest, changed };
}

function assertCandidateDependenciesAccepted(state, manifest) {
  const dependencies =
    manifest.depends_on === "none" ? [] : manifest.depends_on.split(",");
  const pending = dependencies.filter(
    (slice) => state.slices[slice]?.status !== "accepted",
  );
  if (pending.length) {
    fail(
      `slice ${manifest.slice} cannot integrate before dependencies are accepted: ${pending.join(", ")}`,
    );
  }
}

export function applySliceCandidate(root, workerId) {
  const verified = verifySliceCandidate(root, workerId);
  const state = readRunState(root, verified.metadata.state);
  const tracking = readSliceAttemptTracking(root, workerId);
  const sliceState = state.slices[verified.metadata.slice];
  if (!sliceState || sliceState.status === "accepted") {
    fail(`slice ${verified.metadata.slice} is not available for integration`);
  }
  assertCandidateDependenciesAccepted(state, verified.manifest);
  const expected = [...verified.changed].sort();
  const goalHead = git(root, ["rev-parse", "HEAD"]);
  let goalBaseCommit = tracking.integration.goalBaseCommit;
  if (
    ["integration_claimed", "candidate_applied"].includes(
      tracking.integration.phase,
    )
  ) {
    if (
      tracking.integration.candidateCommit !==
        verified.metadata.candidateCommit ||
      goalBaseCommit !== goalHead
    ) {
      fail(
        `slice ${verified.metadata.slice} integration claim does not match the current candidate and goal commit`,
      );
    }
    const preserved = workingChangedFiles(root, goalBaseCommit).sort();
    const unmerged = git(root, ["diff", "--name-only", "--diff-filter=U", "--"])
      .split("\n")
      .filter(Boolean);
    if (unmerged.length) {
      fail(
        `slice ${verified.metadata.slice} candidate application has unresolved conflicts; preserve evidence and run the bounded retry`,
      );
    }
    if (preserved.length) {
      if (JSON.stringify(preserved) !== JSON.stringify(expected)) {
        fail("claimed goal-checkout paths do not match the verified candidate");
      }
      if (tracking.integration.phase === "integration_claimed") {
        updateIntegrationTracking(root, workerId, "candidate_applied", {
          candidateCommit: verified.metadata.candidateCommit,
          goalBaseCommit,
          blocker: null,
        });
      }
      return {
        workerId,
        slice: verified.metadata.slice,
        candidateCommit: verified.metadata.candidateCommit,
        goalBaseCommit,
        changed: expected,
      };
    }
    if (tracking.integration.phase === "candidate_applied") {
      fail("recorded candidate application is missing from the goal checkout");
    }
  } else {
    if (git(root, ["status", "--porcelain=v1"])) {
      fail("candidate application requires a clean goal checkout");
    }
    goalBaseCommit = goalHead;
    claimIntegrationAttempt(root, workerId, goalBaseCommit);
  }
  try {
    git(root, [
      "cherry-pick",
      "--no-commit",
      verified.metadata.candidateCommit,
    ]);
  } catch (error) {
    updateIntegrationTracking(root, workerId, "interrupted", {
      candidateCommit: verified.metadata.candidateCommit,
      goalBaseCommit,
      blocker:
        `Candidate application requires recovery: ${error.message}`.slice(
          0,
          500,
        ),
    });
    throw error;
  }
  const applied = workingChangedFiles(root, goalBaseCommit).sort();
  if (JSON.stringify(applied) !== JSON.stringify(expected)) {
    updateIntegrationTracking(root, workerId, "interrupted", {
      candidateCommit: verified.metadata.candidateCommit,
      goalBaseCommit,
      blocker:
        "Applied goal-checkout paths do not match the verified candidate.",
    });
    fail("applied goal-checkout paths do not match the verified candidate");
  }
  updateIntegrationTracking(root, workerId, "candidate_applied", {
    candidateCommit: verified.metadata.candidateCommit,
    goalBaseCommit,
    blocker: null,
  });
  return {
    workerId,
    slice: verified.metadata.slice,
    candidateCommit: verified.metadata.candidateCommit,
    goalBaseCommit,
    changed: expected,
  };
}

export function acceptSliceCandidate(root, workerId) {
  const verified = verifySliceCandidate(root, workerId);
  const tracking = readSliceAttemptTracking(root, workerId);
  const state = readRunState(root, verified.metadata.state);
  const sliceState = state.slices[verified.metadata.slice];
  const acceptedCommit = git(root, ["rev-parse", "HEAD"]);
  const latestIntegratedPipeline = tracking.integration.pipelines.at(-1);
  const reviewConfig = loadReviewConfig(root);
  const trackedReviewApproved =
    tracking.integration.phase === "review_approved" &&
    tracking.integration.review?.status === "APPROVED";
  if (
    !latestIntegratedPipeline ||
    latestIntegratedPipeline.status !== "passed"
  ) {
    fail(
      `slice ${verified.metadata.slice} cannot be accepted without a passed integrated gate`,
    );
  }
  if (reviewConfig.enabled && !trackedReviewApproved) {
    fail(
      `slice ${verified.metadata.slice} cannot be accepted without an approved tracked multi-agent review`,
    );
  }
  if (
    !trackedReviewApproved &&
    tracking.integration.phase !== "pipeline_passed"
  ) {
    fail(
      `slice ${verified.metadata.slice} cannot be accepted from integration phase ${tracking.integration.phase}`,
    );
  }
  if (
    !tracking.integration.goalBaseCommit ||
    git(root, ["rev-parse", `${acceptedCommit}^`]) !==
      tracking.integration.goalBaseCommit
  ) {
    fail(
      `slice ${verified.metadata.slice} accepted commit is not based on its claimed goal commit`,
    );
  }
  if (
    git(root, ["show", "-s", "--format=%s", acceptedCommit]) !==
    verified.manifest.commit
  ) {
    fail(
      `slice ${verified.metadata.slice} accepted commit subject must be: ${verified.manifest.commit}`,
    );
  }
  if (git(root, ["status", "--porcelain=v1"])) {
    fail("slice acceptance requires a clean committed goal checkout");
  }
  if (
    sliceState.status !== "accepted" ||
    sliceState.candidateCommit !== verified.metadata.candidateCommit ||
    sliceState.gateEvidence.length === 0 ||
    sliceState.reviewEvidence.length === 0
  ) {
    fail(
      `run state has not accepted slice ${verified.metadata.slice} at current HEAD`,
    );
  }
  if (trackedReviewApproved) {
    const reviewArtifact = tracking.integration.review.artifact;
    if (reviewArtifact !== sliceState.reviewArtifact) {
      fail(
        `slice ${verified.metadata.slice} tracked review does not match run state`,
      );
    }
    for (const path of [
      reviewArtifact,
      reviewArtifact.replace(/\.json$/, ".md"),
    ]) {
      if (
        git(root, ["cat-file", "-e", `${acceptedCommit}:${path}`], {
          allowFailure: true,
        }) === null
      ) {
        fail(
          `slice ${verified.metadata.slice} accepted commit is missing ${path}`,
        );
      }
    }
  }
  for (const changedPath of verified.changed) {
    const candidateBlob = git(
      root,
      ["rev-parse", `${verified.metadata.candidateCommit}:${changedPath}`],
      { allowFailure: true },
    );
    const acceptedBlob = git(
      root,
      ["rev-parse", `${acceptedCommit}:${changedPath}`],
      {
        allowFailure: true,
      },
    );
    if (candidateBlob !== acceptedBlob) {
      fail(
        `accepted commit changed worker-owned path after review: ${changedPath}`,
      );
    }
  }
  updateIntegrationTracking(root, workerId, "accepted", {
    candidateCommit: verified.metadata.candidateCommit,
    goalBaseCommit: tracking.integration.goalBaseCommit,
    acceptedCommit,
    review: trackedReviewApproved
      ? tracking.integration.review
      : { status: "INDEPENDENT", artifact: null },
    blocker: null,
  });
  return readWorkerMetadata(root, workerId);
}

function reviewEvidencePaths(manifest) {
  return [manifest.review, manifest.review.replace(/\.json$/, ".md")];
}

function captureReviewEvidence(root, manifest) {
  const evidence = {};
  for (const path of reviewEvidencePaths(manifest)) {
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) continue;
    if (!lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) {
      fail(`refusing unsafe review evidence during retry: ${path}`);
    }
    evidence[path] = readFileSync(absolute, "utf8");
  }
  return evidence;
}

function restoreGoalCheckout(root, changed) {
  const trackedAtHead = [];
  for (const path of changed) {
    if (
      git(root, ["cat-file", "-e", `HEAD:${path}`], {
        allowFailure: true,
      }) !== null
    ) {
      trackedAtHead.push(path);
      continue;
    }
    git(root, ["restore", "--staged", "--", path], { allowFailure: true });
    const absolute = resolve(root, path);
    if (existsSync(absolute)) {
      const metadata = lstatSync(absolute);
      if (!metadata.isFile() && !metadata.isSymbolicLink()) {
        fail(
          `retry cannot remove non-file path from failed integration: ${path}`,
        );
      }
      unlinkSync(absolute);
    }
  }
  if (trackedAtHead.length) {
    git(root, [
      "restore",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "--",
      ...trackedAtHead,
    ]);
  }
  if (git(root, ["status", "--porcelain=v1"])) {
    fail("retry could not restore a clean goal checkout");
  }
}

function abortInterruptedCherryPick(root) {
  if (
    git(root, ["rev-parse", "--verify", "-q", "CHERRY_PICK_HEAD"], {
      allowFailure: true,
    }) === null
  ) {
    return false;
  }
  git(root, ["cherry-pick", "--abort"]);
  return true;
}

export function retrySliceWorker(root, workerId) {
  const { value: metadata, tracking } = readMetadata(root, workerId);
  assertRunLock(root, metadata.controller, metadata.state);
  const { manifest } = manifestForMetadata(root, metadata);
  if (tracking.integration.phase === "retry_requested") {
    return continueRequestedRetry(root, metadata, tracking, manifest);
  }
  if (!existsSync(metadata.worktree)) {
    fail(`worker worktree is missing: ${metadata.worktree}`);
  }
  if (git(metadata.worktree, ["status", "--porcelain=v1"])) {
    fail(`retry requires a clean candidate worktree: ${metadata.worktree}`);
  }
  const verified = verifySliceCandidate(root, workerId, { record: false });
  const retryCount = metadata.retryCount ?? 0;
  if (retryCount >= 3) {
    fail(`slice ${metadata.slice} exhausted three fresh-worker retries`);
  }
  const changed = workingChangedFiles(root, "HEAD");
  const ownedPatterns = [...manifest.allow, ...manifest.coordinate];
  const outside = changed.filter(
    (candidate) => !pathMatches(candidate, ownedPatterns),
  );
  if (outside.length) {
    fail(
      `retry refuses unrelated goal-checkout changes:\n${outside
        .map((candidate) => `  ${candidate}`)
        .join("\n")}`,
    );
  }
  const reviewEvidence = {
    ...(metadata.reviewEvidence ?? {}),
    ...captureReviewEvidence(root, manifest),
  };
  abortInterruptedCherryPick(root);
  const recoverableChanged = workingChangedFiles(root, "HEAD");
  const recoverableOutside = recoverableChanged.filter(
    (candidate) => !pathMatches(candidate, ownedPatterns),
  );
  if (recoverableOutside.length) {
    fail(
      `retry refuses unrelated goal-checkout changes after cherry-pick recovery:\n${recoverableOutside
        .map((candidate) => `  ${candidate}`)
        .join("\n")}`,
    );
  }
  restoreGoalCheckout(root, recoverableChanged);
  git(root, ["worktree", "remove", metadata.worktree]);

  updateIntegrationTracking(root, workerId, "retry_requested", {
    candidateCommit: verified.metadata.candidateCommit,
    reviewEvidence,
    blocker:
      tracking.integration.blocker ??
      "The candidate requires a fresh bounded correction attempt.",
  });
  return continueRequestedRetry(
    root,
    metadata,
    readSliceAttemptTracking(root, workerId),
    manifest,
  );
}

function continueRequestedRetry(root, metadata, tracking, manifest) {
  if (git(root, ["status", "--porcelain=v1"])) {
    fail("retry recovery requires a clean goal checkout");
  }
  const sliceAttempts = listRunAttempts(root, metadata.state).attempts.filter(
    (attempt) => attempt.worker.slice === metadata.slice,
  );
  const currentOffset = sliceAttempts.findIndex(
    (attempt) => attempt.worker.workerId === metadata.workerId,
  );
  if (currentOffset < 0) {
    fail(`retry source attempt is missing from slice ${metadata.slice}`);
  }
  const existingNext = sliceAttempts[currentOffset + 1];
  if (existingNext) {
    if (existingNext.integration.phase === "retry_requested") {
      return retrySliceWorker(root, existingNext.worker.workerId);
    }
    updateIntegrationTracking(
      root,
      existingNext.worker.workerId,
      existingNext.integration.phase,
      {
        reviewEvidence: {
          ...tracking.integration.reviewEvidence,
          ...existingNext.integration.reviewEvidence,
        },
      },
    );
    return resumeSliceWorktree(root, existingNext.worker.workerId);
  }

  const retryCount = metadata.retryCount ?? 0;
  if (retryCount >= 3) {
    fail(`slice ${metadata.slice} exhausted three fresh-worker retries`);
  }
  const baseCommit = git(root, ["rev-parse", "HEAD"]);
  const nextRetry = retryCount + 1;
  const nextWorkerId = randomUUID();
  const worktree = resolve(
    root,
    `.parallel-slices/runtime/worktrees/${metadata.runId}-${manifest.slice}-${nextWorkerId.slice(0, 8)}-retry-${nextRetry}`,
  );
  if (existsSync(worktree)) fail(`retry worktree already exists: ${worktree}`);
  createSliceAttemptTracking(root, {
    state: metadata.state,
    slice: metadata.slice,
    scopeFile: metadata.scopeFile,
    workerId: nextWorkerId,
    baseCommit,
    worktree,
    retryOffset: tracking.worker.retryOffset,
  });
  updateIntegrationTracking(root, nextWorkerId, "waiting_for_candidate", {
    reviewEvidence: tracking.integration.reviewEvidence,
  });
  return resumeSliceWorktree(root, nextWorkerId);
}

export function restoreSliceReviewEvidence(root, workerId) {
  const { value: metadata } = readMetadata(root, workerId);
  assertRunLock(root, metadata.controller, metadata.state);
  const { manifest } = manifestForMetadata(root, metadata);
  const evidence = metadata.reviewEvidence ?? {};
  const permitted = new Set(reviewEvidencePaths(manifest));
  for (const path of Object.keys(evidence)) {
    if (!permitted.has(path)) {
      fail(`worker metadata contains unexpected review evidence: ${path}`);
    }
    const absolute = resolve(root, path);
    if (existsSync(absolute)) {
      if (
        !lstatSync(absolute).isFile() ||
        lstatSync(absolute).isSymbolicLink()
      ) {
        fail(`refusing unsafe review evidence path: ${path}`);
      }
      if (readFileSync(absolute, "utf8") !== evidence[path]) {
        fail(`refusing to overwrite changed review evidence: ${path}`);
      }
      continue;
    }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, evidence[path]);
  }
  return Object.keys(evidence);
}

export function removeAcceptedWorktree(root, workerId) {
  const { value: metadata } = readMetadata(root, workerId);
  if (metadata.status !== "accepted" || !metadata.acceptedCommit) {
    fail("only an accepted worker worktree may be removed automatically");
  }
  if (existsSync(metadata.worktree)) {
    if (git(metadata.worktree, ["status", "--porcelain=v1"])) {
      fail(`refusing to remove dirty worker worktree: ${metadata.worktree}`);
    }
    git(root, ["worktree", "remove", metadata.worktree]);
  }
  updateIntegrationTracking(root, workerId, "cleanup_completed");
  git(root, ["worktree", "prune"]);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (
      !["--controller", "--state", "--scope-file", "--worker-id"].includes(flag)
    ) {
      fail(`unknown argument: ${flag}`);
    }
    const value = rest[index + 1];
    if (!value) fail(`${flag} requires a value`);
    options[flag.slice(2).replace("-", "")] = value;
    index += 1;
  }
  if (command === "create") {
    if (!options.controller || !options.state || !options.scopefile) {
      fail("create requires --controller, --state, and --scope-file");
    }
  } else if (
    ![
      "resume",
      "verify",
      "apply",
      "retry",
      "restore-evidence",
      "accept",
      "remove",
    ].includes(command) ||
    !options.workerid
  ) {
    fail(
      "usage: slice-worktree.mjs create --controller <id> --state <path> --scope-file <path> | resume|verify|apply|retry|restore-evidence|accept|remove --worker-id <id>",
    );
  }
  return { command, ...options };
}

function runCli(argv) {
  const root = repositoryRoot();
  const options = parseArgs(argv);
  if (options.command === "create") {
    console.log(
      JSON.stringify(
        createSliceWorktree(root, {
          controller: options.controller,
          state: options.state,
          scopeFile: options.scopefile,
        }),
      ),
    );
  } else if (options.command === "resume") {
    console.log(JSON.stringify(resumeSliceWorktree(root, options.workerid)));
  } else if (options.command === "verify") {
    console.log(
      JSON.stringify(verifySliceCandidate(root, options.workerid).metadata),
    );
  } else if (options.command === "apply") {
    console.log(JSON.stringify(applySliceCandidate(root, options.workerid)));
  } else if (options.command === "retry") {
    console.log(JSON.stringify(retrySliceWorker(root, options.workerid)));
  } else if (options.command === "restore-evidence") {
    console.log(
      JSON.stringify(restoreSliceReviewEvidence(root, options.workerid)),
    );
  } else if (options.command === "accept") {
    console.log(JSON.stringify(acceptSliceCandidate(root, options.workerid)));
  } else {
    removeAcceptedWorktree(root, options.workerid);
    console.log(`removed accepted worker: ${options.workerid}`);
  }
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`SLICE WORKTREE FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
