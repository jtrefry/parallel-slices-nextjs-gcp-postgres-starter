#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  acquireReviewLock,
  assertNoReviewTemporaries,
  beginReviewAttempt,
  loadReviewLedger,
  releaseReviewLock,
  resolveReviewArtifactPaths,
  writeReviewLedger,
} from "./review-artifact.mjs";
import { loadReviewConfig } from "./review-config.mjs";
import { readPlanningReviewTarget } from "./planning-review.mjs";
import {
  invokeProvider,
  preflightProvider,
  providerRecoveryText,
} from "./review-providers.mjs";
import {
  calculateRepositoryFingerprint,
  createReviewSnapshot,
  writeSnapshotPacket,
} from "./review-snapshot.mjs";
import {
  applyReviewerResponse,
  evaluateConsensus,
  openFindingIds,
  reviewPacketMarkdown,
} from "./review-state.mjs";
import { loadQualityConfig } from "./project-quality.mjs";
import {
  primaryRepositoryRoot,
  readSliceAttemptTracking,
  updateIntegrationTracking,
} from "./run-tracking.mjs";
import {
  assertSafeRelativePath,
  parseManifestText,
  pathMatches,
  requireCommittedContract,
  validateManifest,
  workingChangedFiles,
} from "./scope-policy.mjs";

const recoverableAuthCodes = new Set([
  "AUTH_REQUIRED",
  "CLI_NOT_INSTALLED",
  "INTERACTIVE_SETUP_REQUIRED",
]);

const exitCodes = Object.freeze({
  APPROVED: 0,
  CHANGES_REQUESTED: 10,
  AUTH_REQUIRED: 20,
  CLI_NOT_INSTALLED: 20,
  INTERACTIVE_SETUP_REQUIRED: 20,
  BILLING_MISMATCH: 20,
  QUOTA_EXHAUSTED: 21,
  STALE: 22,
  AUTH_CHECK_TIMEOUT: 23,
  PROVIDER_TIMEOUT: 23,
  PROVIDER_OUTPUT_LIMIT: 24,
  INVALID_RESPONSE: 24,
  PROVIDER_ERROR: 24,
  MODEL_NOT_AVAILABLE: 24,
  AUTH_STATUS_UNKNOWN: 24,
  INTERNAL_ERROR: 1,
});

class ReviewStop extends Error {
  constructor(problem) {
    super(problem.message);
    this.problem = problem;
  }
}

function gitRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("multi-agent review must run inside a Git repository");
  }
}

function nowIso() {
  return new Date().toISOString();
}

export function parseReviewArguments(argv) {
  if (argv[0] === "validate") {
    if (argv.length !== 1)
      throw new Error("validate does not accept arguments");
    return { command: "validate" };
  }
  if (argv[0] === "planning") {
    const options = {
      command: "planning",
      nonInteractive: false,
    };
    for (let index = 1; index < argv.length; index += 1) {
      const argument = argv[index];
      if (argument === "--non-interactive") options.nonInteractive = true;
      else if (argument === "--state") {
        const value = argv[index + 1];
        if (!value) throw new Error("--state requires a value");
        options.state = value.replace(/^\.\//, "");
        index += 1;
      } else throw new Error(`unknown planning-review argument: ${argument}`);
    }
    if (!options.state) throw new Error("planning requires --state");
    return options;
  }
  const args = argv[0] === "run" ? argv.slice(1) : argv;
  const options = { command: "run", nonInteractive: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--non-interactive") options.nonInteractive = true;
    else if (argument === "--scope-file" || argument === "--worker-id") {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === "--scope-file") {
        options.scopeFile = value.replace(/^\.\//, "");
      } else {
        options.workerId = value;
      }
      index += 1;
    } else throw new Error(`unknown review argument: ${argument}`);
  }
  if (!options.scopeFile) throw new Error("--scope-file is required");
  return options;
}

async function defaultWaitForUser(problem, waitSeconds) {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let timeout;
  try {
    const answer = await Promise.race([
      readline.question(
        "Return here and press Enter to retry, or type q then Enter to abort: ",
      ),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `authentication wait expired after ${waitSeconds} seconds`,
              ),
            ),
          waitSeconds * 1000,
        );
      }),
    ]);
    if (answer.trim().toLowerCase() === "q") {
      throw new Error(`${problem.label} authentication was cancelled`);
    }
  } finally {
    clearTimeout(timeout);
    readline.close();
  }
}

