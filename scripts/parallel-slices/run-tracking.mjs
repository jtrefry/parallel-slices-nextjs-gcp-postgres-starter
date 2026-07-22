#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { readRunState } from "./run-state.mjs";
import { assertSafeRelativePath } from "./scope-policy.mjs";

const workerPhases = Object.freeze([
  "claimed",
  "worktree_ready",
  "preflight_passed",
  "implementing",
  "pipeline_running",
  "pipeline_failed",
  "pipeline_passed",
  "candidate_ready",
  "blocked",
  "failed",
  "interrupted",
]);

const integrationPhases = Object.freeze([
  "waiting_for_candidate",
  "candidate_verified",
  "integration_claimed",
  "candidate_applied",
  "pipeline_running",
  "pipeline_failed",
  "pipeline_passed",
  "review_running",
  "review_failed",
  "review_approved",
  "retry_requested",
  "accepted",
  "cleanup_completed",
  "interrupted",
]);

const goalMutationIntegrationPhases = new Set([
  "integration_claimed",
  "candidate_applied",
  "pipeline_running",
  "pipeline_failed",
  "pipeline_passed",
  "review_running",
  "review_failed",
  "review_approved",
  "interrupted",
]);

const closedIntegrationPhases = new Set([
  "retry_requested",
  "cleanup_completed",
]);

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

function nowIso() {
  return new Date().toISOString();
}

function assertIdentifier(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value || "")) {
    fail(`${label} is invalid`);
  }
}

function assertWorkerId(value) {
  if (!/^[a-z0-9][a-z0-9-]{15,63}$/.test(value || "")) {
    fail("worker ID is invalid");
  }
}

function assertCommit(value, label, nullable = false) {
  if (nullable && value === null) return;
  if (!/^[0-9a-f]{40}$/.test(value || "")) {
    fail(`${label} must be a full commit SHA`);
  }
}

function assertInsideRoot(root, path, label) {
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    fail(`${label} is outside the repository`);
  }
  return absolute;
}

function ensureSafeDirectory(root, target) {
  const rootReal = realpathSync(root);
  const absolute = assertInsideRoot(rootReal, target, "runtime directory");
  const pathFromRoot = relative(rootReal, absolute);
  let current = rootReal;
  for (const segment of pathFromRoot.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    if (existsSync(current)) {
      const metadata = lstatSync(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        fail(
          `refusing unsafe runtime directory: ${relative(rootReal, current)}`,
        );
      }
    } else {
      mkdirSync(current);
    }
  }
  return absolute;
}

function syncDirectory(path) {
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function atomicWriteJson(root, path, value, options = {}) {
  const rootReal = realpathSync(root);
  const absolute = assertInsideRoot(rootReal, path, "runtime file");
  const directory = ensureSafeDirectory(rootReal, dirname(absolute));
  if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
    fail(`refusing symlinked runtime file: ${relative(rootReal, absolute)}`);
  }
  if (options.createOnly && existsSync(absolute)) {
    fail(`runtime file already exists: ${relative(rootReal, absolute)}`);
  }
  const temporary = `${absolute}.incoming-${process.pid}-${randomUUID()}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (options.createOnly && existsSync(absolute)) {
    unlinkSync(temporary);
    fail(`runtime file already exists: ${relative(rootReal, absolute)}`);
  }
  renameSync(temporary, absolute);
  syncDirectory(directory);
}

function readJson(root, path, label) {
  const rootReal = realpathSync(root);
  const absolute = assertInsideRoot(rootReal, path, label);
  if (!existsSync(absolute)) fail(`${label} does not exist: ${path}`);
  if (!lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) {
    fail(`refusing unsafe ${label}: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    fail(`invalid ${label} ${path}: ${error.message}`);
  }
}

function runtimeRelative(runId, suffix = "") {
  assertIdentifier(runId, "run ID");
  return `.parallel-slices/runtime/runs/${runId}${suffix ? `/${suffix}` : ""}`;
}

function indexPath(runId) {
  return runtimeRelative(runId, "index.json");
}

function indexLockPath(runId) {
  return runtimeRelative(runId, "index.lock");
}

function pointerPath(workerId) {
  assertWorkerId(workerId);
  return `.parallel-slices/runtime/workers/${workerId}.json`;
}

function attemptPaths(runId, slice, attempt) {
  assertIdentifier(slice, "slice ID");
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 999) {
    fail("attempt number must be between 1 and 999");
  }
  const number = String(attempt).padStart(3, "0");
  const directory = runtimeRelative(
    runId,
    `slices/${slice}/attempts/${number}`,
  );
  return {
    worker: `${directory}/worker.json`,
    integration: `${directory}/integration.json`,
  };
}

