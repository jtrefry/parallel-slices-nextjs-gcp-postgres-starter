import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readArchitectureProfile } from "./architecture-profile.mjs";

const stepIdPattern = /^[a-z][a-z0-9-]*$/;
const capabilityPattern = /^[a-z][a-z0-9:-]*$/;
const scriptPattern = /^[A-Za-z0-9:_-]+$/;
const fixedEntrypoints = Object.freeze([
  "generatedBaseline",
  "preCommit",
  "prePush",
  "ci",
  "loop",
]);
export const sliceSizingStrategies = Object.freeze([
  "isolation-first",
  "throughput-balanced",
]);

function fail(message) {
  throw new Error(message);
}

function assertKnownKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    fail(`${label} has unknown fields: ${unexpected.join(", ")}`);
  }
}

function readPackage(root) {
  return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
}

export function parsePackageManagerSpec(spec) {
  const match =
    /^(npm|pnpm|yarn|bun)@(\d+\.\d+\.\d+)(?:[+-][A-Za-z0-9.-]+)?$/.exec(
      spec || "",
    );
  if (!match)
    fail("packageManager must pin npm, pnpm, yarn, or bun to an exact version");
  return { manager: match[1], spec, version: match[2] };
}

export function readPackageManagerSpec(root) {
  return parsePackageManagerSpec(readPackage(root).packageManager);
}

export function packageManagerCommand(manager, args) {
  if (manager === "pnpm" || manager === "yarn") {
    const runner = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "corepack-runner.mjs",
    );
    return [process.execPath, [runner, manager, ...args]];
  }
  return [manager, args];
}

function run(root, command, args, step, extraEnv = {}) {
  console.log(`\n== ${step.name}: ${command} ${args.join(" ")} ==`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, CI: "1", ...extraEnv },
    stdio: "inherit",
    timeout: step.timeoutSeconds * 1000,
    killSignal: "SIGTERM",
  });
  if (result.error?.code === "ETIMEDOUT") {
    fail(`${step.name} timed out after ${step.timeoutSeconds} seconds`);
  }
  if (result.error)
    fail(`${step.name} could not start: ${result.error.message}`);
  if (result.signal) fail(`${step.name} was terminated by ${result.signal}`);
  if (result.status !== 0)
    fail(`${step.name} failed with exit code ${result.status}`);
}

export function detectPackageManager(root, configured = "auto") {
  const pkg = readPackage(root);
  const locks = [
    ["pnpm", "pnpm-lock.yaml"],
    ["yarn", "yarn.lock"],
    ["npm", "package-lock.json"],
    ["bun", "bun.lock"],
    ["bun", "bun.lockb"],
  ].filter(([, file]) => existsSync(resolve(root, file)));
  const managers = [...new Set(locks.map(([manager]) => manager))];
  const packageDeclared = pkg.packageManager?.split("@")[0];
  const declared = configured === "auto" ? packageDeclared : configured;
  if (
    configured !== "auto" &&
    packageDeclared &&
    packageDeclared !== configured
  ) {
    fail(
      `Parallel Slices config selects ${configured}, but packageManager declares ${packageDeclared}`,
    );
  }
  if (declared) {
    const conflicting = managers.filter((manager) => manager !== declared);
    if (conflicting.length) {
      fail(
        `packageManager declares ${declared}, but conflicting lockfiles were found for ${conflicting.join(", ")}`,
      );
    }
    return declared;
  }
  if (managers.length > 1) {
    fail(`multiple package-manager lockfiles found: ${managers.join(", ")}`);
  }
  return managers[0] || "npm";
}

export function loadQualityConfig(root) {
  const path = resolve(root, ".parallel-slices/config.json");
  if (!existsSync(path)) fail(".parallel-slices/config.json is missing");
  const config = JSON.parse(readFileSync(path, "utf8"));
  validateQualityConfig(
    config,
    readArchitectureProfile(root).entrypointCapabilityFloors,
  );
  return config;
}

export function entrypointCapabilityFloorsForRoot(root) {
  return readArchitectureProfile(root).entrypointCapabilityFloors;
}

export function includesHuskyCommand(command = "") {
  return /(^|(?:&&|\|\||;)[ \t]*)husky(?:[ \t]|$)/.test(command.trim());
}