function printRecovery(problem, waitSeconds) {
  console.error(`\nREVIEW PAUSED: ${problem.code}`);
  console.error(providerRecoveryText(problem));
  console.error(`The runner will wait up to ${waitSeconds} seconds.`);
  console.error(
    "Never paste credentials or tokens into this terminal or the review artifact.\n",
  );
}

async function requireProviderReady(provider, context) {
  let latest;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    latest = await preflightProvider(provider, {
      root: context.root,
      billingPolicy: context.config.billingPolicy,
      models: context.modelsByProvider.get(provider) || [],
      runProcess: context.runProcess,
    });
    if (latest.ok) return latest;
    if (!recoverableAuthCodes.has(latest.code) || !context.interactive) {
      throw new ReviewStop(latest);
    }
    printRecovery(latest, context.config.authWaitSeconds);
    try {
      await context.waitForUser(latest, context.config.authWaitSeconds);
    } catch (error) {
      throw new ReviewStop({
        ...latest,
        code: "AUTH_REQUIRED",
        message: `${latest.label} authentication did not resume: ${error.message}`,
      });
    }
  }
  throw new ReviewStop({
    ...latest,
    code: "AUTH_REQUIRED",
    message: `${latest.label} did not become ready after three checks.`,
  });
}

function ensureSourceUnchanged(root, fingerprint, excludePaths) {
  const current = calculateRepositoryFingerprint(
    root,
    excludePaths,
  ).fingerprint;
  if (current !== fingerprint) {
    throw new ReviewStop({
      code: "STALE",
      provider: null,
      label: "Review source",
      message: "repository content changed while the review was running",
      instructions: [
        "Rerun the quality gate, then start a fresh review attempt.",
      ],
    });
  }
}

function terminalAttempt(attempt, status, outcome, now) {
  attempt.status = status;
  attempt.outcome = outcome;
  attempt.completedAt = now;
  attempt.activeReviewer = null;
}

function problemExitCode(problem) {
  return exitCodes[problem.code] ?? exitCodes.INTERNAL_ERROR;
}

