#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveBranchBase, runBranchPolicy } from "./branch-policy.mjs";
import { readArchitectureProfile } from "./architecture-profile.mjs";
import {
  assertNoPotentialSecrets,
  assertNoPotentialSecretsAtRevision,
} from "./content-safety.mjs";
import { runDoctor } from "./doctor.mjs";
import {
  generatedBaselinePath,
  verifyGeneratedBaseline,
} from "./generated-baseline.mjs";
import {
  assertBranchAllowed,
  detectPackageManager,
  entrypointCapabilityFloorsForRoot,
  inspectProjectChecks,
  installDependencies,
  isAutomationBranch,
  loadQualityConfig,
  pipelineCapabilities,
  readPackageManagerSpec,
  resolveEntrypoint,
  resolvePipeline,
  runPipeline,
  runProjectChecks,
} from "./project-quality.mjs";
import {
  hasInitializationMarker,
  readProjectState,
  requiredProjectDocuments,
} from "./project-state.mjs";
import { assertProductPlanContent, readRunState } from "./run-state.mjs";
import {
  readPlanningReviewTarget,
  validatePlanningReviewEvidence,
} from "./planning-review.mjs";
import { loadReviewConfig } from "./review-config.mjs";
import {
  computeExecutionSets,
  computeReadySlices,
  loadPlanManifests,
} from "./slice-graph.mjs";
import {
  parseManifestText,
  requireCommittedContract,
  validateManifest,
  validateScopeCoverage,
} from "./scope-policy.mjs";
import {
  readScopeCorrection,
  validateScopeReplacement,
} from "./scope-correction.mjs";

function git(args, root = process.cwd(), options = {}) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (options.allowFailure) return null;
    throw error;
  }
}

export function assertPushTargetsAllowed(pushSpec, config) {
  for (const line of (pushSpec || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) {
      throw new Error(`invalid pre-push ref line: ${line}`);
    }
    const remoteRef = fields[2];
    if (!remoteRef.startsWith("refs/heads/")) continue;
    const remoteBranch = remoteRef.slice("refs/heads/".length);
    assertBranchAllowed(remoteBranch, config);
  }
}

export function readGitHubActionsContext(environment = process.env) {
  if (environment.GITHUB_ACTIONS !== "true") return null;
  const eventPath = environment.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) {
    throw new Error("GitHub Actions event payload is unavailable");
  }
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  if (environment.GITHUB_EVENT_NAME === "pull_request") {
    const branch = event.pull_request?.head?.ref;
    const base = event.pull_request?.base?.sha;
    if (!branch || !base) {
      throw new Error("pull-request event is missing head.ref or base.sha");
    }
    return { branch, base, protectedTarget: false };
  }
  if (environment.GITHUB_EVENT_NAME === "push") {
    const branch = event.ref?.replace(/^refs\/heads\//, "");
    if (!branch || branch === event.ref || !event.before) {
      throw new Error("push event is missing a branch ref or before commit");
    }
    return { branch, base: event.before, protectedTarget: true };
  }
  throw new Error(
    `unsupported GitHub Actions event: ${environment.GITHUB_EVENT_NAME || "unknown"}`,
  );
}

function hasCommit(root) {
  return (
    git(["rev-parse", "--verify", "HEAD"], root, {
      allowFailure: true,
    }) !== null
  );
}

function stagedFiles(root) {
  const output = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACMRD", "-z", "--"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return output.split("\0").filter(Boolean);
}