function validateStep(id, step) {
  if (!stepIdPattern.test(id)) fail(`invalid pipeline step id: ${id}`);
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    fail(`pipeline step must be an object: ${id}`);
  }
  if (
    typeof step.name !== "string" ||
    !step.name.trim() ||
    step.name.length > 100 ||
    [...step.name].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) ||
    step.runner !== "package-script"
  ) {
    fail(`pipeline step ${id} requires a name and runner=package-script`);
  }
  if (
    !Array.isArray(step.scripts) ||
    step.scripts.length === 0 ||
    step.scripts.some((script) => !scriptPattern.test(script)) ||
    new Set(step.scripts).size !== step.scripts.length
  ) {
    fail(`pipeline step ${id} has invalid package scripts`);
  }
  if (Object.hasOwn(step, "required")) {
    fail(
      `pipeline step ${id} uses removed field required; every referenced step is required`,
    );
  }
  assertKnownKeys(
    step,
    new Set(["name", "runner", "scripts", "timeoutSeconds", "provides"]),
    `pipeline step ${id}`,
  );
  if (
    !Number.isInteger(step.timeoutSeconds) ||
    step.timeoutSeconds < 1 ||
    step.timeoutSeconds > 3600
  ) {
    fail(`pipeline step ${id} timeoutSeconds must be between 1 and 3600`);
  }
  if (
    !Array.isArray(step.provides) ||
    step.provides.length === 0 ||
    step.provides.some((capability) => !capabilityPattern.test(capability)) ||
    new Set(step.provides).size !== step.provides.length
  ) {
    fail(`pipeline step ${id} has invalid capabilities`);
  }
}

function assertUniqueStepIds(ids, label) {
  const seen = new Set();
  for (const id of ids) {
    if (!stepIdPattern.test(id)) fail(`${label} has an invalid step id: ${id}`);
    if (seen.has(id)) fail(`${label} contains duplicate step: ${id}`);
    seen.add(id);
  }
}

export function resolvePipeline(config, pipelineId, stack = []) {
  if (!stepIdPattern.test(pipelineId))
    fail(`invalid pipeline id: ${pipelineId}`);
  const pipeline = config.pipelines?.[pipelineId];
  if (!pipeline) fail(`unknown quality pipeline: ${pipelineId}`);
  if (typeof pipeline !== "object" || Array.isArray(pipeline)) {
    fail(`quality pipeline must be an object: ${pipelineId}`);
  }
  if (stack.includes(pipelineId)) {
    fail(`pipeline inheritance cycle: ${[...stack, pipelineId].join(" -> ")}`);
  }
  const hasSteps = Array.isArray(pipeline.steps);
  const hasExtends = typeof pipeline.extends === "string";
  if (hasSteps === hasExtends) {
    fail(`pipeline ${pipelineId} must define exactly one of steps or extends`);
  }
  const appended = pipeline.append ?? [];
  if (!Array.isArray(appended) || (hasSteps && appended.length > 0)) {
    fail(`pipeline ${pipelineId} append requires extends`);
  }
  const own = hasSteps ? pipeline.steps : appended;
  assertUniqueStepIds(own, `pipeline ${pipelineId}`);
  const inherited = hasExtends
    ? resolvePipeline(config, pipeline.extends, [...stack, pipelineId])
    : [];
  const resolved = [...inherited, ...own];
  assertUniqueStepIds(resolved, `resolved pipeline ${pipelineId}`);
  for (const id of resolved) {
    if (!config.steps?.[id])
      fail(`pipeline ${pipelineId} references unknown step: ${id}`);
  }
  return resolved;
}

export function pipelineCapabilities(config, pipelineId) {
  return [
    ...new Set(
      resolvePipeline(config, pipelineId).flatMap(
        (stepId) => config.steps[stepId].provides,
      ),
    ),
  ];
}

export function assertPipelineCapabilities(
  config,
  pipelineId,
  requiredCapabilities,
  label = `pipeline ${pipelineId}`,
) {
  const provided = new Set(pipelineCapabilities(config, pipelineId));
  const missing = requiredCapabilities.filter(
    (capability) => !provided.has(capability),
  );
  if (missing.length) {
    fail(`${label} is missing capabilities: ${missing.join(", ")}`);
  }
}

