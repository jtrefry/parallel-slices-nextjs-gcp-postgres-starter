import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import {
  assertPipelineCapabilities,
  entrypointCapabilityFloorsForRoot,
  resolveEntrypoint,
} from "./project-quality.mjs";
import { projectStages, readProjectState } from "./project-state.mjs";

const manifestKeys = new Set([
  "version",
  "revision",
  "supersedes",
  "correction",
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
  "lock",
  "review",
  "commit",
  "coverage",
  "allow",
  "coordinate",
]);
const repeatableManifestKeys = new Set([
  "allow",
  "coordinate",
  "coverage",
  "lock",
]);
const releaseClasses = new Set(["none", "developer"]);
export const scopeCoverageSurfaces = Object.freeze([
  "entrypoint",
  "contract",
  "consumer",
  "data-side-effect",
  "test",
  "operations",
]);
const scopeCoverageDispositions = new Set([
  "change",
  "preserve",
  "not-applicable",
]);

function fail(message) {
  throw new Error(message);
}

function git(args, options = {}) {
  try {
    const output = execFileSync("git", args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    return options.raw ? output : output.trim();
  } catch (error) {
    if (options.allowFailure) return null;
    const detail = error.stderr?.toString().trim();
    fail(detail || `git ${args.join(" ")} failed`);
  }
}

export function assertSafeRelativePath(value, label) {
  if (!value || value.startsWith("/") || value.includes("\\")) {
    fail(`${label} must be a non-empty repository-relative path`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    fail(`${label} contains an unsafe path segment: ${value}`);
  }
  if (/[^\x20-\x7E]/.test(value)) {
    fail(`${label} contains control or non-ASCII characters`);
  }
}

export function globToRegExp(pattern) {
  assertSafeRelativePath(pattern, "allow pattern");
  if (pattern === "*" || pattern === "**") {
    fail("repository-wide scope catchalls are forbidden");
  }
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else expression += ".*";
      } else expression += "[^/]*";
    } else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${expression}$`);
}

export function pathMatches(path, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

function staticPatternPrefix(pattern) {
  const wildcard = pattern.search(/[?*]/);
  return wildcard === -1 ? pattern : pattern.slice(0, wildcard);
}

export function patternsMayOverlap(left, right) {
  if (left === right) return true;
  const leftHasWildcard = /[?*]/.test(left);
  const rightHasWildcard = /[?*]/.test(right);
  if (!leftHasWildcard && !rightHasWildcard) return false;
  if (!leftHasWildcard) return globToRegExp(right).test(left);
  if (!rightHasWildcard) return globToRegExp(left).test(right);
  const leftPrefix = staticPatternPrefix(left);
  const rightPrefix = staticPatternPrefix(right);
  if (!leftPrefix || !rightPrefix) return true;
  if (globToRegExp(left).test(rightPrefix)) return true;
  if (globToRegExp(right).test(leftPrefix)) return true;
  return (
    leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix)
  );
}

export function parseManifestText(text) {
  const manifest = { allow: [], coordinate: [], coverage: [], lock: [] };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) fail(`invalid scope manifest line: ${rawLine}`);
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!manifestKeys.has(key)) fail(`unknown scope manifest key: ${key}`);
    if (!value) fail(`scope manifest value is empty: ${key}`);
    if (repeatableManifestKeys.has(key)) {
      if (manifest[key].includes(value)) {
        fail(`duplicate scope manifest ${key} entry: ${value}`);
      }
      manifest[key].push(value);
    } else {
      if (manifest[key] !== undefined) {
        fail(`duplicate scope manifest key: ${key}`);
      }
      manifest[key] = value;
    }
  }
  return manifest;
}

export function parseScopeCoverage(value) {
  const parts = value.split("|");
  if (parts.length !== 4) {
    fail("scope coverage must use surface|disposition|path-or-none|reason");
  }
  const [surface, disposition, target, reason] = parts;
  if (!scopeCoverageSurfaces.includes(surface)) {
    fail(`unknown scope coverage surface: ${surface}`);
  }
  if (!scopeCoverageDispositions.has(disposition)) {
    fail(`unknown scope coverage disposition: ${disposition}`);
  }
  if (!reason.trim() || reason.length > 500 || /[^\x20-\x7E]/.test(reason)) {
    fail("scope coverage reason must be 1-500 printable ASCII characters");
  }
  if (disposition === "not-applicable") {
    if (target !== "none") {
      fail("not-applicable scope coverage must use path-or-none=none");
    }
  } else {
    if (target === "none" || /[?*]/.test(target)) {
      fail(
        `${disposition} scope coverage must name one exact repository-relative path`,
      );
    }
    assertSafeRelativePath(target, "scope coverage path");
  }
  return { surface, disposition, target, reason };
}

export function validateScopeCoverage(manifest, options = {}) {
  const required = options.required === true;
  const root = options.root;
  if (!manifest.coverage?.length) {
    if (required) {
      fail(
        "compiled execution scope coverage is required for every impact surface",
      );
    }
    return [];
  }
  const coverage = manifest.coverage.map(parseScopeCoverage);
  const missing = scopeCoverageSurfaces.filter(
    (surface) => !coverage.some((entry) => entry.surface === surface),
  );
  if (missing.length) {
    fail(`scope coverage is missing impact surfaces: ${missing.join(", ")}`);
  }
  for (const entry of coverage) {
    if (entry.disposition === "change") {
      if (!pathMatches(entry.target, manifest.allow)) {
        fail(
          `changed scope coverage path is outside worker allow scope: ${entry.target}`,
        );
      }
    } else if (
      entry.disposition === "preserve" &&
      pathMatches(entry.target, manifest.allow)
    ) {
      fail(
        `preserved scope coverage path must remain outside worker allow scope: ${entry.target}`,
      );
    } else if (
      entry.disposition === "preserve" &&
      root &&
      !existsSync(resolve(root, entry.target))
    ) {
      fail(`preserved scope coverage path does not exist: ${entry.target}`);
    }
  }
  const changedTargets = coverage
    .filter((entry) => entry.disposition === "change")
    .map((entry) => entry.target);
  const unexplained = manifest.allow.filter(
    (pattern) =>
      !changedTargets.some((target) => globToRegExp(pattern).test(target)),
  );
  if (unexplained.length) {
    fail(
      `worker allow entries lack changed scope coverage: ${unexplained.join(", ")}`,
    );
  }
  return coverage;
}

export function validateManifest(manifest, scopeFile, root, config) {
  if (!new Set(["1", "2"]).has(manifest.version)) {
    fail("scope manifest version must be 1 or 2");
  }
  if (!/^docs\/plans\/.+\.md$/.test(manifest.plan || "")) {
    fail("plan must be a Markdown file under docs/plans");
  }
  assertSafeRelativePath(manifest.plan, "plan");
  if (!existsSync(resolve(root, manifest.plan))) {
    fail(`plan does not exist: ${manifest.plan}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.slice || "")) {
    fail("scope manifest has an invalid slice ID");
  }
  if (
    !/^[A-Za-z][A-Za-z0-9._-]*(,[A-Za-z][A-Za-z0-9._-]*)*$/.test(
      manifest.requirements || "",
    )
  ) {
    fail("requirements must be comma-separated stable IDs");
  }
  if (!manifest.observable) fail("scope manifest is missing observable");
  if (manifest.version === "2") {
    const revision = manifest.revision ?? "1";
    if (!/^[1-9][0-9]*$/.test(revision)) {
      fail("scope manifest revision must be a positive integer");
    }
    if (revision === "1" && (manifest.supersedes || manifest.correction)) {
      fail("initial scope manifest revision cannot supersede another manifest");
    }
    if (revision !== "1") {
      if (!manifest.supersedes || !manifest.correction) {
        fail(
          "corrected scope manifest revision requires supersedes and correction",
        );
      }
      assertSafeRelativePath(manifest.supersedes, "superseded scope manifest");
      assertSafeRelativePath(manifest.correction, "scope correction record");
      if (!/^docs\/plans\/scopes\/.+\.scope$/.test(manifest.supersedes)) {
        fail("supersedes must name a scope manifest under docs/plans/scopes");
      }
      if (
        !/^docs\/plans\/corrections\/[^/]+\/[^/]+\.json$/.test(
          manifest.correction,
        )
      ) {
        fail("correction must name a JSON record under docs/plans/corrections");
      }
      if (!existsSync(resolve(root, manifest.supersedes))) {
        fail(
          `superseded scope manifest does not exist: ${manifest.supersedes}`,
        );
      }
      if (!existsSync(resolve(root, manifest.correction))) {
        fail(`scope correction record does not exist: ${manifest.correction}`);
      }
    }
    if (
      manifest.depends_on !== "none" &&
      !/^[A-Za-z0-9][A-Za-z0-9._-]*(,[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(
        manifest.depends_on || "",
      )
    ) {
      fail("depends_on must be none or comma-separated slice IDs");
    }
    if (manifest.parallel !== "allowed" && manifest.parallel !== "forbidden") {
      fail("parallel must be allowed or forbidden");
    }
    if (manifest.parallel === "forbidden" && !manifest.parallel_reason) {
      fail("parallel=forbidden requires parallel_reason");
    }
    if (manifest.parallel === "allowed" && manifest.parallel_reason) {
      fail("parallel_reason is only valid when parallel=forbidden");
    }
    for (const lock of manifest.lock) {
      if (!/^[a-z][a-z0-9:-]*$/.test(lock)) {
        fail(`invalid logical resource lock: ${lock}`);
      }
    }
    if (!/^docs\/plans\/loop-runs\/[^/]+\.json$/.test(manifest.state || "")) {
      fail("state must be a JSON file under docs/plans/loop-runs");
    }
    assertSafeRelativePath(manifest.state, "run state");
    if (!existsSync(resolve(root, manifest.state))) {
      fail(`run state does not exist: ${manifest.state}`);
    }
    if (
      !/^(?:feat|fix|bugfix|hotfix|chore|release|docs|test|refactor|perf|ci|build)(?:\([a-z0-9._-]+\))?!?: .+/.test(
        manifest.commit || "",
      )
    ) {
      fail(
        "commit must be a conventional subject describing the slice outcome",
      );
    }
  }
  if (
    !["contract-ready", "foundation-ready"].includes(manifest.minimum_stage)
  ) {
    fail("minimum_stage must be contract-ready or foundation-ready");
  }
  const projectState = readProjectState(root);
  if (
    projectStages.indexOf(projectState.stage) <
    projectStages.indexOf(manifest.minimum_stage)
  ) {
    fail(
      `project stage ${projectState.stage} does not satisfy minimum_stage=${manifest.minimum_stage}`,
    );
  }
  if (!releaseClasses.has(manifest.release_notes)) {
    fail("release_notes must be none or developer");
  }
  resolveEntrypoint(config, "loop");
  if (!config.pipelines[manifest.gate]) {
    fail(`gate references unknown pipeline: ${manifest.gate}`);
  }
  assertPipelineCapabilities(
    config,
    manifest.gate,
    entrypointCapabilityFloorsForRoot(root).loop,
    `scope manifest pipeline ${manifest.gate}`,
  );
  if (manifest.allow.length === 0) fail("scope manifest has no allow entries");
  for (const pattern of manifest.allow) globToRegExp(pattern);
  for (const pattern of manifest.coordinate) globToRegExp(pattern);
  validateScopeCoverage(manifest, { root });
  if (manifest.version === "1") {
    if (!pathMatches(manifest.plan, manifest.allow)) {
      fail("manifest must allow its plan path");
    }
    if (!pathMatches(scopeFile, manifest.allow)) {
      fail("manifest must allow its own path");
    }
  } else {
    if (manifest.coordinate.length === 0) {
      fail("version 2 manifest has no root-owned coordinate entries");
    }
    if (!pathMatches(manifest.state, manifest.coordinate)) {
      fail("version 2 manifest must coordinate its run-state path");
    }
    for (const immutablePath of [manifest.plan, scopeFile]) {
      if (
        pathMatches(immutablePath, manifest.allow) ||
        pathMatches(immutablePath, manifest.coordinate)
      ) {
        fail(`immutable plan contract must not be writable: ${immutablePath}`);
      }
    }
    for (const allowed of manifest.allow) {
      const overlap = manifest.coordinate.find((coordinated) =>
        patternsMayOverlap(allowed, coordinated),
      );
      if (overlap) {
        fail(
          `worker and coordinator paths may overlap: ${allowed} and ${overlap}`,
        );
      }
    }
  }
  if (manifest.version === "2" && manifest.review === undefined) {
    fail("version 2 manifest must declare a review artifact");
  }
  if (manifest.review !== undefined) {
    assertSafeRelativePath(manifest.review, "review artifact");
    if (!/^docs\/plans\/reviews\/.+\.json$/.test(manifest.review)) {
      fail("review must be a JSON file under docs/plans/reviews");
    }
    const reviewMarkdown = manifest.review.replace(/\.json$/, ".md");
    const reviewPatterns =
      manifest.version === "2" ? manifest.coordinate : manifest.allow;
    if (!pathMatches(manifest.review, reviewPatterns)) {
      fail(
        `manifest must ${manifest.version === "2" ? "coordinate" : "allow"} its JSON review artifact`,
      );
    }
    if (!pathMatches(reviewMarkdown, reviewPatterns)) {
      fail(
        `manifest must ${manifest.version === "2" ? "coordinate" : "allow"} its Markdown review artifact`,
      );
    }
  }
}

export function workingChangedFiles(root, base) {
  const files = new Set();
  const tracked = git(
    ["diff", "--name-only", "--diff-filter=ACMRD", "-z", base, "--"],
    { cwd: root, raw: true },
  );
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    raw: true,
  });
  for (const output of [tracked, untracked]) {
    for (const file of output.split("\0")) if (file) files.add(file);
  }
  return [...files].sort();
}