function stagedEntries(root) {
  const output = execFileSync(
    "git",
    [
      "diff",
      "--cached",
      "--no-renames",
      "--name-status",
      "--diff-filter=ACMRD",
      "-z",
      "--",
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const fields = output.split("\0").filter(Boolean);
  if (fields.length % 2 !== 0) {
    throw new Error("Git returned an invalid staged change set");
  }
  const entries = [];
  for (let index = 0; index < fields.length; index += 2) {
    entries.push({ status: fields[index], path: fields[index + 1] });
  }
  return entries;
}

function isProductPlan(path) {
  return /^docs\/plans\/\d{4}-\d{2}-\d{2}-[^/]+\.md$/.test(path);
}

function isExecutableManifest(path) {
  return (
    /^docs\/plans\/scopes\/.+\.scope$/.test(path) &&
    !path.split("/").at(-1).startsWith("_")
  );
}

function isRunState(path) {
  return /^docs\/plans\/loop-runs\/[^/]+\.json$/.test(path);
}

function assertCommittedProductPlan(root, path) {
  requireCommittedContract(root, [path]);
  const content = git(["show", `HEAD:${path}`], root);
  assertProductPlanContent(root, path, content);
}

function validateCompiledExecutionCommit(root, entries, config) {
  const staged = new Set(entries.map((entry) => entry.path));
  const manifestPaths = entries
    .filter((entry) => entry.status === "A" && isExecutableManifest(entry.path))
    .map((entry) => entry.path)
    .sort();
  if (!manifestPaths.length) return false;

  const manifests = manifestPaths.map((path) => {
    const manifest = parseManifestText(
      readFileSync(resolve(root, path), "utf8"),
    );
    validateManifest(manifest, path, root, config);
    validateScopeCoverage(manifest, { required: true, root });
    if (manifest.version !== "2") {
      throw new Error(
        `compiled execution requires version 2 manifest: ${path}`,
      );
    }
    if (!staged.has(manifest.state)) {
      throw new Error(
        `compiled execution commit must stage the referenced run state: ${manifest.state}`,
      );
    }
    return { ...manifest, path };
  });
  const plans = [...new Set(manifests.map((manifest) => manifest.plan))];
  if (plans.length !== 1) {
    throw new Error(
      "compiled execution commit must target exactly one Product Plan",
    );
  }
  const [plan] = plans;
  assertCommittedProductPlan(root, plan);

  const statePaths = [...new Set(manifests.map((manifest) => manifest.state))];
  if (statePaths.length !== 1) {
    throw new Error(
      "compiled execution commit must create exactly one run state",
    );
  }
  const [statePath] = statePaths;
  const addedStatePaths = entries
    .filter((entry) => entry.status === "A" && isRunState(entry.path))
    .map((entry) => entry.path);
  if (addedStatePaths.length !== 1 || addedStatePaths[0] !== statePath) {
    throw new Error(
      "compiled execution commit must add only its one referenced run state",
    );
  }
  const state = readRunState(root, statePath);
  if (state.version !== 4) {
    throw new Error(
      "new compiled execution requires version 4 run state with pinned sizing inputs",
    );
  }
  if (state.plan !== plan) {
    throw new Error(
      `compiled run state does not reference Product Plan: ${plan}`,
    );
  }
  if (!state.compilation.planningReview) {
    throw new Error(
      "new compiled execution requires a declared independent planning review",
    );
  }
  const reviewConfig = loadReviewConfig(root);
  if (!reviewConfig.enabled || reviewConfig.reviewers.length === 0) {
    throw new Error(
      "new compiled execution requires enabled independent reviewers in .parallel-slices/review.json",
    );
  }
  const planningTarget = readPlanningReviewTarget(root, statePath);
  if (
    !entries.some(
      (entry) =>
        entry.status === "A" && entry.path === planningTarget.scopeFile,
    )
  ) {
    throw new Error(
      `compiled execution commit must add its planning-review scope: ${planningTarget.scopeFile}`,
    );
  }
  if (
    staged.has(planningTarget.artifact) ||
    staged.has(planningTarget.artifactMarkdown)
  ) {
    throw new Error(
      "planning-review evidence must be generated and committed after the compiled execution map",
    );
  }
  const compiledContractPaths = new Set([
    ...manifestPaths,
    statePath,
    planningTarget.scopeFile,
  ]);
  const unrelated = entries.filter(
    (entry) => !compiledContractPaths.has(entry.path),
  );
  if (unrelated.length) {
    throw new Error(
      `compiled execution commit cannot include implementation or unrelated files:\n${unrelated.map((entry) => `  ${entry.path}`).join("\n")}`,
    );
  }
  const graph = loadPlanManifests(root, plan);
  const compiledPaths = new Set(graph.map((manifest) => manifest.path));
  if (compiledPaths.size !== manifestPaths.length) {
    const unstaged = [...compiledPaths].filter(
      (path) => !manifestPaths.includes(path),
    );
    throw new Error(
      `compiled execution commit must stage every manifest for the Product Plan:\n${unstaged.map((path) => `  ${path}`).join("\n")}`,
    );
  }
  for (const path of manifestPaths) {
    if (!compiledPaths.has(path)) {
      throw new Error(`compiled run state is missing manifest: ${path}`);
    }
  }
  computeExecutionSets(graph);
  computeReadySlices(graph, state);
  return true;
}

function validatePlanningReviewCommit(root, entries) {
  const artifacts = entries.filter((entry) =>
    /^docs\/plans\/reviews\/.+\/planning\.(?:json|md)$/.test(entry.path),
  );
  if (!artifacts.length) return false;
  if (artifacts.length !== 2) {
    throw new Error(
      "planning review must stage its JSON ledger and generated Markdown view together",
    );
  }
  const jsonEntry = artifacts.find((entry) => entry.path.endsWith(".json"));
  const markdownEntry = artifacts.find((entry) => entry.path.endsWith(".md"));
  if (!jsonEntry || !markdownEntry) {
    throw new Error(
      "planning review requires one JSON and one Markdown artifact",
    );
  }
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(resolve(root, jsonEntry.path), "utf8"));
  } catch (error) {
    throw new Error(
      `planning-review ledger is invalid JSON: ${error.message}`,
      {
        cause: error,
      },
    );
  }
  const scopeFile = ledger.scopeFile;
  if (!/^docs\/plans\/scopes\/[^/]+\/_planning\.scope$/.test(scopeFile || "")) {
    throw new Error("planning-review ledger has an invalid scope manifest");
  }
  const manifest = parseManifestText(
    readFileSync(resolve(root, scopeFile), "utf8"),
  );
  const evidence = validatePlanningReviewEvidence(root, manifest.state);
  if (
    evidence.target.artifact !== jsonEntry.path ||
    evidence.target.artifactMarkdown !== markdownEntry.path
  ) {
    throw new Error("staged planning-review artifacts do not match run state");
  }
  const allowed = new Set([jsonEntry.path, markdownEntry.path]);
  const combined = entries.filter((entry) => !allowed.has(entry.path));
  if (combined.length) {
    throw new Error(
      `planning-review evidence must be committed separately from other changes:\n${combined.map((entry) => `  ${entry.path}`).join("\n")}`,
    );
  }
  return true;
}