function writeAttemptPair(root, paths, worker, integration) {
  const directory = dirname(paths.worker);
  const staging = `${directory}.incoming-${process.pid}-${randomUUID()}`;
  const absoluteDirectory = resolve(root, directory);
  if (existsSync(absoluteDirectory)) {
    fail(`runtime attempt directory already exists: ${directory}`);
  }
  atomicWriteJson(root, `${staging}/worker.json`, worker, { createOnly: true });
  atomicWriteJson(root, `${staging}/integration.json`, integration, {
    createOnly: true,
  });
  renameSync(resolve(root, staging), absoluteDirectory);
  syncDirectory(dirname(absoluteDirectory));
}

function validateManagedWorktree(root, worker) {
  const worktreeRoot = resolve(root, ".parallel-slices/runtime/worktrees");
  const comparableRoot = existsSync(worktreeRoot)
    ? realpathSync(worktreeRoot)
    : worktreeRoot;
  const storedParent =
    typeof worker.worktree === "string" ? dirname(worker.worktree) : "";
  const comparableWorktree = existsSync(storedParent)
    ? resolve(realpathSync(storedParent), basename(worker.worktree))
    : worker.worktree;
  if (
    typeof worker.worktree !== "string" ||
    resolve(worker.worktree) !== worker.worktree ||
    !comparableWorktree.startsWith(`${comparableRoot}${sep}`)
  ) {
    fail("worker tracking worktree is outside the managed runtime");
  }
  if (existsSync(worker.worktree)) {
    const metadata = lstatSync(worker.worktree);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail(`worker tracking worktree is unsafe: ${worker.worktree}`);
    }
  }
}

function withRuntimeLock(root, path, operation) {
  const absolute = assertInsideRoot(realpathSync(root), path, "runtime lock");
  ensureSafeDirectory(root, dirname(absolute));
  let descriptor;
  try {
    descriptor = openSync(absolute, "wx", 0o600);
    writeFileSync(
      descriptor,
      `${JSON.stringify({ pid: process.pid, startedAt: nowIso() })}\n`,
    );
    fsyncSync(descriptor);
  } catch (error) {
    if (error.code === "EEXIST") {
      fail(`runtime tracking is already being updated; inspect ${path}`);
    }
    throw error;
  }
  try {
    return operation();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(absolute)) unlinkSync(absolute);
  }
}

function validateIndex(index, state, statePath) {
  if (
    !index ||
    index.version !== 1 ||
    index.runId !== state.runId ||
    index.state !== statePath ||
    index.plan !== state.plan ||
    index.controller !== state.controller ||
    !index.slices ||
    Array.isArray(index.slices)
  ) {
    fail(
      `runtime tracking index does not match run state: ${indexPath(state.runId)}`,
    );
  }
  const indexedSlices = Object.keys(index.slices);
  const stateSlices = Object.keys(state.slices);
  if (
    indexedSlices.length !== stateSlices.length ||
    indexedSlices.some((slice) => !state.slices[slice])
  ) {
    fail("runtime tracking index contains unexpected slices");
  }
  for (const [slice, sliceState] of Object.entries(state.slices)) {
    const tracked = index.slices[slice];
    if (
      !tracked ||
      tracked.manifest !== sliceState.manifest ||
      !Array.isArray(tracked.attempts)
    ) {
      fail(`runtime tracking index does not match slice ${slice}`);
    }
    for (let offset = 0; offset < tracked.attempts.length; offset += 1) {
      const reference = tracked.attempts[offset];
      const number = offset + 1;
      const expected = attemptPaths(state.runId, slice, number);
      if (
        reference?.number !== number ||
        typeof reference.workerId !== "string" ||
        reference.worker !== expected.worker ||
        reference.integration !== expected.integration
      ) {
        fail(
          `runtime tracking index has an invalid attempt reference for slice ${slice}`,
        );
      }
      assertWorkerId(reference.workerId);
    }
  }
  return index;
}

function freshIndex(state, statePath) {
  return {
    version: 1,
    runId: state.runId,
    state: statePath,
    plan: state.plan,
    controller: state.controller,
    slices: Object.fromEntries(
      Object.entries(state.slices).map(([slice, value]) => [
        slice,
        { manifest: value.manifest, attempts: [] },
      ]),
    ),
  };
}