export function resolveEntrypoint(config, entrypointId) {
  if (!fixedEntrypoints.includes(entrypointId)) {
    fail(`unknown quality entry point: ${entrypointId}`);
  }
  const entrypoint = config.entrypoints?.[entrypointId];
  if (
    !entrypoint ||
    typeof entrypoint !== "object" ||
    Array.isArray(entrypoint)
  ) {
    fail(`entrypoints.${entrypointId} must be an object`);
  }
  if (entrypointId === "loop") {
    if (
      entrypoint.pipelineFrom !== "scopeManifest" ||
      Object.keys(entrypoint).some((key) => key !== "pipelineFrom")
    ) {
      fail("entrypoints.loop must use pipelineFrom=scopeManifest");
    }
    return { id: entrypointId, pipelineFrom: entrypoint.pipelineFrom };
  }
  if (
    typeof entrypoint.pipeline !== "string" ||
    !config.pipelines?.[entrypoint.pipeline] ||
    Object.keys(entrypoint).some((key) => key !== "pipeline")
  ) {
    fail(
      `entrypoints.${entrypointId}.pipeline must reference a known pipeline`,
    );
  }
  return { id: entrypointId, pipelineId: entrypoint.pipeline };
}

export function entrypointStepIds(config) {
  const ids = new Set();
  for (const entrypointId of fixedEntrypoints) {
    const entrypoint = resolveEntrypoint(config, entrypointId);
    if (!entrypoint.pipelineId) continue;
    for (const stepId of resolvePipeline(config, entrypoint.pipelineId)) {
      ids.add(stepId);
    }
  }
  return [...ids];
}

export function resolveSliceCompilation(config) {
  const policy = config?.sliceCompilation;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    fail("sliceCompilation must be an object");
  }
  assertKnownKeys(policy, new Set(["sizingStrategy"]), "sliceCompilation");
  if (!sliceSizingStrategies.includes(policy.sizingStrategy)) {
    fail(
      `sliceCompilation.sizingStrategy must be one of: ${sliceSizingStrategies.join(", ")}`,
    );
  }
  return { sizingStrategy: policy.sizingStrategy };
}

export function validateQualityConfig(config, entrypointCapabilityFloors) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    fail("Parallel Slices configuration must be an object");
  }
  if (config.version !== 5) fail("Parallel Slices config version must be 5");
  if (config.$schema !== "./config.schema.json") {
    fail("$schema must reference ./config.schema.json");
  }
  if (
    Object.hasOwn(config, "workspaceMode") &&
    (typeof config.workspaceMode !== "string" || !config.workspaceMode.trim())
  ) {
    fail("workspaceMode must be a non-empty architecture-defined string");
  }
  if (!["auto", "npm", "pnpm", "yarn", "bun"].includes(config.packageManager)) {
    fail("packageManager must be auto, npm, pnpm, yarn, or bun");
  }
  resolveSliceCompilation(config);
  if (
    !Array.isArray(config.protectedBranches) ||
    config.protectedBranches.length === 0 ||
    config.protectedBranches.some(
      (branch) => typeof branch !== "string" || !branch.trim(),
    )
  ) {
    fail("protectedBranches must be a non-empty array");
  }
  if (
    !config.steps ||
    typeof config.steps !== "object" ||
    Array.isArray(config.steps)
  ) {
    fail("steps must be an object");
  }
  for (const [id, step] of Object.entries(config.steps)) validateStep(id, step);
  if (
    !config.pipelines ||
    typeof config.pipelines !== "object" ||
    Array.isArray(config.pipelines)
  ) {
    fail("pipelines must be an object");
  }
  for (const [pipelineId, pipeline] of Object.entries(config.pipelines)) {
    if (!stepIdPattern.test(pipelineId))
      fail(`invalid pipeline id: ${pipelineId}`);
    resolvePipeline(config, pipelineId);
    if (Object.hasOwn(pipeline, "requiresExplicitFlag")) {
      fail(`pipeline ${pipelineId} uses removed field requiresExplicitFlag`);
    }
    if (Object.hasOwn(pipeline, "requiredCapabilities")) {
      fail(`pipeline ${pipelineId} uses removed field requiredCapabilities`);
    }
    assertKnownKeys(
      pipeline,
      new Set(["steps", "extends", "append"]),
      `pipeline ${pipelineId}`,
    );
  }
  if (!config.branchPolicy?.pattern || !config.branchPolicy?.example) {
    fail("branchPolicy.pattern and branchPolicy.example are required");
  }
  const branchPattern = new RegExp(config.branchPolicy.pattern);
  if (!branchPattern.test(config.branchPolicy.example)) {
    fail("branchPolicy.example must match branchPolicy.pattern");
  }
  const automationPatterns = config.branchPolicy.automationPatterns ?? [];
  assertKnownKeys(
    config.branchPolicy,
    new Set(["pattern", "example", "automationPatterns"]),
    "branchPolicy",
  );
  if (!Array.isArray(automationPatterns)) {
    fail("branchPolicy.automationPatterns must be an array");
  }
  for (const pattern of automationPatterns) {
    if (typeof pattern !== "string") {
      fail("branchPolicy.automationPatterns must contain strings");
    }
    new RegExp(pattern);
  }
  if (Object.hasOwn(config, "gitHooks")) {
    fail("gitHooks was replaced by entrypoints");
  }
  assertKnownKeys(
    config,
    new Set([
      "$schema",
      "version",
      "workspaceMode",
      "sliceCompilation",
      "packageManager",
      "protectedBranches",
      "branchPolicy",
      "steps",
      "pipelines",
      "entrypoints",
    ]),
    "Parallel Slices configuration",
  );
  if (
    !config.entrypoints ||
    typeof config.entrypoints !== "object" ||
    Array.isArray(config.entrypoints)
  ) {
    fail("entrypoints must be an object");
  }
  if (
    !entrypointCapabilityFloors ||
    typeof entrypointCapabilityFloors !== "object" ||
    Array.isArray(entrypointCapabilityFloors)
  ) {
    fail("selected architecture must define entrypoint capability floors");
  }
  const entrypointNames = Object.keys(config.entrypoints);
  const unexpected = entrypointNames.filter(
    (entrypoint) => !fixedEntrypoints.includes(entrypoint),
  );
  if (unexpected.length) {
    fail(`unknown quality entry points: ${unexpected.join(", ")}`);
  }
  for (const entrypointId of fixedEntrypoints) {
    const entrypoint = resolveEntrypoint(config, entrypointId);
    if (entrypoint.pipelineId) {
      assertPipelineCapabilities(
        config,
        entrypoint.pipelineId,
        entrypointCapabilityFloors[entrypointId],
        `entrypoints.${entrypointId}`,
      );
    }
  }
  return Object.values(config.steps);
}