function validateCorrectionStateTransition(
  previous,
  current,
  replacement,
  replacementPath,
) {
  for (const field of [
    "$schema",
    "version",
    "plan",
    "planCommit",
    "compilation",
    "milestone",
    "goalBranch",
    "controller",
    "runId",
    "findings",
    "finalAudit",
  ]) {
    if (JSON.stringify(previous[field]) !== JSON.stringify(current[field])) {
      throw new Error(
        `execution-map correction cannot change run-state ${field}`,
      );
    }
  }
  if (!new Set(["not_started", "in_progress"]).has(current.status)) {
    throw new Error(
      "execution-map correction must return the run to not_started or in_progress",
    );
  }
  const previousSlices = Object.keys(previous.slices).sort();
  const currentSlices = Object.keys(current.slices).sort();
  if (JSON.stringify(previousSlices) !== JSON.stringify(currentSlices)) {
    throw new Error("execution-map correction cannot add or remove slices");
  }
  for (const slice of previousSlices) {
    if (slice === replacement.slice) continue;
    if (
      JSON.stringify(previous.slices[slice]) !==
      JSON.stringify(current.slices[slice])
    ) {
      throw new Error(
        `execution-map correction cannot change unrelated slice state: ${slice}`,
      );
    }
  }
  const before = previous.slices[replacement.slice];
  const after = current.slices[replacement.slice];
  if (!before || !after || before.manifest !== replacement.supersedes) {
    throw new Error(
      "execution-map correction does not replace the active slice",
    );
  }
  if (
    before.status === "accepted" ||
    before.candidateCommit !== null ||
    before.gateEvidence.length ||
    before.reviewEvidence.length
  ) {
    throw new Error(
      "execution-map correction is allowed only before a candidate or accepted evidence exists",
    );
  }
  if (
    after.manifest !== replacementPath ||
    after.reviewArtifact !== replacement.review ||
    after.status !== "not_started" ||
    after.candidateCommit !== null ||
    after.gateEvidence.length ||
    after.reviewEvidence.length
  ) {
    throw new Error(
      "corrected slice state must point to the replacement manifest and reset to not_started",
    );
  }
}