function discoverAttemptReferences(root, state) {
  const discovered = {};
  for (const slice of Object.keys(state.slices)) {
    const attemptsDirectory = resolve(
      root,
      runtimeRelative(state.runId, `slices/${slice}/attempts`),
    );
    if (!existsSync(attemptsDirectory)) {
      discovered[slice] = [];
      continue;
    }
    const directoryMetadata = lstatSync(attemptsDirectory);
    if (
      !directoryMetadata.isDirectory() ||
      directoryMetadata.isSymbolicLink()
    ) {
      fail(`refusing unsafe attempt directory for slice ${slice}`);
    }
    const numbers = readdirSync(attemptsDirectory, { withFileTypes: true })
      .filter((entry) => /^\d{3}$/.test(entry.name))
      .map((entry) => {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          fail(`refusing unsafe attempt entry for slice ${slice}`);
        }
        return Number(entry.name);
      })
      .sort((left, right) => left - right);
    if (numbers.some((number, offset) => number !== offset + 1)) {
      fail(`runtime attempts are not contiguous for slice ${slice}`);
    }
    discovered[slice] = numbers.map((number) => {
      const paths = attemptPaths(state.runId, slice, number);
      const worker = validateWorker(
        readJson(root, paths.worker, "worker tracking file"),
      );
      validateManagedWorktree(root, worker);
      validateIntegration(
        readJson(root, paths.integration, "integration tracking file"),
        worker,
      );
      if (worker.slice !== slice || worker.attempt !== number) {
        fail(`runtime attempt identity does not match slice ${slice}`);
      }
      return {
        number,
        workerId: worker.workerId,
        worker: paths.worker,
        integration: paths.integration,
      };
    });
  }
  return discovered;
}

function reconcileIndexFromDisk(root, state, statePath, index) {
  const next = structuredClone(index);
  let changed = false;
  const discovered = discoverAttemptReferences(root, state);
  for (const slice of Object.keys(state.slices)) {
    const indexed = next.slices[slice].attempts;
    const present = discovered[slice];
    if (indexed.length > present.length) {
      fail(`runtime index references a missing attempt for slice ${slice}`);
    }
    for (let offset = 0; offset < indexed.length; offset += 1) {
      if (JSON.stringify(indexed[offset]) !== JSON.stringify(present[offset])) {
        fail(`runtime index conflicts with attempt ${offset + 1} for ${slice}`);
      }
    }
    if (present.length > indexed.length) {
      next.slices[slice].attempts = present;
      changed = true;
    }
  }
  validateIndex(next, state, statePath);
  return { index: next, changed };
}

export function ensureRunTracking(root, statePath) {
  assertSafeRelativePath(statePath, "run state path");
  const state = readRunState(root, statePath);
  const path = indexPath(state.runId);
  ensureSafeDirectory(root, runtimeRelative(state.runId));
  return withRuntimeLock(root, indexLockPath(state.runId), () => {
    const exists = existsSync(resolve(root, path));
    const current = exists
      ? validateIndex(
          readJson(root, path, "runtime tracking index"),
          state,
          statePath,
        )
      : freshIndex(state, statePath);
    const reconciled = reconcileIndexFromDisk(root, state, statePath, current);
    if (!exists || reconciled.changed) {
      atomicWriteJson(root, path, reconciled.index, { createOnly: !exists });
    }
    for (const slice of Object.values(reconciled.index.slices)) {
      for (const reference of slice.attempts) {
        const pointer = pointerPath(reference.workerId);
        if (!existsSync(resolve(root, pointer))) {
          atomicWriteJson(
            root,
            pointer,
            {
              version: 2,
              workerId: reference.workerId,
              runId: state.runId,
              worker: reference.worker,
              integration: reference.integration,
            },
            { createOnly: true },
          );
        }
      }
    }
    return { state, path, index: reconciled.index };
  });
}

function validateWorker(worker) {
  if (!worker || worker.version !== 1 || worker.role !== "worker") {
    fail("worker tracking file has an invalid version or role");
  }
  assertIdentifier(worker.runId, "worker run ID");
  assertIdentifier(worker.slice, "worker slice ID");
  assertWorkerId(worker.workerId);
  assertSafeRelativePath(worker.state, "worker state path");
  assertSafeRelativePath(worker.scopeFile, "worker scope path");
  assertCommit(worker.baseCommit, "worker baseCommit");
  assertCommit(worker.candidateCommit, "worker candidateCommit", true);
  if (
    !Number.isInteger(worker.attempt) ||
    worker.attempt < 1 ||
    worker.attempt > 999
  ) {
    fail("worker tracking attempt must be between 1 and 999");
  }
  if (!workerPhases.includes(worker.phase)) {
    fail(`worker tracking phase is invalid: ${worker.phase}`);
  }
  if (!Array.isArray(worker.pipelines)) {
    fail("worker tracking pipelines must be an array");
  }
  if (
    !Number.isInteger(worker.retryOffset) ||
    worker.retryOffset < 0 ||
    worker.retryOffset > 3
  ) {
    fail("worker tracking retryOffset must be between 0 and 3");
  }
  return worker;
}

