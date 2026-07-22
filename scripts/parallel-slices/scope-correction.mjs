import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { assertSafeRelativePath, parseScopeCoverage } from "./scope-policy.mjs";

const attestationKeys = Object.freeze([
  "requirementsUnchanged",
  "observableUnchanged",
  "subsystemsUnchanged",
  "nonGoalsPreserved",
  "securityAndPrivacyPolicyUnchanged",
  "migrationUnchanged",
  "deploymentAndExternalActionsUnchanged",
]);
const recordKeys = Object.freeze([
  "$schema",
  "version",
  "plan",
  "planCommit",
  "slice",
  "previousManifest",
  "replacementManifest",
  "reason",
  "discoveryEvidence",
  "addedAllow",
  "attestations",
]);

function fail(message) {
  throw new Error(message);
}

function assertExactKeys(value, keys, label) {
  const actual = Object.keys(value ?? {}).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function assertEvidence(values, label) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some(
      (value) =>
        typeof value !== "string" || !value.trim() || value.length > 2000,
    ) ||
    new Set(values).size !== values.length
  ) {
    fail(`${label} must contain unique non-empty evidence`);
  }
}

export function readScopeCorrection(root, path) {
  assertSafeRelativePath(path, "scope correction record");
  if (!/^docs\/plans\/corrections\/[^/]+\/[^/]+\.json$/.test(path)) {
    fail("scope correction record must be under docs/plans/corrections");
  }
  if (!existsSync(resolve(root, path))) {
    fail(`scope correction record does not exist: ${path}`);
  }
  let record;
  try {
    record = JSON.parse(readFileSync(resolve(root, path), "utf8"));
  } catch (error) {
    fail(`scope correction record is invalid JSON: ${error.message}`);
  }
  assertExactKeys(record, recordKeys, "scope correction record");
  if (
    record.$schema !==
      "../../../../.parallel-slices/scope-correction.schema.json" ||
    record.version !== 1
  ) {
    fail("scope correction record has an invalid schema or version");
  }
  for (const [label, value] of [
    ["plan", record.plan],
    ["previous manifest", record.previousManifest],
    ["replacement manifest", record.replacementManifest],
  ]) {
    assertSafeRelativePath(value, `scope correction ${label}`);
  }
  if (!/^[0-9a-f]{40}$/.test(record.planCommit || "")) {
    fail("scope correction planCommit must be a full commit SHA");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record.slice || "")) {
    fail("scope correction slice is invalid");
  }
  if (
    typeof record.reason !== "string" ||
    !record.reason.trim() ||
    record.reason.length > 2000
  ) {
    fail("scope correction reason must be non-empty text");
  }
  assertEvidence(
    record.discoveryEvidence,
    "scope correction discoveryEvidence",
  );
  assertEvidence(record.addedAllow, "scope correction addedAllow");
  for (const path of record.addedAllow) {
    assertSafeRelativePath(path, "scope correction added allow path");
    if (/[?*]/.test(path)) {
      fail(`scope correction addedAllow must use exact paths: ${path}`);
    }
  }
  assertExactKeys(
    record.attestations,
    attestationKeys,
    "scope correction attestations",
  );
  for (const key of attestationKeys) {
    if (record.attestations[key] !== true) {
      fail(`scope correction attestation must be true: ${key}`);
    }
  }
  return record;
}

function sameField(previous, replacement, field) {
  if (previous[field] !== replacement[field]) {
    fail(`scope correction cannot change manifest ${field}`);
  }
}

export function validateScopeReplacement(options) {
  const { previous, replacement, record, state, replacementPath } = options;
  for (const field of [
    "version",
    "plan",
    "state",
    "slice",
    "requirements",
    "depends_on",
    "observable",
    "minimum_stage",
    "release_notes",
    "gate",
    "parallel",
    "parallel_reason",
    "commit",
  ]) {
    sameField(previous, replacement, field);
  }
  const previousRevision = Number(previous.revision ?? "1");
  if (
    Number(replacement.revision) !== previousRevision + 1 ||
    replacement.supersedes !== options.previousPath ||
    replacement.correction !== options.correctionPath
  ) {
    fail("scope correction replacement has an invalid revision chain");
  }
  if (
    record.plan !== previous.plan ||
    record.planCommit !== state.planCommit ||
    record.slice !== previous.slice ||
    record.previousManifest !== options.previousPath ||
    record.replacementManifest !== replacementPath
  ) {
    fail("scope correction record does not match its manifests and run state");
  }
  const previousAllow = new Set(previous.allow);
  const addedAllow = replacement.allow.filter(
    (path) => !previousAllow.has(path),
  );
  if (previous.allow.some((path) => !replacement.allow.includes(path))) {
    fail("scope correction cannot remove existing worker allow paths");
  }
  if (
    JSON.stringify([...addedAllow].sort()) !==
    JSON.stringify([...record.addedAllow].sort())
  ) {
    fail("scope correction addedAllow does not match the replacement manifest");
  }
  if (addedAllow.some((path) => /[?*]/.test(path))) {
    fail("scope correction may add only exact worker paths");
  }
  const controlPath = addedAllow.find(
    (path) =>
      path.startsWith(".parallel-slices/runtime/") ||
      /^docs\/plans\/(?:loop-runs|scopes|reviews|corrections)\//.test(path),
  );
  if (controlPath) {
    fail(`scope correction cannot add a planning control path: ${controlPath}`);
  }
  if (previous.lock.some((lock) => !replacement.lock.includes(lock))) {
    fail("scope correction cannot remove existing logical locks");
  }
  const replacementCoverage = replacement.coverage.map(parseScopeCoverage);
  const removedCoverage = previous.coverage
    .filter((entry) => !replacement.coverage.includes(entry))
    .map(parseScopeCoverage);
  for (const removed of removedCoverage) {
    if (
      removed.disposition !== "not-applicable" ||
      !replacementCoverage.some(
        (entry) =>
          entry.surface === removed.surface &&
          entry.disposition === "change" &&
          addedAllow.includes(entry.target),
      )
    ) {
      fail(
        "scope correction may replace only a not-applicable surface with exact newly discovered change coverage",
      );
    }
  }
  const changedCoveragePaths = new Set(
    replacementCoverage
      .filter((entry) => entry.disposition === "change")
      .map((entry) => entry.target),
  );
  for (const path of addedAllow) {
    if (!changedCoveragePaths.has(path)) {
      fail(`scope correction added path lacks exact change coverage: ${path}`);
    }
  }
  if (replacement.review === previous.review) {
    fail("scope correction must use a new permanent slice-review artifact");
  }
  const expectedCoordinate = [
    replacement.state,
    replacement.review,
    replacement.review.replace(/\.json$/, ".md"),
  ].sort();
  if (
    JSON.stringify([...replacement.coordinate].sort()) !==
    JSON.stringify(expectedCoordinate)
  ) {
    fail(
      "corrected manifest coordinate paths must be its state and new review pair",
    );
  }
  return { addedAllow };
}
