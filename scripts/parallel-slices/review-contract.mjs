import { assertSafeRelativePath } from "./scope-policy.mjs";
import { containsUnsafeTextControl } from "./content-safety.mjs";

const severities = new Set(["critical", "high", "medium", "low"]);
const categories = new Set([
  "security",
  "correctness",
  "testing",
  "accessibility",
  "performance",
  "scalability",
  "architecture",
  "documentation",
  "release",
  "scope",
]);
const dispositions = new Set(["uphold", "dismiss"]);
const findingIdPattern = /^F[0-9]{3,}$/;

function fail(message) {
  throw new Error(message);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
}

function assertKeys(value, required, label) {
  const actual = Object.keys(value);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const unknown = actual.filter((key) => !required.includes(key));
  if (missing.length) fail(`${label} is missing fields: ${missing.join(", ")}`);
  if (unknown.length)
    fail(`${label} has unknown fields: ${unknown.join(", ")}`);
}

function assertText(value, label, maximum) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    containsUnsafeTextControl(value)
  ) {
    fail(`${label} must be non-empty text of at most ${maximum} characters`);
  }
}

export function validateReviewerResponse(response, expectedFindingIds = []) {
  assertObject(response, "reviewer response");
  assertKeys(
    response,
    ["verdict", "summary", "findings", "assessments"],
    "reviewer response",
  );
  if (!new Set(["approve", "request_changes"]).has(response.verdict)) {
    fail("reviewer verdict must be approve or request_changes");
  }
  assertText(response.summary, "reviewer summary", 4000);
  if (!Array.isArray(response.findings) || response.findings.length > 20) {
    fail("reviewer findings must be an array with at most 20 entries");
  }
  for (const [index, finding] of response.findings.entries()) {
    const label = `findings[${index}]`;
    assertObject(finding, label);
    assertKeys(
      finding,
      [
        "severity",
        "category",
        "title",
        "description",
        "evidence",
        "recommendation",
      ],
      label,
    );
    if (!severities.has(finding.severity)) fail(`${label}.severity is invalid`);
    if (!categories.has(finding.category)) fail(`${label}.category is invalid`);
    assertText(finding.title, `${label}.title`, 200);
    assertText(finding.description, `${label}.description`, 2000);
    assertText(finding.recommendation, `${label}.recommendation`, 2000);
    if (
      !Array.isArray(finding.evidence) ||
      finding.evidence.length === 0 ||
      finding.evidence.length > 10
    ) {
      fail(`${label}.evidence must contain between 1 and 10 entries`);
    }
    for (const [evidenceIndex, evidence] of finding.evidence.entries()) {
      const evidenceLabel = `${label}.evidence[${evidenceIndex}]`;
      assertObject(evidence, evidenceLabel);
      assertKeys(evidence, ["path", "line", "detail"], evidenceLabel);
      assertSafeRelativePath(evidence.path, `${evidenceLabel}.path`);
      if (!Number.isInteger(evidence.line) || evidence.line < 1) {
        fail(`${evidenceLabel}.line must be a positive integer`);
      }
      assertText(evidence.detail, `${evidenceLabel}.detail`, 1000);
    }
  }
  if (
    response.verdict === "approve" &&
    response.findings.some((finding) =>
      new Set(["critical", "high"]).has(finding.severity),
    )
  ) {
    fail("approve verdict cannot introduce a critical or high finding");
  }
  if (
    !Array.isArray(response.assessments) ||
    response.assessments.length > 200
  ) {
    fail("reviewer assessments must be an array with at most 200 entries");
  }
  const expected = new Set(expectedFindingIds);
  const assessed = new Set();
  for (const [index, assessment] of response.assessments.entries()) {
    const label = `assessments[${index}]`;
    assertObject(assessment, label);
    assertKeys(assessment, ["findingId", "disposition", "rationale"], label);
    if (!findingIdPattern.test(assessment.findingId)) {
      fail(`${label}.findingId is invalid`);
    }
    if (!expected.has(assessment.findingId)) {
      fail(
        `${label} references an unavailable finding: ${assessment.findingId}`,
      );
    }
    if (assessed.has(assessment.findingId)) {
      fail(`duplicate assessment for ${assessment.findingId}`);
    }
    assessed.add(assessment.findingId);
    if (!dispositions.has(assessment.disposition)) {
      fail(`${label}.disposition must be uphold or dismiss`);
    }
    assertText(assessment.rationale, `${label}.rationale`, 2000);
  }
  const missing = [...expected].filter((findingId) => !assessed.has(findingId));
  if (missing.length) {
    fail(`reviewer response did not assess findings: ${missing.join(", ")}`);
  }
  if (
    response.verdict === "request_changes" &&
    response.findings.length === 0 &&
    !response.assessments.some(
      (assessment) => assessment.disposition === "uphold",
    )
  ) {
    fail("request_changes verdict must introduce or uphold a finding");
  }
  return response;
}

export function parseJsonObject(text, label = "provider response") {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

export function parseMarkedJson(text) {
  const start = "PARALLEL_SLICES_REVIEW_JSON_BEGIN";
  const end = "PARALLEL_SLICES_REVIEW_JSON_END";
  const ansiEscape = new RegExp(
    `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
    "g",
  );
  const clean = text.replace(ansiEscape, "");
  const startIndex = clean.lastIndexOf(start);
  const endIndex = clean.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    fail("Antigravity response did not contain the required JSON markers");
  }
  return parseJsonObject(
    clean.slice(startIndex + start.length, endIndex).trim(),
    "Antigravity marked response",
  );
}

export const blockingSeverities = Object.freeze(["critical", "high"]);