function validateIntegration(integration, worker) {
  if (
    !integration ||
    integration.version !== 1 ||
    integration.role !== "integration" ||
    integration.runId !== worker.runId ||
    integration.slice !== worker.slice ||
    integration.attempt !== worker.attempt ||
    integration.workerId !== worker.workerId
  ) {
    fail("integration tracking file does not match its worker attempt");
  }
  if (!integrationPhases.includes(integration.phase)) {
    fail(`integration tracking phase is invalid: ${integration.phase}`);
  }
  assertCommit(
    integration.candidateCommit,
    "integration candidateCommit",
    true,
  );
  assertCommit(integration.goalBaseCommit, "integration goalBaseCommit", true);
  assertCommit(integration.acceptedCommit, "integration acceptedCommit", true);
  if (!Array.isArray(integration.pipelines)) {
    fail("integration tracking pipelines must be an array");
  }
  return integration;
}

function readIndexForState(root, statePath) {
  assertSafeRelativePath(statePath, "run state path");
  const state = readRunState(root, statePath);
  const path = indexPath(state.runId);
  if (!existsSync(resolve(root, path))) {
    const current = freshIndex(state, statePath);
    const reconciled = reconcileIndexFromDisk(root, state, statePath, current);
    return {
      state,
      path,
      index: reconciled.index,
      reconciliationNeeded: reconciled.changed,
    };
  }
  const current = validateIndex(
    readJson(root, path, "runtime tracking index"),
    state,
    statePath,
  );
  const reconciled = reconcileIndexFromDisk(root, state, statePath, current);
  return {
    state,
    path,
    index: reconciled.index,
    reconciliationNeeded: reconciled.changed,
  };
}

export function createSliceAttemptTracking(root, options) {
  const { state } = ensureRunTracking(root, options.state);
  const sliceState = state.slices[options.slice];
  if (!sliceState || sliceState.manifest !== options.scopeFile) {
    fail(`slice ${options.slice} does not match run state`);
  }
  assertWorkerId(options.workerId);
  assertCommit(options.baseCommit, "worker baseCommit");
  validateManagedWorktree(root, { worktree: options.worktree });

  return withRuntimeLock(root, indexLockPath(state.runId), () => {
    const current = readJson(
      root,
      indexPath(state.runId),
      "runtime tracking index",
    );
    validateIndex(current, state, options.state);
    const slice = current.slices[options.slice];
    const latest = slice.attempts.at(-1);
    if (latest) {
      const latestIntegration = readJson(
        root,
        latest.integration,
        "integration tracking file",
      );
      if (!closedIntegrationPhases.has(latestIntegration.phase)) {
        fail(`slice ${options.slice} already has an active attempt`);
      }
    }
    const attempt = slice.attempts.length + 1;
    const paths = attemptPaths(state.runId, options.slice, attempt);
    const worker = {
      version: 1,
      role: "worker",
      runId: state.runId,
      state: options.state,
      slice: options.slice,
      attempt,
      workerId: options.workerId,
      scopeFile: options.scopeFile,
      baseCommit: options.baseCommit,
      worktree: options.worktree,
      phase: "claimed",
      pipelines: [],
      candidateCommit: null,
      retryOffset: options.retryOffset ?? 0,
      blocker: null,
      updatedAt: nowIso(),
    };
    const integration = {
      version: 1,
      role: "integration",
      runId: state.runId,
      state: options.state,
      slice: options.slice,
      attempt,
      workerId: options.workerId,
      scopeFile: options.scopeFile,
      phase: "waiting_for_candidate",
      pipelines: [],
      candidateCommit: null,
      goalBaseCommit: null,
      acceptedCommit: null,
      review: null,
      reviewEvidence: {},
      blocker: null,
      updatedAt: nowIso(),
    };
    validateWorker(worker);
    validateManagedWorktree(root, worker);
    validateIntegration(integration, worker);
    writeAttemptPair(root, paths, worker, integration);
    atomicWriteJson(
      root,
      pointerPath(options.workerId),
      {
        version: 2,
        workerId: options.workerId,
        runId: state.runId,
        worker: paths.worker,
        integration: paths.integration,
      },
      { createOnly: true },
    );
    slice.attempts.push({
      number: attempt,
      workerId: options.workerId,
      worker: paths.worker,
      integration: paths.integration,
    });
    atomicWriteJson(root, indexPath(state.runId), current);
    return {
      worker,
      integration,
      workerPath: paths.worker,
      integrationPath: paths.integration,
    };
  });
}

