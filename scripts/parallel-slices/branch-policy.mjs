import { execFileSync } from "node:child_process";
import { basename } from "node:path";

import { assertNoPotentialSecretsAtRevision } from "./content-safety.mjs";
import {
  parseManifestText,
  pathMatches,
  requireCommittedContract,
  requireTrackedPaths,
  validateDeveloperNote,
  validateManifest,
} from "./scope-policy.mjs";

const developerReleasePrefix = "docs/releases/developer/unreleased/";
const developerReleaseName = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const zeroObject = /^0+$/;

function fail(message) {
  throw new Error(message);
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
    const detail = error.stderr?.toString().trim();
    fail(detail || `git ${args.join(" ")} failed`);
  }
}

function verifyCommit(root, revision) {
  return git(root, ["rev-parse", "--verify", `${revision}^{commit}`], {
    allowFailure: true,
  });
}

function mergeBase(root, revision) {
  const result = git(root, ["merge-base", "HEAD", revision], {
    allowFailure: true,
  });
  if (!result) fail(`cannot find a merge base with ${revision}`);
  return result.trim();
}

export function resolveBranchBase(root, config, options = {}) {
  if (options.base && !zeroObject.test(options.base)) {
    if (!verifyCommit(root, options.base)) {
      fail(`branch policy base is not an available commit: ${options.base}`);
    }
    return mergeBase(root, options.base);
  }

  const remote = options.remote || "origin";
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) {
    fail(`invalid Git remote name: ${remote}`);
  }
  const candidates = [];
  const remoteHead = git(
    root,
    ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`],
    { allowFailure: true },
  );
  if (remoteHead) candidates.push(remoteHead.trim());
  for (const branch of config.protectedBranches) {
    candidates.push(`refs/remotes/${remote}/${branch}`);
  }
  for (const candidate of [...new Set(candidates)]) {
    if (verifyCommit(root, candidate)) return mergeBase(root, candidate);
  }
  fail(
    `cannot determine the branch policy base; fetch ${remote}'s default branch or pass --base <ref>`,
  );
}

export function committedChangedEntries(root, base) {
  const output = git(root, [
    "diff",
    "--no-renames",
    "--name-status",
    "--diff-filter=ACMRD",
    "-z",
    `${base}..HEAD`,
    "--",
  ]);
  const fields = output.split("\0").filter(Boolean);
  if (fields.length % 2 !== 0) {
    fail("Git returned an invalid branch change set");
  }
  const entries = [];
  for (let index = 0; index < fields.length; index += 2) {
    entries.push({ status: fields[index], path: fields[index + 1] });
  }
  return entries;
}

function readCommittedFile(root, path) {
  return git(root, ["show", `HEAD:${path}`]);
}

function isScopeManifest(path) {
  const name = basename(path);
  return (
    /^docs\/plans\/scopes\/.+\.scope$/.test(path) &&
    (name === "_planning.scope" || !name.startsWith("_"))
  );
}

function loadBranchManifests(root, config, entries) {
  const scopeEntries = entries.filter((entry) => isScopeManifest(entry.path));
  const changedExisting = scopeEntries.filter((entry) => entry.status !== "A");
  if (changedExisting.length) {
    fail(
      `scope manifests are immutable; add a new manifest instead of changing:\n${changedExisting.map((entry) => `  ${entry.path}`).join("\n")}`,
    );
  }
  return scopeEntries.map((entry) => {
    const manifest = parseManifestText(readCommittedFile(root, entry.path));
    validateManifest(manifest, entry.path, root, config);
    requireCommittedContract(root, [manifest.plan, entry.path]);
    if (manifest.version === "2") requireTrackedPaths(root, [manifest.state]);
    return { ...manifest, path: entry.path };
  });
}

export function assertImmutablePlanContractHistory(root, base, manifests) {
  const paths = new Set();
  for (const manifest of manifests.filter(
    (item) => item.version === "2" || item.slice === "planning",
  )) {
    paths.add(manifest.path);
    paths.add(manifest.plan);
    if (manifest.correction) paths.add(manifest.correction);
  }
  for (const path of paths) {
    const existedAtBase =
      git(root, ["cat-file", "-e", `${base}:${path}`], {
        allowFailure: true,
      }) !== null;
    const commitCount = Number(
      git(root, ["rev-list", "--count", `${base}..HEAD`, "--", path]).trim(),
    );
    if (existedAtBase && commitCount !== 0) {
      fail(`approved plan contract changed after its base: ${path}`);
    }
    if (!existedAtBase && commitCount !== 1) {
      fail(
        `new plan contract must be added once and remain unchanged: ${path}`,
      );
    }
  }
}

function validateBranchReleaseNotes(root, manifests, changed) {
  const notes = changed.filter((path) =>
    path.startsWith(developerReleasePrefix),
  );
  for (const path of notes) {
    if (!developerReleaseName.test(basename(path))) {
      fail(`invalid release-note filename: ${path}`);
    }
    validateDeveloperNote(readCommittedFile(root, path), path);
  }
  for (const manifest of manifests) {
    if (manifest.release_notes !== "developer") continue;
    const matching = notes.filter((path) => pathMatches(path, manifest.allow));
    if (!matching.length) {
      fail(
        `slice ${manifest.slice} requires a developer release-note fragment allowed by ${manifest.path}`,
      );
    }
  }
}

export function runBranchPolicy(options) {
  const { root, config, base, exemptionReason } = options;
  const entries = committedChangedEntries(root, base);
  const changed = entries.map((entry) => entry.path).sort();
  assertNoPotentialSecretsAtRevision(root, changed, "HEAD", "branch file");
  if (!changed.length) {
    console.log(`branch policy passed: no committed changes since ${base}`);
    return { changed, manifests: [] };
  }
  if (exemptionReason) {
    console.log(
      `branch policy passed: ${exemptionReason}; secret-scanned ${changed.length} files`,
    );
    return { changed, manifests: [] };
  }

  const manifests = loadBranchManifests(root, config, entries);
  if (!manifests.length) {
    fail(
      "branch changes require at least one new committed scope manifest under docs/plans/scopes/",
    );
  }
  assertImmutablePlanContractHistory(root, base, manifests);
  const immutableContracts = new Set(
    manifests.flatMap((manifest) =>
      manifest.version === "2" || manifest.slice === "planning"
        ? [
            manifest.path,
            manifest.plan,
            ...(manifest.correction ? [manifest.correction] : []),
          ]
        : [],
    ),
  );
  const outside = changed.filter(
    (path) =>
      !immutableContracts.has(path) &&
      !manifests.some((manifest) =>
        pathMatches(path, [...manifest.allow, ...manifest.coordinate]),
      ),
  );
  if (outside.length) {
    fail(
      `branch paths are not covered by a new scope manifest:\n${outside.map((path) => `  ${path}`).join("\n")}`,
    );
  }
  validateBranchReleaseNotes(root, manifests, changed);
  console.log(
    `branch policy passed: ${changed.length} paths covered by ${manifests.length} scope manifest${manifests.length === 1 ? "" : "s"}`,
  );
  return { changed, manifests };
}