function validateExecutionMapCorrectionCommit(root, entries, config) {
  const addedManifestEntries = entries.filter(
    (entry) => entry.status === "A" && isExecutableManifest(entry.path),
  );
  if (!addedManifestEntries.length) return false;
  const replacements = addedManifestEntries.map((entry) => {
    const manifest = parseManifestText(
      readFileSync(resolve(root, entry.path), "utf8"),
    );
    return { ...manifest, path: entry.path };
  });
  if (!replacements.some((manifest) => manifest.supersedes)) return false;
  if (replacements.length !== 1 || !replacements[0].supersedes) {
    throw new Error(
      "execution-map correction commits must add exactly one replacement manifest",
    );
  }
  const [replacement] = replacements;
  validateManifest(replacement, replacement.path, root, config);
  validateScopeCoverage(replacement, { required: true, root });
  const stateEntries = entries.filter((entry) => isRunState(entry.path));
  if (
    stateEntries.length !== 1 ||
    stateEntries[0].status !== "M" ||
    stateEntries[0].path !== replacement.state
  ) {
    throw new Error(
      "execution-map correction must modify only its existing run state",
    );
  }
  const recordEntries = entries.filter((entry) =>
    /^docs\/plans\/corrections\/[^/]+\/[^/]+\.json$/.test(entry.path),
  );
  if (
    recordEntries.length !== 1 ||
    recordEntries[0].status !== "A" ||
    recordEntries[0].path !== replacement.correction
  ) {
    throw new Error(
      "execution-map correction must add exactly its declared correction record",
    );
  }
  const allowedPaths = new Set([
    replacement.path,
    replacement.state,
    replacement.correction,
  ]);
  const unrelated = entries.filter((entry) => !allowedPaths.has(entry.path));
  if (unrelated.length) {
    throw new Error(
      `execution-map correction cannot include implementation or unrelated files:\n${unrelated.map((entry) => `  ${entry.path}`).join("\n")}`,
    );
  }
  const previousText = git(["show", `HEAD:${replacement.supersedes}`], root, {
    allowFailure: true,
  });
  if (previousText === null) {
    throw new Error(
      `superseded manifest is not committed: ${replacement.supersedes}`,
    );
  }
  const previous = {
    ...parseManifestText(previousText),
    path: replacement.supersedes,
  };
  const previousStateText = git(["show", `HEAD:${replacement.state}`], root, {
    allowFailure: true,
  });
  if (previousStateText === null) {
    throw new Error(
      `corrected run state is not committed: ${replacement.state}`,
    );
  }
  const previousState = JSON.parse(previousStateText);
  const currentState = readRunState(root, replacement.state);
  const record = readScopeCorrection(root, replacement.correction);
  validateScopeReplacement({
    previous,
    previousPath: replacement.supersedes,
    replacement,
    replacementPath: replacement.path,
    correctionPath: replacement.correction,
    record,
    state: currentState,
  });
  validateCorrectionStateTransition(
    previousState,
    currentState,
    replacement,
    replacement.path,
  );
  const graph = loadPlanManifests(root, currentState.plan);
  computeExecutionSets(graph);
  computeReadySlices(graph, currentState);
  readPlanningReviewTarget(root, replacement.state);
  return true;
}