function migrateLegacyTracking(root, legacy) {
  assertWorkerId(legacy.workerId);
  assertSafeRelativePath(legacy.state, "legacy worker state path");
  assertSafeRelativePath(legacy.scopeFile, "legacy worker scope path");
  assertCommit(legacy.baseCommit, "legacy worker baseCommit");
  assertCommit(legacy.candidateCommit, "legacy worker candidateCommit", true);
  validateManagedWorktree(root, legacy);
  const { state } = ensureRunTracking(root, legacy.state);
  if (
    legacy.runId !== state.runId ||
    state.slices[legacy.slice]?.manifest !== legacy.scopeFile
  ) {
    fail("legacy worker metadata does not match run state");
  }
  return withRuntimeLock(root, indexLockPath(state.runId), () => {
    const pointer = readJson(
      root,
      pointerPath(legacy.workerId),
      "worker tracking pointer",
    );
    if (pointer.version === 2) return pointer;
    const current = readJson(
      root,
      indexPath(state.runId),
      "runtime tracking index",
    );
    validateIndex(current, state, legacy.state);
    const trackedSlice = current.slices[legacy.slice];
    if (trackedSlice.attempts.length) {
      const reference = trackedSlice.attempts[0];
      if (
        trackedSlice.attempts.length !== 1 ||
        reference.workerId !== legacy.workerId
      ) {
        fail(
          `legacy worker ${legacy.workerId} conflicts with existing attempt tracking`,
        );
      }
      const nextPointer = {
        version: 2,
        workerId: legacy.workerId,
        runId: state.runId,
        worker: reference.worker,
        integration: reference.integration,
      };
      atomicWriteJson(root, pointerPath(legacy.workerId), nextPointer);
      return nextPointer;
    }
    const paths = attemptPaths(state.runId, legacy.slice, 1);
    const worker = {
      version: 1,
      role: "worker",
      runId: state.runId,
      state: legacy.state,
      slice: legacy.slice,
      attempt: 1,
      workerId: legacy.workerId,
      scopeFile: legacy.scopeFile,
      baseCommit: legacy.baseCommit,
      worktree: legacy.worktree,
      phase:
        legacy.status === "candidate" || legacy.status === "accepted"
          ? "candidate_ready"
          : "worktree_ready",
      pipelines: [],
      candidateCommit: legacy.candidateCommit,
      retryOffset: legacy.retryCount ?? 0,
      blocker: null,
      updatedAt: nowIso(),
    };
    const integration = {
      version: 1,
      role: "integration",
      runId: state.runId,
      state: legacy.state,
      slice: legacy.slice,
      attempt: 1,
      workerId: legacy.workerId,
      scopeFile: legacy.scopeFile,
      phase:
        legacy.status === "accepted"
          ? "accepted"
          : legacy.candidateCommit
            ? "candidate_verified"
            : "waiting_for_candidate",
      pipelines: [],
      candidateCommit: legacy.candidateCommit,
      goalBaseCommit: null,
      acceptedCommit: legacy.acceptedCommit ?? null,
      review: null,
      reviewEvidence: legacy.reviewEvidence ?? {},
      candidateHistory: legacy.candidateHistory ?? [],
      blocker: null,
      updatedAt: nowIso(),
    };
    validateWorker(worker);
    validateManagedWorktree(root, worker);
    validateIntegration(integration, worker);
    if (
      existsSync(resolve(root, paths.worker)) ||
      existsSync(resolve(root, paths.integration))
    ) {
      const existingWorker = validateWorker(
        readJson(root, paths.worker, "worker tracking file"),
      );
      const existingIntegration = validateIntegration(
        readJson(root, paths.integration, "integration tracking file"),
        existingWorker,
      );
      if (
        existingWorker.workerId !== legacy.workerId ||
        existingIntegration.workerId !== legacy.workerId
      ) {
        fail(`legacy worker ${legacy.workerId} conflicts with attempt files`);
      }
    } else {
      writeAttemptPair(root, paths, worker, integration);
    }
    const nextPointer = {
      version: 2,
      workerId: legacy.workerId,
      runId: state.runId,
      worker: paths.worker,
      integration: paths.integration,
    };
    atomicWriteJson(root, pointerPath(legacy.workerId), nextPointer);
    trackedSlice.attempts.push({
      number: 1,
      workerId: legacy.workerId,
      worker: paths.worker,
      integration: paths.integration,
    });
    atomicWriteJson(root, indexPath(state.runId), current);
    return nextPointer;
  });
}

