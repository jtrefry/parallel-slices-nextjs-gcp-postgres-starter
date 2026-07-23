#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertAgentEnabled } from "./agent-profile.mjs";
import {
  assertBranchAllowed,
  loadQualityConfig,
  resolveSliceCompilation,
  sliceSizingStrategies,
} from "./project-quality.mjs";
import { assertSafeRelativePath } from "./scope-policy.mjs";
import { sha256 } from "./slice-compilation.mjs";

export const runStatuses = Object.freeze([
  "not_started",
  "in_progress",
  "pull_request_ready",
  "blocked",
  "failed",
  "finished",
]);
export const sliceStatuses = Object.freeze([
  "not_started",
  "in_progress",
  "accepted",
  "blocked",
  "failed",
]);
const successfulRunStatuses = new Set(["pull_request_ready", "finished"]);
const finalAuditEvidenceFields = Object.freeze([
  "requirements",
  "preservation",
  "gates",
  "reviews",
  "releaseFragments",
  "state",
  "nonGoals",
]);

function fail(message) {
  throw new Error(message);
}

function assertString(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required`);
}

function git(root, args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (options.allowFailure) return null;
    fail(error.stderr?.toString().trim() || `git ${args.join(" ")} failed`);
  }
}

export function assertProductPlanContent(root, path, content) {
  if (lstatSync(resolve(root, path)).isSymbolicLink()) {
    fail(`refusing symlinked Product Plan: ${path}`);
  }
  if (!/^Status: APPROVED$/m.test(content)) {
    fail(
      `Product Plan must record Status: APPROVED after explicit human approval: ${path}`,
    );
  }
  for (const compiledHeading of [
    "## Optimized execution graph",
    "## Executable slices",
  ]) {
    if (content.includes(compiledHeading)) {
      fail(
        `Product Plan must not contain compiled execution details (${compiledHeading}): ${path}`,
      );
    }
  }
}

export function validateApprovedPlanSource(state, root) {
  if (!/^[0-9a-f]{40}$/.test(state.planCommit || "")) {
    fail("run-state planCommit must be a full commit SHA");
  }
  const approved = git(root, ["show", `${state.planCommit}:${state.plan}`], {
    allowFailure: true,
  });
  if (approved === null) {
    fail(
      `run-state planCommit does not contain the Product Plan: ${state.plan}`,
    );
  }
  if (
    git(root, ["merge-base", "--is-ancestor", state.planCommit, "HEAD"], {
      allowFailure: true,
    }) === null
  ) {
    fail("run-state planCommit must be an ancestor of the current goal branch");
  }
  assertProductPlanContent(root, state.plan, approved);
  const changedAtApproval = git(
    root,
    [
      "diff-tree",
      "--root",
      "--no-commit-id",
      "--name-only",
      "-r",
      state.planCommit,
      "--",
      state.plan,
    ],
    { allowFailure: true },
  );
  if (changedAtApproval?.trim() !== state.plan) {
    fail(
      `run-state planCommit is not the Product Plan approval commit: ${state.plan}`,
    );
  }
  const current = git(root, ["show", `HEAD:${state.plan}`], {
    allowFailure: true,
  });
  if (current === null) {
    fail(`Product Plan must be committed before AI compilation: ${state.plan}`);
  }
  if (approved !== current) {
    fail(`Product Plan changed after its approved commit: ${state.plan}`);
  }
  if (readFileSync(resolve(root, state.plan), "utf8") !== approved) {
    fail(`Product Plan must be unchanged before AI compilation: ${state.plan}`);
  }
}

export function validateCompilationSource(state, root) {
  const compilation = state.compilation;
  if (
    !compilation ||
    typeof compilation !== "object" ||
    Array.isArray(compilation)
  ) {
    fail("run-state compilation must be an object");
  }
  const allowed = new Set([
    "sizingStrategy",
    "configSha256",
    "architectureManifestSha256",
    "sizingRationale",
    "parallelism",
    "planningReview",
  ]);
  const unknown = Object.keys(compilation).filter((key) => !allowed.has(key));
  if (unknown.length) {
    fail(`run-state compilation has unknown fields: ${unknown.join(", ")}`);
  }
  if (!sliceSizingStrategies.includes(compilation.sizingStrategy)) {
    fail(
      `run-state compilation sizingStrategy must be one of: ${sliceSizingStrategies.join(", ")}`,
    );
  }
  for (const field of ["configSha256", "architectureManifestSha256"]) {
    if (!/^[a-f0-9]{64}$/.test(compilation[field] || "")) {
      fail(`run-state compilation ${field} must be a SHA-256 digest`);
    }
  }
  if (
    !Array.isArray(compilation.sizingRationale) ||
    compilation.sizingRationale.length === 0 ||
    compilation.sizingRationale.some(
      (reason) =>
        typeof reason !== "string" || !reason.trim() || reason.length > 1000,
    ) ||
    new Set(compilation.sizingRationale).size !==
      compilation.sizingRationale.length
  ) {
    fail(
      "run-state compilation sizingRationale must contain unique non-empty explanations",
    );
  }
  if (state.version === 5) {
    const parallelism = compilation.parallelism;
    if (
      !parallelism ||
      typeof parallelism !== "object" ||
      Array.isArray(parallelism) ||
      Object.keys(parallelism).sort().join(",") !==
        "dependencyRationale,serialOnlyJustification"
    ) {
      fail(
        "version 5 run-state compilation parallelism must contain only dependencyRationale and serialOnlyJustification",
      );
    }
    if (!Array.isArray(parallelism.dependencyRationale)) {
      fail(
        "run-state compilation parallelism dependencyRationale must be an array",
      );
    }
    const dependencyPairs = new Set();
    for (const rationale of parallelism.dependencyRationale) {
      if (
        !rationale ||
        typeof rationale !== "object" ||
        Array.isArray(rationale) ||
        Object.keys(rationale).sort().join(",") !== "dependsOn,reason,slice" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rationale.slice || "") ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rationale.dependsOn || "") ||
        typeof rationale.reason !== "string" ||
        rationale.reason.trim().length < 20 ||
        rationale.reason.length > 1000
      ) {
        fail(
          "run-state compilation dependencyRationale entries require slice, dependsOn, and a concrete 20-1000 character reason",
        );
      }
      const pair = `${rationale.slice}\0${rationale.dependsOn}`;
      if (dependencyPairs.has(pair)) {
        fail(
          `run-state compilation has duplicate dependency rationale: ${rationale.slice} -> ${rationale.dependsOn}`,
        );
      }
      dependencyPairs.add(pair);
    }
    if (
      parallelism.serialOnlyJustification !== null &&
      (typeof parallelism.serialOnlyJustification !== "string" ||
        parallelism.serialOnlyJustification.trim().length < 80 ||
        parallelism.serialOnlyJustification.length > 2000)
    ) {
      fail(
        "run-state compilation serialOnlyJustification must be null or a concrete 80-2000 character explanation",
      );
    }
  } else if (compilation.parallelism !== undefined) {
    fail("run-state compilation parallelism requires version 5");
  }
  if (compilation.planningReview !== undefined) {
    const planningReview = compilation.planningReview;
    if (
      !planningReview ||
      typeof planningReview !== "object" ||
      Array.isArray(planningReview) ||
      Object.keys(planningReview).sort().join(",") !== "artifact,scope"
    ) {
      fail(
        "run-state compilation planningReview must contain only scope and artifact",
      );
    }
    assertSafeRelativePath(
      planningReview.scope,
      "run-state compilation planning-review scope",
    );
    assertSafeRelativePath(
      planningReview.artifact,
      "run-state compilation planning-review artifact",
    );
    if (
      !/^docs\/plans\/scopes\/[^/]+\/_planning\.scope$/.test(
        planningReview.scope,
      )
    ) {
      fail("run-state planningReview scope must end in /_planning.scope");
    }
    if (
      !/^docs\/plans\/reviews\/[^/]+\/planning\.json$/.test(
        planningReview.artifact,
      )
    ) {
      fail("run-state planningReview artifact must end in /planning.json");
    }
  }

  const configContent = git(
    root,
    ["show", `${state.planCommit}:.parallel-slices/config.json`],
    { allowFailure: true },
  );
  if (configContent === null) {
    fail("Product Plan approval commit does not contain the project config");
  }
  if (sha256(configContent) !== compilation.configSha256) {
    fail(
      "run-state compilation configSha256 does not match the Product Plan approval commit",
    );
  }
  let approvedConfig;
  try {
    approvedConfig = JSON.parse(configContent);
  } catch (error) {
    fail(
      `Product Plan approval commit has invalid project config: ${error.message}`,
    );
  }
  if (
    resolveSliceCompilation(approvedConfig).sizingStrategy !==
    compilation.sizingStrategy
  ) {
    fail(
      "run-state compilation sizingStrategy does not match the Product Plan approval commit",
    );
  }

  const architectureContent = git(
    root,
    ["show", `${state.planCommit}:.parallel-slices/architecture.json`],
    { allowFailure: true },
  );
  if (architectureContent === null) {
    fail(
      "Product Plan approval commit does not contain the selected architecture",
    );
  }
  let architecture;
  try {
    architecture = JSON.parse(architectureContent);
  } catch (error) {
    fail(
      `Product Plan approval commit has invalid selected architecture: ${error.message}`,
    );
  }
  if (architecture.manifestSha256 !== compilation.architectureManifestSha256) {
    fail(
      "run-state compilation architectureManifestSha256 does not match the Product Plan approval commit",
    );
  }
}

function validateFinalAudit(state, root) {
  const successful = successfulRunStatuses.has(state.status);
  if (!successful) {
    if (state.finalAudit !== null) {
      fail(
        "finalAudit must remain null until the run is successfully terminal",
      );
    }
    return;
  }
  const audit = state.finalAudit;
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) {
    fail(`run status ${state.status} requires structured finalAudit evidence`);
  }
  const allowed = new Set([
    "version",
    "completedAt",
    "auditedCommit",
    "acceptedSlices",
    ...finalAuditEvidenceFields,
  ]);
  const unknown = Object.keys(audit).filter((key) => !allowed.has(key));
  if (unknown.length) {
    fail(`finalAudit has unknown fields: ${unknown.join(", ")}`);
  }
  if (audit.version !== 1) fail("finalAudit version must be 1");
  if (
    typeof audit.completedAt !== "string" ||
    Number.isNaN(Date.parse(audit.completedAt)) ||
    new Date(audit.completedAt).toISOString() !== audit.completedAt
  ) {
    fail("finalAudit completedAt must be a canonical ISO timestamp");
  }
  if (!/^[0-9a-f]{40}$/.test(audit.auditedCommit || "")) {
    fail("finalAudit auditedCommit must be a full commit SHA");
  }
  const head = git(root, ["rev-parse", "HEAD"]);
  const parent = git(root, ["rev-parse", "HEAD^"], { allowFailure: true });
  if (![head.trim(), parent?.trim()].includes(audit.auditedCommit)) {
    fail(
      "finalAudit auditedCommit must be HEAD before the terminal-state commit or HEAD^ after it",
    );
  }
  const slices = Object.keys(state.slices).sort((left, right) =>
    left.localeCompare(right, "en", { numeric: true }),
  );
  if (slices.some((slice) => state.slices[slice].status !== "accepted")) {
    fail(`run status ${state.status} requires every slice to be accepted`);
  }
  if (
    !Array.isArray(audit.acceptedSlices) ||
    JSON.stringify(audit.acceptedSlices) !== JSON.stringify(slices)
  ) {
    fail("finalAudit acceptedSlices must list every slice in numeric order");
  }
  for (const field of finalAuditEvidenceFields) {
    const evidence = audit[field];
    if (
      !Array.isArray(evidence) ||
      evidence.length === 0 ||
      evidence.some(
        (item) =>
          typeof item !== "string" || !item.trim() || item.length > 2000,
      ) ||
      new Set(evidence).size !== evidence.length
    ) {
      fail(`finalAudit ${field} must contain unique non-empty evidence`);
    }
  }
  for (const [slice, value] of Object.entries(state.slices)) {
    if (!value.gateEvidence.length) {
      fail(`successful run is missing gate evidence for slice ${slice}`);
    }
    if (!value.reviewEvidence.length) {
      fail(`successful run is missing review evidence for slice ${slice}`);
    }
    const reviewPaths = [
      value.reviewArtifact,
      value.reviewArtifact.replace(/\.json$/, ".md"),
    ];
    const reviewArtifacts = reviewPaths.map(
      (path) =>
        git(root, ["cat-file", "-e", `${audit.auditedCommit}:${path}`], {
          allowFailure: true,
        }) !== null,
    );
    if (reviewArtifacts[0] !== reviewArtifacts[1]) {
      fail(
        `finalAudit audited commit contains incomplete review artifacts for slice ${slice}`,
      );
    }
  }
}

export function validateRunState(state, root) {
  if (!state || ![3, 4, 5].includes(state.version)) {
    fail("run state version must be 3, 4, or 5");
  }
  if (state.$schema !== "../../../.parallel-slices/loop-state.schema.json") {
    fail(
      "run state must reference ../../../.parallel-slices/loop-state.schema.json",
    );
  }
  if (!/^docs\/plans\/.+\.md$/.test(state.plan || "")) {
    fail("run-state plan must be a Markdown file under docs/plans");
  }
  assertSafeRelativePath(state.plan, "run-state plan");
  if (!existsSync(resolve(root, state.plan))) {
    fail(`run-state plan does not exist: ${state.plan}`);
  }
  validateApprovedPlanSource(state, root);
  if ([4, 5].includes(state.version)) {
    validateCompilationSource(state, root);
  } else if (Object.hasOwn(state, "compilation")) {
    fail("legacy version 3 run state must not contain compilation metadata");
  }
  assertString(state.milestone, "run-state milestone");
  assertString(state.goalBranch, "run-state goalBranch");
  assertBranchAllowed(state.goalBranch, loadQualityConfig(root));
  assertAgentEnabled(state.controller, root);
  if (!/^[a-z0-9][a-z0-9-]{15,63}$/.test(state.runId || "")) {
    fail("runId must be a 16-64 character lowercase identifier");
  }
  if (!runStatuses.includes(state.status)) {
    fail(`invalid run status: ${state.status}`);
  }
  if (!state.slices || Array.isArray(state.slices)) {
    fail("run state must contain a slices object");
  }
  const entries = Object.entries(state.slices);
  if (!entries.length) fail("run state must contain at least one slice");
  for (const [slice, value] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slice)) {
      fail(`invalid run-state slice ID: ${slice}`);
    }
    if (!value || !sliceStatuses.includes(value.status)) {
      fail(`invalid status for slice ${slice}`);
    }
    if (!/^docs\/plans\/scopes\/.+\.scope$/.test(value.manifest || "")) {
      fail(`invalid manifest path for slice ${slice}`);
    }
    assertSafeRelativePath(value.manifest, `slice ${slice} manifest`);
    if (!existsSync(resolve(root, value.manifest))) {
      fail(`manifest does not exist for slice ${slice}: ${value.manifest}`);
    }
    for (const [field, commit] of [
      ["candidateCommit", value.candidateCommit],
    ]) {
      if (commit !== null && !/^[0-9a-f]{40}$/.test(commit || "")) {
        fail(`${field} for slice ${slice} must be null or a full commit SHA`);
      }
    }
    if (value.status === "accepted" && !value.candidateCommit) {
      fail(`accepted slice ${slice} must record candidateCommit`);
    }
    for (const field of ["gateEvidence", "reviewEvidence"]) {
      const evidence = value[field];
      if (
        !Array.isArray(evidence) ||
        evidence.some(
          (item) =>
            typeof item !== "string" || !item.trim() || item.length > 2000,
        ) ||
        new Set(evidence).size !== evidence.length
      ) {
        fail(
          `${field} for slice ${slice} must contain unique non-empty evidence`,
        );
      }
      if (value.status === "accepted" && evidence.length === 0) {
        fail(`accepted slice ${slice} must record ${field}`);
      }
    }
    if (!/^docs\/plans\/reviews\/.+\.json$/.test(value.reviewArtifact || "")) {
      fail(`invalid reviewArtifact for slice ${slice}`);
    }
  }
  if (!Array.isArray(state.findings))
    fail("run-state findings must be an array");
  validateFinalAudit(state, root);
  return state;
}

export function readRunState(root, statePath) {
  assertSafeRelativePath(statePath, "run state");
  if (!/^docs\/plans\/loop-runs\/[^/]+\.json$/.test(statePath)) {
    fail("run state must be a JSON file under docs/plans/loop-runs");
  }
  const absolute = resolve(root, statePath);
  if (!existsSync(absolute)) fail(`run state does not exist: ${statePath}`);
  if (lstatSync(absolute).isSymbolicLink()) {
    fail(`refusing symlinked run state: ${statePath}`);
  }
  let state;
  try {
    state = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    fail(`invalid run-state JSON: ${error.message}`);
  }
  return validateRunState(state, root);
}

function parseRoot(value) {
  const root = value || process.cwd();
  if (!isAbsolute(root)) fail("target must be an absolute path");
  return resolve(root);
}

function runCli(argv) {
  const [command, stateFlag, statePath, target] = argv;
  if (command === "new-id" && argv.length === 1) {
    console.log(randomUUID());
    return;
  }
  if (
    command === "verify" &&
    stateFlag === "--state" &&
    statePath &&
    argv.length <= 4
  ) {
    const root = parseRoot(target);
    const state = readRunState(root, statePath);
    console.log(
      `run state valid: ${state.runId} (${state.controller}, ${state.status})`,
    );
    return;
  }
  fail(
    "usage: run-state.mjs new-id | verify --state <repository-relative-state> [absolute-target]",
  );
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`RUN STATE FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