export function validatePlanningCommitBoundary(root, config) {
  const entries = stagedEntries(root);
  const addedPlans = entries.filter(
    (entry) => entry.status === "A" && isProductPlan(entry.path),
  );
  const changedPlans = entries.filter(
    (entry) => entry.status !== "A" && isProductPlan(entry.path),
  );
  const addedManifests = entries.filter(
    (entry) => entry.status === "A" && isExecutableManifest(entry.path),
  );
  const addedStates = entries.filter(
    (entry) => entry.status === "A" && isRunState(entry.path),
  );

  if (changedPlans.length) {
    throw new Error(
      `approved Product Plans are immutable; create a new plan instead of changing:\n${changedPlans.map((entry) => `  ${entry.path}`).join("\n")}`,
    );
  }
  if (addedPlans.length && (addedManifests.length || addedStates.length)) {
    throw new Error(
      "Product Plan approval and AI execution compilation must be separate commits",
    );
  }
  if (addedPlans.length) {
    if (addedPlans.length !== 1) {
      throw new Error(
        "a Product Plan approval commit must add exactly one plan",
      );
    }
    const [entry] = addedPlans;
    assertProductPlanContent(
      root,
      entry.path,
      readFileSync(resolve(root, entry.path), "utf8"),
    );
    return "product-plan";
  }
  if (validateExecutionMapCorrectionCommit(root, entries, config)) {
    return "execution-map-correction";
  }
  if (validatePlanningReviewCommit(root, entries)) {
    return "planning-review";
  }
  if (addedStates.length && !addedManifests.length) {
    throw new Error(
      "a new run state must be committed with its compiled scope manifests",
    );
  }
  return validateCompiledExecutionCommit(root, entries, config)
    ? "compiled-execution"
    : null;
}

function isAdoptionContractPath(path, installedArchitectureFiles) {
  const exact = new Set([
    ".node-version",
    ".nvmrc",
    ".tool-versions",
    "AGENTS.md",
    "README.md",
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "package.json",
    "pnpm-lock.yaml",
    "yarn.lock",
  ]);
  const prefixes = [
    ".agents/",
    ".parallel-slices/",
    ".claude/",
    ".cursor/",
    ".github/",
    ".husky/",
    "docs/parallel-slices/",
    "docs/plans/",
    "docs/project/",
    "docs/releases/",
    "docs/testing/manual/",
    "scripts/parallel-slices/",
    "scripts/architecture/",
  ];
  return (
    exact.has(path) ||
    prefixes.some((prefix) => path.startsWith(prefix)) ||
    installedArchitectureFiles.has(path)
  );
}

function checkInstalledJavaScript(root) {
  const directory = resolve(root, "scripts/parallel-slices");
  if (!existsSync(directory))
    throw new Error("scripts/parallel-slices is missing");
  for (const name of readdirSync(directory)
    .filter((entry) => entry.endsWith(".mjs"))
    .sort()) {
    execFileSync(process.execPath, ["--check", resolve(directory, name)], {
      cwd: root,
      stdio: "inherit",
    });
  }
}