export function readSliceAttemptTracking(root, workerId) {
  let pointer = readJson(
    root,
    pointerPath(workerId),
    "worker tracking pointer",
  );
  if (pointer.version === 1) {
    pointer = migrateLegacyTracking(root, pointer);
  }
  if (
    pointer.version !== 2 ||
    pointer.workerId !== workerId ||
    typeof pointer.worker !== "string" ||
    typeof pointer.integration !== "string"
  ) {
    fail(`worker tracking pointer is invalid: ${pointerPath(workerId)}`);
  }
  assertSafeRelativePath(pointer.worker, "worker tracking path");
  assertSafeRelativePath(pointer.integration, "integration tracking path");
  const worker = validateWorker(
    readJson(root, pointer.worker, "worker tracking file"),
  );
  validateManagedWorktree(root, worker);
  const integration = validateIntegration(
    readJson(root, pointer.integration, "integration tracking file"),
    worker,
  );
  if (pointer.runId !== worker.runId || pointer.workerId !== worker.workerId) {
    fail("worker tracking pointer does not match its attempt");
  }
  const expected = attemptPaths(worker.runId, worker.slice, worker.attempt);
  if (
    pointer.worker !== expected.worker ||
    pointer.integration !== expected.integration
  ) {
    fail("worker tracking pointer does not reference its expected attempt");
  }
  return {
    worker,
    integration,
    workerPath: pointer.worker,
    integrationPath: pointer.integration,
  };
}

function updateAttemptFile(root, workerId, role, mutate) {
  const tracking = readSliceAttemptTracking(root, workerId);
  const path =
    role === "worker" ? tracking.workerPath : tracking.integrationPath;
  const lockPath = `${path}.lock`;
  return withRuntimeLock(root, lockPath, () => {
    const currentTracking = readSliceAttemptTracking(root, workerId);
    const current =
      role === "worker" ? currentTracking.worker : currentTracking.integration;
    const updated = mutate({ ...current, pipelines: [...current.pipelines] });
    updated.updatedAt = nowIso();
    if (role === "worker") validateWorker(updated);
    else validateIntegration(updated, currentTracking.worker);
    atomicWriteJson(root, path, updated);
    return updated;
  });
}

export function updateWorkerTracking(root, workerId, phase, fields = {}) {
  if (!workerPhases.includes(phase)) fail(`unknown worker phase: ${phase}`);
  return updateAttemptFile(root, workerId, "worker", (worker) => {
    if (fields.candidateCommit !== undefined) {
      assertCommit(fields.candidateCommit, "worker candidateCommit", true);
    }
    if (phase === "candidate_ready") {
      const latestPipeline = worker.pipelines.at(-1);
      if (
        worker.phase !== "pipeline_passed" ||
        !latestPipeline ||
        latestPipeline.status !== "passed" ||
        !fields.candidateCommit
      ) {
        fail(
          "candidate_ready requires a passed tracked worker pipeline and candidate commit",
        );
      }
    }
    if (phase === "implementing" && worker.phase !== "preflight_passed") {
      fail("implementing requires a passed scope preflight");
    }
    return { ...worker, ...fields, phase };
  });
}

export function updateIntegrationTracking(root, workerId, phase, fields = {}) {
  if (!integrationPhases.includes(phase)) {
    fail(`unknown integration phase: ${phase}`);
  }
  return updateAttemptFile(root, workerId, "integration", (integration) => {
    if (fields.candidateCommit !== undefined) {
      assertCommit(fields.candidateCommit, "integration candidateCommit", true);
    }
    if (fields.goalBaseCommit !== undefined) {
      assertCommit(fields.goalBaseCommit, "integration goalBaseCommit", true);
    }
    if (fields.acceptedCommit !== undefined) {
      assertCommit(fields.acceptedCommit, "integration acceptedCommit", true);
    }
    if (
      phase === "candidate_applied" &&
      (integration.phase !== "integration_claimed" ||
        !fields.candidateCommit ||
        !fields.goalBaseCommit)
    ) {
      fail(
        "candidate_applied requires the matching claimed candidate and goal base",
      );
    }
    if (
      phase === "review_approved" &&
      (integration.phase !== "review_running" ||
        fields.review?.status !== "APPROVED")
    ) {
      fail("review_approved requires a tracked approved review result");
    }
    if (
      phase === "accepted" &&
      (!["pipeline_passed", "review_approved"].includes(integration.phase) ||
        !fields.acceptedCommit ||
        !fields.review)
    ) {
      fail("accepted requires review evidence and an accepted commit");
    }
    if (phase === "cleanup_completed" && integration.phase !== "accepted") {
      fail("cleanup_completed requires an accepted integration attempt");
    }
    return { ...integration, ...fields, phase };
  });
}

function pipelineRole(integrated) {
  return integrated ? "integration" : "worker";
}