async function executeReviewLoop(context) {
  const reviewerIds = context.reviewers.map((reviewer) => reviewer.id);
  let consumedProviderMs = 0;
  for (
    let roundNumber = 1;
    roundNumber <= context.config.maxRounds;
    roundNumber += 1
  ) {
    const round = {
      number: roundNumber,
      startedAt: context.now(),
      completedAt: null,
      turns: [],
      consensus: null,
    };
    context.attempt.rounds.push(round);
    for (const reviewer of context.reviewers) {
      const expectedFindingIds = openFindingIds(context.attempt);
      writeSnapshotPacket(
        context.snapshot,
        reviewPacketMarkdown({
          attempt: context.attempt,
          manifest: context.manifest,
          reviewer,
          roundNumber,
          scopeFile: context.scopeFile,
          snapshot: context.snapshot,
          reviewKind: context.reviewKind,
        }),
      );
      context.attempt.activeReviewer = reviewer.id;
      writeReviewLedger(context.root, context.paths, context.ledger);
      console.log(
        `review round ${roundNumber}/${context.config.maxRounds}: ${reviewer.id} (${reviewer.provider})`,
      );

      let invocation;
      for (let authAttempt = 1; authAttempt <= 3; authAttempt += 1) {
        const remainingMs =
          context.config.overallTimeoutSeconds * 1000 - consumedProviderMs;
        if (remainingMs <= 0) {
          throw new ReviewStop({
            code: "PROVIDER_TIMEOUT",
            provider: reviewer.provider,
            label: reviewer.id,
            message: "the overall review provider-time budget was exhausted",
            instructions: [],
          });
        }
        invocation = await invokeProvider({
          reviewer,
          root: context.root,
          snapshot: context.snapshot,
          scratchRoot: context.scratchRoot,
          timeoutMs: Math.min(
            context.config.turnTimeoutSeconds * 1000,
            remainingMs,
          ),
          billingPolicy: context.config.billingPolicy,
          expectedFindingIds,
          runProcess: context.runProcess,
        });
        consumedProviderMs +=
          invocation.result?.durationMs ?? invocation.durationMs ?? 0;
        if (invocation.ok) break;
        if (
          !recoverableAuthCodes.has(invocation.problem.code) ||
          !context.interactive
        ) {
          throw new ReviewStop(invocation.problem);
        }
        context.attempt.status = "waiting_for_auth";
        writeReviewLedger(context.root, context.paths, context.ledger);
        printRecovery(invocation.problem, context.config.authWaitSeconds);
        try {
          await context.waitForUser(
            invocation.problem,
            context.config.authWaitSeconds,
          );
        } catch (error) {
          throw new ReviewStop({
            ...invocation.problem,
            code: "AUTH_REQUIRED",
            message: `${invocation.problem.label} authentication did not resume: ${error.message}`,
          });
        }
        const ready = await requireProviderReady(reviewer.provider, context);
        reviewer.version = ready.version;
        ensureSourceUnchanged(
          context.root,
          context.attempt.fingerprint,
          context.excludePaths,
        );
        context.attempt.status = "in_progress";
        writeReviewLedger(context.root, context.paths, context.ledger);
      }
      if (!invocation?.ok) throw new ReviewStop(invocation.problem);
      applyReviewerResponse(
        context.attempt,
        round,
        reviewer,
        invocation.response,
        invocation.durationMs,
        reviewerIds,
      );
      context.attempt.activeReviewer = null;
      ensureSourceUnchanged(
        context.root,
        context.attempt.fingerprint,
        context.excludePaths,
      );
      writeReviewLedger(context.root, context.paths, context.ledger);
    }
    round.completedAt = context.now();
    round.consensus = evaluateConsensus(context.attempt, round, reviewerIds);
    writeReviewLedger(context.root, context.paths, context.ledger);
    if (round.consensus.approved) {
      terminalAttempt(
        context.attempt,
        "approved",
        `All configured reviewers approved in round ${roundNumber} with no open critical or high findings.`,
        context.now(),
      );
      writeReviewLedger(context.root, context.paths, context.ledger);
      return { status: "APPROVED", exitCode: exitCodes.APPROVED };
    }
  }

  const unresolved = context.attempt.findings
    .filter((finding) => finding.status === "open")
    .map((finding) => finding.id);
  terminalAttempt(
    context.attempt,
    "changes_requested",
    unresolved.length
      ? `Consensus was not reached; unresolved findings: ${unresolved.join(", ")}.`
      : "Consensus was not reached within the configured round limit.",
    context.now(),
  );
  writeReviewLedger(context.root, context.paths, context.ledger);
  return {
    status: "CHANGES_REQUESTED",
    exitCode: exitCodes.CHANGES_REQUESTED,
    unresolved,
  };
}