function runInitializationCommitGate(root, config, checkIds, planningStage) {
  const state = readProjectState(root);
  if (state.stage !== "contract-ready") {
    throw new Error(
      "missing quality scripts are allowed only while project stage is contract-ready",
    );
  }
  const changed = stagedFiles(root);
  if (!changed.length) {
    throw new Error("the initialization commit has no staged files");
  }
  if (hasCommit(root)) {
    const installedArchitectureFiles = new Set(
      readArchitectureProfile(root).installedFiles,
    );
    const outside = changed.filter(
      (path) => !isAdoptionContractPath(path, installedArchitectureFiles),
    );
    if (outside.length) {
      throw new Error(
        `application paths cannot use the initialization commit gate:\n${outside.join("\n")}`,
      );
    }
  }
  if (!planningStage) {
    throw new Error(
      "initialization requires either a Product Plan approval commit or a compiled execution commit",
    );
  }
  for (const path of requiredProjectDocuments(root)) {
    if (!existsSync(resolve(root, path))) {
      throw new Error(`the initialization commit is missing ${path}`);
    }
  }
  const agents = readFileSync(resolve(root, "AGENTS.md"), "utf8");
  if (hasInitializationMarker(agents)) {
    throw new Error(
      "the initialization commit must replace the bootstrap AGENTS.md",
    );
  }
  assertNoPotentialSecrets(root, changed, "staged initialization file");
  execFileSync("git", ["diff", "--cached", "--check"], {
    cwd: root,
    stdio: "inherit",
  });
  checkInstalledJavaScript(root);

  const available = inspectProjectChecks(root, config, checkIds).resolved.map(
    (check) => check.id,
  );
  if (available.length) runProjectChecks(root, config, available);
  console.log(
    planningStage === "product-plan"
      ? "Product Plan approval commit gate passed"
      : planningStage === "compiled-execution"
        ? "AI-compiled execution commit gate passed"
        : planningStage === "planning-review"
          ? "Independent planning-review commit gate passed"
          : "Audited execution-map correction commit gate passed",
  );
  console.log(
    "remaining required quality scripts must be delivered by the approved foundation",
  );
}

function assertEntrypointBranch(entrypointId, branch, config, options) {
  if (
    entrypointId === "ci" &&
    options.protectedTarget &&
    config.protectedBranches.includes(branch)
  ) {
    if (process.env.CI !== "true" && process.env.CI !== "1") {
      throw new Error("--protected-target is allowed only in CI");
    }
    return;
  }
  assertBranchAllowed(branch, config, {
    allowAutomation: entrypointId === "ci",
  });
}

function runGeneratedBaselineEntrypoint(
  root,
  config,
  entrypointId,
  branch,
  options,
) {
  if (!["preCommit", "prePush", "ci"].includes(entrypointId)) {
    throw new Error(
      "run an enabled tool's initialization workflow before lifecycle gates",
    );
  }
  const baseline = verifyGeneratedBaseline(root);
  if (entrypointId === "preCommit") {
    const changed = stagedFiles(root);
    const expected = new Set([
      ...baseline.files.map((file) => file.path),
      generatedBaselinePath,
    ]);
    const missing = [...expected].filter((path) => !changed.includes(path));
    const unexpected = changed.filter((path) => !expected.has(path));
    if (missing.length || unexpected.length) {
      throw new Error(
        `the pristine generated-baseline commit must stage the exact generated tree${missing.length ? `; missing: ${missing.join(", ")}` : ""}${unexpected.length ? `; unexpected: ${unexpected.join(", ")}` : ""}`,
      );
    }
    assertNoPotentialSecretsAtRevision(root, changed, "", "staged file");
  }
  if (entrypointId === "prePush" || entrypointId === "ci") {
    if (entrypointId === "prePush") {
      assertPushTargetsAllowed(options.pushSpec, config);
    }
    runDoctor({
      root,
      branch,
      allowProtectedBranch: Boolean(options.protectedTarget),
      allowAutomation: entrypointId === "ci",
    });
    const base = resolveBranchBase(root, config, {
      base: options.base,
      remote: options.remote,
    });
    runBranchPolicy({
      root,
      config,
      base,
      exemptionReason: "pristine generated baseline",
    });
  }
  const generatedEntrypoint = resolveEntrypoint(config, "generatedBaseline");
  runPipeline(root, config, generatedEntrypoint.pipelineId);
  console.log(
    `${entrypointId} entry point passed for pristine generated baseline`,
  );
}