export function beginPipelineTracking(root, workerId, options) {
  const role = pipelineRole(options.integrated);
  return updateAttemptFile(root, workerId, role, (tracking) => {
    const allowed = options.integrated
      ? new Set([
          "candidate_applied",
          "pipeline_running",
          "pipeline_failed",
          "pipeline_passed",
        ])
      : new Set([
          "preflight_passed",
          "implementing",
          "pipeline_running",
          "pipeline_failed",
          "pipeline_passed",
        ]);
    if (!allowed.has(tracking.phase)) {
      fail(
        `${role} pipeline cannot start from tracking phase ${tracking.phase}`,
      );
    }
    const pipelines = tracking.pipelines.map((pipeline) =>
      pipeline.status === "running"
        ? {
            ...pipeline,
            status: "interrupted",
            completedAt: nowIso(),
            error:
              "The previous pipeline process stopped before recording a terminal result.",
          }
        : pipeline,
    );
    pipelines.push({
      number: pipelines.length + 1,
      pipeline: options.pipeline,
      status: "running",
      completedSteps: 0,
      totalSteps: options.steps.length,
      currentStep: options.steps[0] ?? null,
      steps: options.steps.map((step) => ({ id: step, status: "pending" })),
      startedAt: nowIso(),
      completedAt: null,
      error: null,
    });
    return { ...tracking, phase: "pipeline_running", pipelines };
  });
}

export function updatePipelineStepTracking(root, workerId, options) {
  const role = pipelineRole(options.integrated);
  return updateAttemptFile(root, workerId, role, (tracking) => {
    const pipelines = [...tracking.pipelines];
    const current = pipelines.at(-1);
    if (!current || current.status !== "running") {
      fail(`no active ${role} pipeline exists for worker ${workerId}`);
    }
    const steps = current.steps.map((step) =>
      step.id === options.step
        ? {
            ...step,
            status: options.status,
            ...(options.error ? { error: options.error } : {}),
          }
        : step,
    );
    const completedSteps = steps.filter(
      (step) => step.status === "passed",
    ).length;
    const next = steps.find((step) => step.status === "pending");
    pipelines[pipelines.length - 1] = {
      ...current,
      steps,
      completedSteps,
      currentStep:
        options.status === "running" ? options.step : (next?.id ?? null),
    };
    return { ...tracking, pipelines };
  });
}

export function finishPipelineTracking(root, workerId, options) {
  const role = pipelineRole(options.integrated);
  return updateAttemptFile(root, workerId, role, (tracking) => {
    const pipelines = [...tracking.pipelines];
    const current = pipelines.at(-1);
    if (!current || current.status !== "running") {
      fail(`no active ${role} pipeline exists for worker ${workerId}`);
    }
    const status = options.passed ? "passed" : "failed";
    pipelines[pipelines.length - 1] = {
      ...current,
      status,
      currentStep: null,
      completedAt: nowIso(),
      error: options.error ?? null,
    };
    return {
      ...tracking,
      phase: options.passed ? "pipeline_passed" : "pipeline_failed",
      pipelines,
      blocker: options.passed ? null : options.error,
    };
  });
}

export function workerMetadataFromTracking(root, attempt) {
  const state = readRunState(root, attempt.worker.state);
  return {
    ...trackingMetadataWithoutController(attempt),
    controller: state.controller,
  };
}

function trackingMetadataWithoutController(attempt) {
  const { worker, integration } = attempt;
  return {
    version: 2,
    workerId: worker.workerId,
    runId: worker.runId,
    state: worker.state,
    slice: worker.slice,
    scopeFile: worker.scopeFile,
    baseCommit: worker.baseCommit,
    worktree: worker.worktree,
    status: ["accepted", "cleanup_completed"].includes(integration.phase)
      ? "accepted"
      : integration.candidateCommit
        ? "candidate"
        : "active",
    candidateCommit: integration.candidateCommit ?? worker.candidateCommit,
    acceptedCommit: integration.acceptedCommit,
    retryCount: worker.retryOffset + worker.attempt - 1,
    reviewEvidence: integration.reviewEvidence,
  };
}

export function readWorkerMetadata(root, workerId) {
  return workerMetadataFromTracking(
    root,
    readSliceAttemptTracking(root, workerId),
  );
}

export function listRunAttempts(root, statePath) {
  const { state, index, reconciliationNeeded } = readIndexForState(
    root,
    statePath,
  );
  const attempts = [];
  for (const slice of Object.keys(state.slices)) {
    for (const reference of index.slices[slice].attempts) {
      const worker = validateWorker(
        readJson(root, reference.worker, "worker tracking file"),
      );
      validateManagedWorktree(root, worker);
      const integration = validateIntegration(
        readJson(root, reference.integration, "integration tracking file"),
        worker,
      );
      if (
        worker.slice !== slice ||
        worker.attempt !== reference.number ||
        worker.workerId !== reference.workerId
      ) {
        fail(
          `runtime attempt file does not match its index for slice ${slice}`,
        );
      }
      attempts.push({
        worker,
        integration,
        workerPath: reference.worker,
        integrationPath: reference.integration,
      });
    }
  }
  return { state, index, attempts, reconciliationNeeded };
}