export async function runMultiAgentReview(options) {
  const root = realpathSync(options.root ?? gitRoot(process.cwd()));
  const config = loadReviewConfig(root);
  if (!config.enabled) {
    throw new Error(
      "multi-agent review is disabled; configure reviewers and set enabled=true in .parallel-slices/review.json",
    );
  }
  const scopeFile = options.scopeFile;
  assertSafeRelativePath(scopeFile, "scope manifest");
  if (!/^docs\/plans\/scopes\/.+\.scope$/.test(scopeFile)) {
    throw new Error(
      "scope manifest must be a .scope file under docs/plans/scopes",
    );
  }
  const scopePath = resolve(root, scopeFile);
  const manifest = parseManifestText(readFileSync(scopePath, "utf8"));
  const qualityConfig = loadQualityConfig(root);
  validateManifest(manifest, scopeFile, root, qualityConfig);
  requireCommittedContract(root, [manifest.plan, scopeFile]);
  const paths = resolveReviewArtifactPaths(manifest);
  const reviewArtifactPatterns =
    manifest.version === "2" ? manifest.coordinate : manifest.allow;
  if (
    !pathMatches(paths.json, reviewArtifactPatterns) ||
    !pathMatches(paths.markdown, reviewArtifactPatterns)
  ) {
    throw new Error(
      `scope manifest must ${manifest.version === "2" ? "coordinate" : "allow"} both permanent review artifacts`,
    );
  }

  const interactive =
    options.interactive ??
    (!options.nonInteractive && process.stdin.isTTY && process.stdout.isTTY);
  const baseContext = {
    root,
    config,
    interactive,
    runProcess: options.runProcess,
    waitForUser: options.waitForUser ?? defaultWaitForUser,
    modelsByProvider: new Map(
      [...new Set(config.reviewers.map((item) => item.provider))].map(
        (provider) => [
          provider,
          [
            ...new Set(
              config.reviewers
                .filter((item) => item.provider === provider)
                .map((item) => item.model)
                .filter(Boolean),
            ),
          ],
        ],
      ),
    ),
  };
  const lock = acquireReviewLock(root, paths);
  const preflights = new Map();
  let snapshot;
  let scratchRoot;
  let ledgerContext;
  let attempt;
  const now = options.now ?? nowIso;
  try {
    assertNoReviewTemporaries(root, paths);
    for (const provider of [
      ...new Set(config.reviewers.map((item) => item.provider)),
    ]) {
      preflights.set(
        provider,
        await requireProviderReady(provider, baseContext),
      );
    }

    const ownedPatterns =
      manifest.version === "2"
        ? [...manifest.allow, ...manifest.coordinate]
        : manifest.allow;
    const changed = (
      options.reviewablePaths ??
      workingChangedFiles(root, options.base ?? "HEAD")
    ).filter((path) => path !== lock.relativePath);
    const outside = changed.filter((path) => !pathMatches(path, ownedPatterns));
    if (outside.length) {
      throw new Error(
        `changed paths outside slice ${manifest.slice}:\n${outside.map((path) => `  ${path}`).join("\n")}`,
      );
    }
    const coordinateChanged =
      manifest.version === "2"
        ? changed.filter((path) => pathMatches(path, manifest.coordinate))
        : [];
    const excludePaths = [
      ...new Set([
        paths.json,
        paths.markdown,
        lock.relativePath,
        ...coordinateChanged,
      ]),
    ];
    const reviewableChanged = changed.filter(
      (path) => !excludePaths.includes(path),
    );
    if (reviewableChanged.length === 0) {
      throw new Error(
        "there are no changed files to review after excluding review artifacts",
      );
    }

    snapshot = createReviewSnapshot(root, {
      excludePaths,
      changedPaths: reviewableChanged,
      base: options.base,
    });
    scratchRoot = mkdtempSync(
      resolve(tmpdir(), "parallel-slices-review-output-"),
    );
    ledgerContext = loadReviewLedger(root, scopeFile, manifest, config, now());
    attempt = beginReviewAttempt(
      ledgerContext.ledger,
      snapshot.fingerprint,
      reviewableChanged,
      ledgerContext.ledger.configuration,
      now(),
    );
    attempt.reviewKind = options.reviewKind ?? "slice";
    if (options.contractFingerprint) {
      attempt.contractFingerprint = options.contractFingerprint;
    }
    attempt.providers = Object.fromEntries(
      [...preflights.entries()].map(([provider, status]) => [
        provider,
        {
          version: status.version,
          authKind: status.authKind,
          billingMode: status.billingMode,
        },
      ]),
    );
    writeReviewLedger(root, ledgerContext.paths, ledgerContext.ledger);
    const reviewers = config.reviewers.map((reviewer) => ({
      ...reviewer,
      version: preflights.get(reviewer.provider).version,
    }));
    const result = await executeReviewLoop({
      ...baseContext,
      reviewers,
      manifest,
      scopeFile,
      snapshot,
      scratchRoot,
      ledger: ledgerContext.ledger,
      paths: ledgerContext.paths,
      attempt,
      excludePaths,
      now,
      reviewKind: options.reviewKind ?? "slice",
    });
    return { ...result, paths: ledgerContext.paths };
  } catch (error) {
    const problem =
      error instanceof ReviewStop
        ? error.problem
        : {
            code: "INTERNAL_ERROR",
            message: error.message,
          };
    if (attempt && ledgerContext) {
      terminalAttempt(
        attempt,
        problem.code.toLowerCase(),
        problem.message,
        now(),
      );
      writeReviewLedger(root, ledgerContext.paths, ledgerContext.ledger);
    }
    if (error instanceof ReviewStop) {
      return {
        status: problem.code,
        exitCode: problemExitCode(problem),
        ...(ledgerContext ? { paths: ledgerContext.paths } : {}),
      };
    }
    throw error;
  } finally {
    if (snapshot?.snapshotRoot)
      rmSync(snapshot.snapshotRoot, { recursive: true, force: true });
    if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
    releaseReviewLock(lock);
  }
}

