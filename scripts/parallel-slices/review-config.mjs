import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { containsUnsafeTextControl } from "./content-safety.mjs";

const reviewerIdPattern = /^[a-z][a-z0-9-]*$/;
const providers = new Set(["codex", "claude-code", "antigravity"]);
const billingPolicies = new Set(["subscription-only", "provider-managed"]);
const effortByProvider = Object.freeze({
  codex: new Set(["low", "medium", "high", "xhigh"]),
  "claude-code": new Set(["low", "medium", "high", "xhigh", "max"]),
  antigravity: new Set(),
});

function fail(message) {
  throw new Error(message);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
}

function assertKnownKeys(value, keys, label) {
  const unknown = Object.keys(value).filter((key) => !keys.has(key));
  if (unknown.length)
    fail(`${label} has unknown fields: ${unknown.join(", ")}`);
}

function assertBoundedInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
}

function assertSafeText(value, label, maximum) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    containsUnsafeTextControl(value)
  ) {
    fail(`${label} must be non-empty text of at most ${maximum} characters`);
  }
}

export function validateReviewConfig(config) {
  assertObject(config, "review configuration");
  assertKnownKeys(
    config,
    new Set([
      "$schema",
      "version",
      "enabled",
      "billingPolicy",
      "maxRounds",
      "turnTimeoutSeconds",
      "overallTimeoutSeconds",
      "authWaitSeconds",
      "reviewers",
    ]),
    "review configuration",
  );
  if (config.$schema !== "./review.schema.json") {
    fail("review $schema must reference ./review.schema.json");
  }
  if (config.version !== 1) fail("review configuration version must be 1");
  if (typeof config.enabled !== "boolean")
    fail("review enabled must be boolean");
  if (!billingPolicies.has(config.billingPolicy)) {
    fail("review billingPolicy must be subscription-only or provider-managed");
  }
  assertBoundedInteger(config.maxRounds, 1, 5, "review maxRounds");
  assertBoundedInteger(
    config.turnTimeoutSeconds,
    1,
    3600,
    "review turnTimeoutSeconds",
  );
  assertBoundedInteger(
    config.overallTimeoutSeconds,
    1,
    18000,
    "review overallTimeoutSeconds",
  );
  assertBoundedInteger(
    config.authWaitSeconds,
    1,
    3600,
    "review authWaitSeconds",
  );
  if (!Array.isArray(config.reviewers) || config.reviewers.length > 10) {
    fail("reviewers must be an array with at most 10 entries");
  }
  if (config.enabled && config.reviewers.length === 0) {
    fail("enabled review configuration requires at least one reviewer");
  }

  const ids = new Set();
  for (const [index, reviewer] of config.reviewers.entries()) {
    const label = `reviewers[${index}]`;
    assertObject(reviewer, label);
    assertKnownKeys(
      reviewer,
      new Set(["id", "provider", "model", "effort"]),
      label,
    );
    if (
      typeof reviewer.id !== "string" ||
      !reviewerIdPattern.test(reviewer.id) ||
      reviewer.id.length > 40
    ) {
      fail(`${label}.id must be a lowercase kebab-case identifier`);
    }
    if (ids.has(reviewer.id)) fail(`duplicate reviewer id: ${reviewer.id}`);
    ids.add(reviewer.id);
    if (!providers.has(reviewer.provider)) {
      fail(`${label}.provider must be codex, claude-code, or antigravity`);
    }
    if (reviewer.model !== undefined) {
      assertSafeText(reviewer.model, `${label}.model`, 100);
    }
    if (reviewer.effort !== undefined) {
      if (!effortByProvider[reviewer.provider].has(reviewer.effort)) {
        fail(`${label}.effort is not supported by ${reviewer.provider}`);
      }
    }
  }
  return config;
}

export function loadReviewConfig(root) {
  const path = resolve(root, ".parallel-slices/review.json");
  if (!existsSync(path)) fail(".parallel-slices/review.json is missing");
  if (lstatSync(path).isSymbolicLink()) {
    fail("refusing symlinked .parallel-slices/review.json");
  }
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot parse .parallel-slices/review.json: ${error.message}`);
  }
  return validateReviewConfig(config);
}

export const supportedReviewProviders = Object.freeze([...providers]);