export function claimIntegrationAttempt(root, workerId, goalBaseCommit) {
  assertCommit(goalBaseCommit, "integration goalBaseCommit");
  const tracking = readSliceAttemptTracking(root, workerId);
  const state = readRunState(root, tracking.worker.state);
  return withRuntimeLock(root, indexLockPath(state.runId), () => {
    const current = readSliceAttemptTracking(root, workerId);
    if (
      current.integration.phase === "integration_claimed" &&
      current.integration.goalBaseCommit === goalBaseCommit
    ) {
      return current.integration;
    }
    if (current.integration.phase !== "candidate_verified") {
      fail(
        `slice ${current.worker.slice} is not ready for integration: ${current.integration.phase}`,
      );
    }
    const active = listRunAttempts(root, current.worker.state).attempts.find(
      (attempt) =>
        attempt.worker.workerId !== workerId &&
        goalMutationIntegrationPhases.has(attempt.integration.phase),
    );
    if (active) {
      fail(
        `serial integration is already owned by slice ${active.worker.slice} attempt ${active.worker.attempt}`,
      );
    }
    const updated = {
      ...current.integration,
      phase: "integration_claimed",
      goalBaseCommit,
      blocker: null,
      updatedAt: nowIso(),
    };
    validateIntegration(updated, current.worker);
    atomicWriteJson(root, current.integrationPath, updated);
    return updated;
  });
}

export function listActiveWorkerMetadata(root, statePath) {
  return listRunAttempts(root, statePath)
    .attempts.filter(
      (attempt) => !closedIntegrationPhases.has(attempt.integration.phase),
    )
    .map((attempt) => workerMetadataFromTracking(root, attempt));
}

export function primaryRepositoryRoot(cwd = process.cwd()) {
  const commonDirectory = git(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (!commonDirectory || !existsSync(commonDirectory)) {
    fail("cannot resolve the primary Git repository");
  }
  const candidate = dirname(realpathSync(commonDirectory));
  const topLevel = git(candidate, ["rev-parse", "--show-toplevel"], {
    allowFailure: true,
  });
  if (!topLevel) fail("cannot resolve the primary Git worktree");
  return realpathSync(topLevel);
}

function parseCheckpointArguments(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (
      ![
        "--worker-id",
        "--role",
        "--phase",
        "--candidate-commit",
        "--message",
      ].includes(flag)
    ) {
      fail(`unknown argument: ${flag}`);
    }
    const value = rest[index + 1];
    if (!value) fail(`${flag} requires a value`);
    options[flag.slice(2).replaceAll("-", "")] = value;
    index += 1;
  }
  if (
    command !== "checkpoint" ||
    !options.workerid ||
    !options.role ||
    !options.phase
  ) {
    fail(
      "usage: run-tracking.mjs checkpoint --worker-id <id> --role worker|integration --phase <phase> [--candidate-commit <sha>] [--message <text>]",
    );
  }
  return options;
}

function runCli(argv) {
  const options = parseCheckpointArguments(argv);
  const root = primaryRepositoryRoot();
  const tracking = readSliceAttemptTracking(root, options.workerid);
  const commandRoot = realpathSync(
    git(process.cwd(), ["rev-parse", "--show-toplevel"]),
  );
  const expectedRoot =
    options.role === "worker" ? realpathSync(tracking.worker.worktree) : root;
  if (commandRoot !== expectedRoot) {
    fail(`${options.role} checkpoint is running in the wrong worktree`);
  }
  const candidateCommit = options.candidatecommit
    ? git(commandRoot, ["rev-parse", "--verify", options.candidatecommit])
    : null;
  const fields = {
    ...(candidateCommit ? { candidateCommit } : {}),
    ...(options.message ? { blocker: options.message } : {}),
  };
  const result =
    options.role === "worker"
      ? updateWorkerTracking(root, options.workerid, options.phase, fields)
      : options.role === "integration"
        ? updateIntegrationTracking(
            root,
            options.workerid,
            options.phase,
            fields,
          )
        : fail("--role must be worker or integration");
  console.log(
    `tracking checkpoint recorded: slice ${result.slice} attempt ${result.attempt} (${result.phase})`,
  );
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`RUN TRACKING FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}

export { goalMutationIntegrationPhases, integrationPhases, workerPhases };
