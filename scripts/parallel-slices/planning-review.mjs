#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadQualityConfig } from "./project-quality.mjs";
import { renderReviewMarkdown } from "./review-artifact.mjs";
import { readRunState } from "./run-state.mjs";
import {
  assertSafeRelativePath,
  parseManifestText,
  pathMatches,
  validateManifest,
} from "./scope-policy.mjs";

function fail(message) {
  throw new Error(message);
}

function readJson(root, path, label) {
  try {
    return JSON.parse(readFileSync(resolve(root, path), "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function normalizedPlanningState(state) {
  return {
    version: state.version,
    plan: state.plan,
    planCommit: state.planCommit,
    compilation: state.compilation,
    milestone: state.milestone,
    goalBranch: state.goalBranch,
    controller: state.controller,
    runId: state.runId,
    slices: Object.fromEntries(
      Object.entries(state.slices)
        .sort(([left], [right]) =>
          left.localeCompare(right, "en", { numeric: true }),
        )
        .map(([slice, value]) => [
          slice,
          {
            manifest: value.manifest,
            reviewArtifact: value.reviewArtifact,
          },
        ]),
    ),
  };
}

function fingerprintPlanningContract(root, paths, state) {
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(`${path}\0`);
    hash.update(readFileSync(resolve(root, path)));
    hash.update("\0");
  }
  hash.update("normalized-state\0");
  hash.update(JSON.stringify(normalizedPlanningState(state)));
  return `sha256:${hash.digest("hex")}`;
}

function planningNamespace(scopeFile) {
  return scopeFile.slice(0, -"/_planning.scope".length);
}

function validatePlanningAllowlist(target) {
  const scopeDirectory = planningNamespace(target.scopeFile);
  const reviewDirectory = target.artifact.slice(0, -"/planning.json".length);
  const feature = scopeDirectory.split("/").at(-1);
  const expectedReviewDirectory = `docs/plans/reviews/${feature}`;
  if (reviewDirectory !== expectedReviewDirectory) {
    fail(
      `planning-review artifact must share the scope namespace: ${expectedReviewDirectory}`,
    );
  }
  const permitted = new Set([
    ".parallel-slices/review.json",
    target.state.plan,
    target.statePath,
    target.scopeFile,
    `${scopeDirectory}/**`,
    target.artifact,
    target.artifactMarkdown,
    `docs/plans/corrections/${feature}/**`,
  ]);
  const unexpected = target.manifest.allow.filter(
    (pattern) => !permitted.has(pattern),
  );
  if (unexpected.length) {
    fail(
      `planning-review scope contains paths outside its planning namespace: ${unexpected.join(", ")}`,
    );
  }
}

export function readPlanningReviewTarget(root, statePath) {
  assertSafeRelativePath(statePath, "planning-review run state");
  const state = readRunState(root, statePath);
  const planningReview = state.compilation?.planningReview;
  if (!planningReview) {
    fail("run-state compilation is missing planningReview");
  }
  const scopeFile = planningReview.scope;
  const artifact = planningReview.artifact;
  for (const [label, path] of [
    ["planning-review scope", scopeFile],
    ["planning-review artifact", artifact],
  ]) {
    assertSafeRelativePath(path, label);
  }
  if (!/^docs\/plans\/scopes\/[^/]+\/_planning\.scope$/.test(scopeFile)) {
    fail("planning-review scope must end in /_planning.scope");
  }
  if (!/^docs\/plans\/reviews\/[^/]+\/planning\.json$/.test(artifact)) {
    fail("planning-review artifact must end in /planning.json");
  }
  if (!existsSync(resolve(root, scopeFile))) {
    fail(`planning-review scope does not exist: ${scopeFile}`);
  }
  const manifest = parseManifestText(
    readFileSync(resolve(root, scopeFile), "utf8"),
  );
  validateManifest(manifest, scopeFile, root, loadQualityConfig(root));
  if (
    manifest.version !== "1" ||
    manifest.slice !== "planning" ||
    manifest.plan !== state.plan ||
    manifest.state !== statePath ||
    manifest.review !== artifact
  ) {
    fail("planning-review scope does not match its run state and Product Plan");
  }

  const manifestPaths = Object.values(state.slices)
    .map((value) => value.manifest)
    .sort();
  const correctionPaths = [];
  const requirementIds = new Set();
  for (const path of manifestPaths) {
    if (!existsSync(resolve(root, path))) {
      fail(`planning-review slice manifest does not exist: ${path}`);
    }
    const sliceManifest = parseManifestText(
      readFileSync(resolve(root, path), "utf8"),
    );
    if (
      sliceManifest.plan !== state.plan ||
      sliceManifest.state !== statePath
    ) {
      fail(`planning-review slice manifest does not match state: ${path}`);
    }
    for (const requirement of sliceManifest.requirements.split(",")) {
      requirementIds.add(requirement);
    }
    if (sliceManifest.correction)
      correctionPaths.push(sliceManifest.correction);
  }
  const expectedRequirements = [...requirementIds].sort().join(",");
  const actualRequirements = manifest.requirements.split(",").sort().join(",");
  if (actualRequirements !== expectedRequirements) {
    fail("planning-review scope requirements do not cover every active slice");
  }
  const contractPaths = [
    ".parallel-slices/review.json",
    state.plan,
    scopeFile,
    ...manifestPaths,
    ...correctionPaths.sort(),
  ];
  for (const path of contractPaths) {
    if (!existsSync(resolve(root, path))) {
      fail(`planning-review contract path does not exist: ${path}`);
    }
    if (!pathMatches(path, manifest.allow)) {
      fail(`planning-review scope does not allow contract path: ${path}`);
    }
  }
  if (!pathMatches(statePath, manifest.allow)) {
    fail(`planning-review scope does not allow run state: ${statePath}`);
  }
  const target = {
    artifact,
    artifactMarkdown: artifact.replace(/\.json$/, ".md"),
    contractFingerprint: fingerprintPlanningContract(
      root,
      contractPaths,
      state,
    ),
    manifest,
    reviewPaths: [
      ...new Set([
        ".parallel-slices/review.json",
        scopeFile,
        statePath,
        ...manifestPaths,
        ...correctionPaths,
      ]),
    ],
    scopeFile,
    state,
    statePath,
  };
  validatePlanningAllowlist(target);
  return target;
}

export function validatePlanningReviewEvidence(root, statePath) {
  const target = readPlanningReviewTarget(root, statePath);
  if (!existsSync(resolve(root, target.artifact))) {
    fail(
      `approved planning review is missing: ${target.artifact}; run review.mjs planning --state ${statePath}`,
    );
  }
  if (!existsSync(resolve(root, target.artifactMarkdown))) {
    fail(
      `planning-review Markdown view is missing: ${target.artifactMarkdown}`,
    );
  }
  const ledger = readJson(root, target.artifact, "planning-review artifact");
  if (
    ledger.scopeFile !== target.scopeFile ||
    ledger.slice !== "planning" ||
    JSON.stringify(ledger.requirements) !==
      JSON.stringify(target.manifest.requirements.split(",")) ||
    !Array.isArray(ledger.attempts)
  ) {
    fail("planning-review artifact belongs to a different planning contract");
  }
  const latest = ledger.attempts.at(-1);
  if (
    !latest ||
    latest.reviewKind !== "planning" ||
    latest.status !== "approved"
  ) {
    fail("latest planning-review attempt is not approved");
  }
  if (latest.contractFingerprint !== target.contractFingerprint) {
    fail(
      "planning-review approval is stale for the active execution map; rerun the planning review",
    );
  }
  if (!latest.rounds?.length || !latest.configuration?.reviewers?.length) {
    fail("planning-review approval has no independent reviewer evidence");
  }
  if (!latest.completedAt || !latest.providers) {
    fail("planning-review approval is missing terminal provider evidence");
  }
  const reviewerIds = latest.configuration.reviewers.map(
    (reviewer) => reviewer.id,
  );
  if (
    reviewerIds.some((id) => typeof id !== "string" || !id) ||
    new Set(reviewerIds).size !== reviewerIds.length
  ) {
    fail("planning-review approval has invalid reviewer identities");
  }
  const finalTurns = latest.rounds.at(-1)?.turns ?? [];
  const finalReviewerIds = finalTurns.map((turn) => turn.reviewerId);
  if (
    JSON.stringify(finalReviewerIds) !== JSON.stringify(reviewerIds) ||
    finalTurns.some((turn) => turn.verdict !== "approve")
  ) {
    fail("planning-review approval lacks unanimous final-round evidence");
  }
  for (const turn of finalTurns) {
    if (!latest.providers[turn.provider]?.version) {
      fail(
        `planning-review approval lacks provider evidence: ${turn.provider}`,
      );
    }
  }
  const blocking = (latest.findings ?? []).filter(
    (finding) =>
      finding.status === "open" &&
      new Set(["critical", "high"]).has(finding.severity),
  );
  if (blocking.length) {
    fail("planning-review approval retains an open blocking finding");
  }
  if (
    JSON.stringify([...(latest.changedPaths ?? [])].sort()) !==
    JSON.stringify([...target.reviewPaths].sort())
  ) {
    fail("planning-review approval does not cover the active planning paths");
  }
  const markdown = readFileSync(resolve(root, target.artifactMarkdown), "utf8");
  if (markdown !== renderReviewMarkdown(ledger)) {
    fail("planning-review Markdown view does not match its JSON ledger");
  }
  return { ledger, target, attempt: latest };
}

function repositoryRoot() {
  try {
    return realpathSync(process.cwd());
  } catch {
    fail("cannot resolve repository root");
  }
}

function runCli(argv) {
  const [command, stateFlag, statePath] = argv;
  if (
    command !== "verify" ||
    stateFlag !== "--state" ||
    !statePath ||
    argv.length !== 3
  ) {
    fail("usage: planning-review.mjs verify --state <state-path>");
  }
  const result = validatePlanningReviewEvidence(repositoryRoot(), statePath);
  console.log(
    `planning review approved: ${result.target.artifact} (${result.attempt.contractFingerprint})`,
  );
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`PLANNING REVIEW FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