function runConfiguredEntrypoint(root, config, entrypointId, options = {}) {
  const entrypoint = resolveEntrypoint(config, entrypointId);
  if (!entrypoint.pipelineId) {
    throw new Error(
      "the loop entry point requires gate.mjs with a committed scope manifest",
    );
  }
  const branch = options.branch || git(["branch", "--show-current"], root);
  assertEntrypointBranch(entrypointId, branch, config, options);
  const projectState = readProjectState(root);
  if (projectState.stage === "initialization-required") {
    runGeneratedBaselineEntrypoint(root, config, entrypointId, branch, options);
    return;
  }
  const ids = resolvePipeline(config, entrypoint.pipelineId);

  let planningStage = null;
  if (entrypointId === "preCommit") {
    const changed = stagedFiles(root);
    assertNoPotentialSecretsAtRevision(root, changed, "", "staged file");
    planningStage = validatePlanningCommitBoundary(root, config);
    const missing = inspectProjectChecks(root, config, ids).missing;
    if (missing.length) {
      runInitializationCommitGate(root, config, ids, planningStage);
      return;
    }
  }

  if (entrypointId === "prePush" || entrypointId === "ci") {
    if (entrypointId === "prePush") {
      assertPushTargetsAllowed(options.pushSpec, config);
    }
    runDoctor({
      root,
      branch,
      foundationReady: true,
      initialized: true,
      allowProtectedBranch: Boolean(options.protectedTarget),
      allowAutomation: entrypointId === "ci",
    });
    const base = resolveBranchBase(root, config, {
      base: options.base,
      remote: options.remote,
    });
    runBranchPolicy({
      root,
      config,
      base,
      exemptionReason: options.protectedTarget
        ? "protected-target post-merge rerun"
        : isAutomationBranch(branch, config)
          ? "approved automation branch"
          : undefined,
    });
  }

  runPipeline(root, config, entrypoint.pipelineId);
  if (planningStage === "product-plan") {
    console.log("Product Plan approval commit boundary passed");
  } else if (planningStage === "compiled-execution") {
    console.log("AI-compiled execution commit boundary passed");
  } else if (planningStage === "planning-review") {
    console.log("Independent planning-review commit boundary passed");
  } else if (planningStage === "execution-map-correction") {
    console.log("Audited execution-map correction commit boundary passed");
  }
  console.log(`${entrypointId} entry point passed`);
}