export function isAutomationBranch(branch, config) {
  return (config.branchPolicy.automationPatterns || []).some((pattern) =>
    new RegExp(pattern).test(branch),
  );
}

export function assertBranchAllowed(branch, config, options = {}) {
  if (!branch) fail("a named branch is required; detached HEAD is not allowed");
  if (config.protectedBranches.includes(branch)) {
    fail(
      `commits and direct pushes are forbidden on protected branch: ${branch}`,
    );
  }
  const automated = isAutomationBranch(branch, config);
  if (options.allowAutomation && automated) return;
  if (!new RegExp(config.branchPolicy.pattern).test(branch)) {
    fail(
      `branch name does not match policy; use a name such as ${config.branchPolicy.example}`,
    );
  }
}

export function inspectProjectChecks(root, config, stepIds) {
  const pkg = readPackage(root);
  const manager = detectPackageManager(root, config.packageManager);
  const resolved = [];
  const missing = [];
  for (const id of stepIds) {
    const step = config.steps[id];
    if (!step) fail(`unknown quality step: ${id}`);
    const script = step.scripts.find((candidate) => pkg.scripts?.[candidate]);
    if (script) resolved.push({ ...step, id, script });
    else missing.push({ ...step, id });
  }
  return { manager, missing, resolved };
}

export function runProjectChecks(root, config, stepIds, observer = {}) {
  const inspection = inspectProjectChecks(root, config, stepIds);
  if (inspection.missing.length) {
    const details = inspection.missing
      .map((step) => `${step.name}: ${step.scripts.join(" or ")}`)
      .join("; ");
    fail(`required package scripts are missing: ${details}`);
  }
  for (const step of inspection.resolved) {
    const [command, args] = packageManagerCommand(inspection.manager, [
      "run",
      step.script,
    ]);
    observer.onStepStart?.(step);
    try {
      run(root, command, args, step);
      observer.onStepPassed?.(step);
    } catch (error) {
      observer.onStepFailed?.(step, error);
      throw error;
    }
  }
}

export function runPipeline(root, config, pipelineId, observer = {}) {
  const steps = resolvePipeline(config, pipelineId);
  console.log(`pipeline ${pipelineId}: ${steps.join(" -> ")}`);
  runProjectChecks(root, config, steps, observer);
}

export function installDependencies(root, config) {
  const manager = detectPackageManager(root, config.packageManager);
  const args = {
    npm: ["ci"],
    pnpm: ["install", "--frozen-lockfile"],
    yarn: ["install", "--immutable"],
    bun: ["install", "--frozen-lockfile"],
  }[manager];
  if (!args) fail(`unsupported package manager: ${manager}`);
  const [command, commandArgs] = packageManagerCommand(manager, args);
  run(
    root,
    command,
    commandArgs,
    { name: "frozen dependency install", timeoutSeconds: 1800 },
    { HUSKY: "0" },
  );
}