async function main(argv) {
  const options = parseReviewArguments(argv);
  const root = gitRoot(process.cwd());
  if (options.command === "validate") {
    const config = loadReviewConfig(root);
    console.log(
      `review configuration valid: ${config.enabled ? `${config.reviewers.length} reviewer(s)` : "disabled"}`,
    );
    return 0;
  }
  if (options.command === "planning") {
    const target = readPlanningReviewTarget(root, options.state);
    requireCommittedContract(root, [
      target.state.plan,
      target.statePath,
      ...target.reviewPaths,
    ]);
    const result = await runMultiAgentReview({
      root,
      scopeFile: target.scopeFile,
      nonInteractive: options.nonInteractive,
      base: target.state.planCommit,
      contractFingerprint: target.contractFingerprint,
      reviewKind: "planning",
      reviewablePaths: target.reviewPaths,
    });
    console.log(`PARALLEL SLICES PLANNING REVIEW ${result.status}`);
    if (result.paths) {
      console.log(`review JSON: ${result.paths.json}`);
      console.log(`review Markdown: ${result.paths.markdown}`);
    }
    if (result.unresolved?.length) {
      console.log(`unresolved findings: ${result.unresolved.join(", ")}`);
    }
    return result.exitCode;
  }
  let trackingRoot;
  if (options.workerId) {
    trackingRoot = primaryRepositoryRoot(root);
    if (realpathSync(root) !== trackingRoot) {
      throw new Error("tracked review must run from the integration worktree");
    }
    const tracking = readSliceAttemptTracking(trackingRoot, options.workerId);
    if (tracking.worker.scopeFile !== options.scopeFile) {
      throw new Error(
        "worker tracking does not match the requested review scope manifest",
      );
    }
    const latestIntegratedPipeline = tracking.integration.pipelines.at(-1);
    if (
      !["pipeline_passed", "review_running"].includes(
        tracking.integration.phase,
      ) ||
      !latestIntegratedPipeline ||
      latestIntegratedPipeline.status !== "passed"
    ) {
      throw new Error(
        "tracked review requires a passed integrated pipeline for this candidate",
      );
    }
    updateIntegrationTracking(trackingRoot, options.workerId, "review_running");
  }
  let result;
  try {
    result = await runMultiAgentReview({
      root,
      scopeFile: options.scopeFile,
      nonInteractive: options.nonInteractive,
    });
  } catch (error) {
    if (options.workerId) {
      updateIntegrationTracking(
        trackingRoot,
        options.workerId,
        "review_failed",
        { blocker: error.message.slice(0, 500) },
      );
    }
    throw error;
  }
  if (options.workerId) {
    updateIntegrationTracking(
      trackingRoot,
      options.workerId,
      result.status === "APPROVED" ? "review_approved" : "review_failed",
      {
        review: { status: result.status, artifact: result.paths?.json ?? null },
        blocker:
          result.status === "APPROVED"
            ? null
            : `Review stopped with status ${result.status}`,
      },
    );
  }
  console.log(`PARALLEL SLICES REVIEW ${result.status}`);
  if (result.paths) {
    console.log(`review JSON: ${result.paths.json}`);
    console.log(`review Markdown: ${result.paths.markdown}`);
  }
  if (result.unresolved?.length) {
    console.log(`unresolved findings: ${result.unresolved.join(", ")}`);
  }
  return result.exitCode;
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(`PARALLEL SLICES REVIEW FAILED: ${error.message}`);
      process.exitCode = 1;
    });
}

export { exitCodes as reviewExitCodes };