function explainTarget(root, config, target, asJson = false) {
  const entrypointCapabilityFloors = entrypointCapabilityFloorsForRoot(root);
  const configuredEntrypoint = config.entrypoints[target];
  if (configuredEntrypoint?.pipelineFrom) {
    const result = {
      target,
      kind: "entrypoint",
      pipelineSource: configuredEntrypoint.pipelineFrom,
      capabilityFloor: entrypointCapabilityFloors[target],
    };
    console.log(
      asJson
        ? JSON.stringify(result, null, 2)
        : `${target}: pipeline selected by scope manifest`,
    );
    return result;
  }
  const pipelineId = configuredEntrypoint?.pipeline || target;
  if (!config.pipelines[pipelineId]) {
    throw new Error(`unknown entry point or pipeline: ${target}`);
  }
  const stepIds = resolvePipeline(config, pipelineId);
  const inspection = inspectProjectChecks(root, config, stepIds);
  const result = {
    target,
    kind: configuredEntrypoint ? "entrypoint" : "pipeline",
    pipeline: pipelineId,
    packageManager: inspection.manager,
    capabilityFloor: configuredEntrypoint
      ? entrypointCapabilityFloors[target]
      : undefined,
    capabilities: pipelineCapabilities(config, pipelineId),
    steps: stepIds.map((id) => {
      const resolved = inspection.resolved.find((step) => step.id === id);
      const step = config.steps[id];
      return {
        id,
        name: step.name,
        script: resolved?.script || null,
        candidates: step.scripts,
        timeoutSeconds: step.timeoutSeconds,
        provides: step.provides,
        status: resolved ? "ready" : "missing",
      };
    }),
  };
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${target} -> pipeline ${pipelineId}`);
    for (const step of result.steps) {
      console.log(
        `  ${step.id}: ${step.status === "ready" ? step.script : `missing (${step.candidates.join(" or ")})`} [${step.timeoutSeconds}s]`,
      );
    }
    console.log(`  capabilities: ${result.capabilities.join(", ")}`);
  }
  return result;
}

export function runQualityMode(mode, options = {}) {
  const root = options.root || git(["rev-parse", "--show-toplevel"]);
  const config = loadQualityConfig(root);

  if (mode === "package-manager") {
    console.log(detectPackageManager(root, config.packageManager));
    return;
  }
  if (mode === "package-manager-spec") {
    console.log(readPackageManagerSpec(root).spec);
    return;
  }
  if (mode === "ci-install") {
    installDependencies(root, config);
    return;
  }
  if (mode === "check-branch") {
    assertBranchAllowed(options.branch, config, {
      allowAutomation: options.allowAutomation,
    });
    console.log(`branch policy passed: ${options.branch}`);
    return;
  }
  if (mode === "validate") {
    console.log("quality configuration valid");
    return config;
  }
  if (mode === "explain") {
    if (!options.target) throw new Error("usage: quality.mjs explain <target>");
    return explainTarget(root, config, options.target, options.json);
  }
  if (mode === "entrypoint") {
    if (!options.target) {
      throw new Error(
        "usage: quality.mjs entrypoint <preCommit|prePush|ci|loop>",
      );
    }
    let entrypointOptions = options;
    if (options.target === "ci") {
      const githubContext = readGitHubActionsContext();
      if (githubContext) {
        for (const key of ["branch", "base"]) {
          if (options[key] && options[key] !== githubContext[key]) {
            throw new Error(
              `CI ${key} does not match the GitHub event payload`,
            );
          }
        }
        if (options.protectedTarget && !githubContext.protectedTarget) {
          throw new Error(
            "CI protected-target mode does not match the GitHub event payload",
          );
        }
        entrypointOptions = { ...options, ...githubContext };
      }
    }
    return runConfiguredEntrypoint(
      root,
      config,
      options.target,
      entrypointOptions,
    );
  }
  if (mode === "pipeline") {
    if (!options.target) {
      throw new Error("usage: quality.mjs pipeline <pipeline-id>");
    }
    runPipeline(root, config, options.target);
    return;
  }
  throw new Error(`unknown quality mode: ${mode}`);
}

function parseCommandLine(argv) {
  const [mode, target, ...args] = argv;
  if (!mode) throw new Error("usage: quality.mjs <mode> [target] [options]");
  const options = { target };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["--base", "--branch", "--remote"].includes(argument)) {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      index += 1;
    } else if (argument === "--json") options.json = true;
    else if (argument === "--protected-target") options.protectedTarget = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (mode === "check-branch") {
    options.branch = target;
    options.target = undefined;
  }
  options.allowAutomation = process.env.CI === "true" || process.env.CI === "1";
  if (mode === "entrypoint" && target === "prePush" && !process.stdin.isTTY) {
    options.pushSpec = readFileSync(0, "utf8");
  }
  return { mode, options };
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    const { mode, options } = parseCommandLine(process.argv.slice(2));
    runQualityMode(mode, options);
  } catch (error) {
    console.error(`QUALITY GATE RED: ${error.message}`);
    process.exitCode = 1;
  }
}