export function requireCommittedContract(root, paths) {
  for (const path of paths) {
    if (
      git(["ls-files", "--error-unmatch", path], {
        cwd: root,
        allowFailure: true,
      }) === null
    ) {
      fail(
        `plan contract must be tracked and committed before implementation: ${path}`,
      );
    }
    if (
      git(["diff", "--quiet", "HEAD", "--", path], {
        cwd: root,
        allowFailure: true,
      }) === null
    ) {
      fail(
        `plan contract must be unchanged from HEAD before implementation: ${path}`,
      );
    }
  }
}

export function requireTrackedPaths(root, paths) {
  for (const path of paths) {
    if (
      git(["ls-files", "--error-unmatch", path], {
        cwd: root,
        allowFailure: true,
      }) === null
    ) {
      fail(`required path must be tracked before implementation: ${path}`);
    }
  }
}

export function validateDeveloperNote(content, path) {
  const sections = [
    "## Summary",
    "## Technical impact",
    "## Validation",
    "## Rollout and monitoring",
  ];
  if (
    !/^# .+/m.test(content) ||
    !/^Type: (Added|Changed|Fixed|Security|Deprecated|Removed|Operations)$/m.test(
      content,
    )
  ) {
    fail(`developer release note has an invalid header: ${path}`);
  }
  if (
    !/^Area: .+/m.test(content) ||
    sections.some((section) => !content.includes(section))
  ) {
    fail(`developer release note does not match its template: ${path}`);
  }
  if (content.includes("<")) {
    fail(`developer release note contains a placeholder: ${path}`);
  }
}

export function validateReleaseNotes(root, classification, changed) {
  const devPrefix = "docs/releases/developer/unreleased/";
  const validName = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
  const dev = changed.filter((path) => path.startsWith(devPrefix));
  for (const path of dev) {
    if (!validName.test(basename(path))) {
      fail(`invalid release-note filename: ${path}`);
    }
  }
  if (classification === "none" && dev.length) {
    fail("release_notes=none but a release-note fragment changed");
  }
  if (classification === "developer" && dev.length === 0) {
    fail("release_notes=developer requires a developer fragment");
  }
  for (const path of dev) {
    validateDeveloperNote(readFileSync(resolve(root, path), "utf8"), path);
  }
}
