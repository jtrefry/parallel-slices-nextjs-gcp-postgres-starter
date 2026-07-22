import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const runtimeDirectory = ".parallel-slices-review-input";

function fail(message) {
  throw new Error(message);
}

function git(root, args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: options.encoding ?? "utf8",
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error.stderr?.toString().trim();
    fail(detail || `git ${args.join(" ")} failed`);
  }
}

function assertInsideRoot(rootReal, path, label) {
  const resolved = resolve(rootReal, path);
  if (resolved !== rootReal && !resolved.startsWith(`${rootReal}${sep}`)) {
    fail(`${label} escapes the repository: ${path}`);
  }
  return resolved;
}

export function listReviewFiles(root, excludePaths = []) {
  const excluded = new Set(excludePaths);
  const output = git(root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  return output
    .split("\0")
    .filter(Boolean)
    .filter((path) => !excluded.has(path))
    .filter((path) => existsSync(resolve(root, path)))
    .sort();
}

export function calculateRepositoryFingerprint(root, excludePaths = []) {
  const rootReal = realpathSync(root);
  const hash = createHash("sha256");
  const files = listReviewFiles(rootReal, excludePaths);
  for (const path of files) {
    const absolute = assertInsideRoot(rootReal, path, "review file");
    const stat = lstatSync(absolute);
    hash.update(`${path}\0${stat.mode & 0o777}\0`);
    if (stat.isSymbolicLink()) {
      hash.update(`link\0${readlinkSync(absolute)}\0`);
    } else if (stat.isFile()) {
      hash.update("file\0");
      hash.update(readFileSync(absolute));
      hash.update("\0");
    } else {
      fail(`review input is not a regular file or symlink: ${path}`);
    }
  }
  return { fingerprint: `sha256:${hash.digest("hex")}`, files };
}

function copyReviewFile(rootReal, snapshotRoot, path) {
  const source = assertInsideRoot(rootReal, path, "review file");
  const destination = assertInsideRoot(snapshotRoot, path, "snapshot file");
  const stat = lstatSync(source);
  mkdirSync(dirname(destination), { recursive: true });
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(source);
    if (isAbsolute(target)) {
      fail(`review input contains an absolute symlink: ${path}`);
    }
    let resolvedTarget;
    try {
      resolvedTarget = realpathSync(source);
    } catch {
      fail(`review input contains a broken symlink: ${path}`);
    }
    assertInsideRoot(
      rootReal,
      relative(rootReal, resolvedTarget),
      "symlink target",
    );
    symlinkSync(target, destination);
    return;
  }
  if (!stat.isFile()) fail(`review input is not a regular file: ${path}`);
  copyFileSync(source, destination);
  chmodSync(destination, stat.mode & 0o777);
}

export function createReviewSnapshot(root, options) {
  const rootReal = realpathSync(root);
  const excluded = options.excludePaths ?? [];
  const source = calculateRepositoryFingerprint(rootReal, excluded);
  if (source.files.some((path) => path.startsWith(`${runtimeDirectory}/`))) {
    fail(
      `repository path is reserved for review runtime data: ${runtimeDirectory}`,
    );
  }
  const snapshotRoot = mkdtempSync(
    resolve(tmpdir(), "parallel-slices-review-"),
  );
  for (const path of source.files) copyReviewFile(rootReal, snapshotRoot, path);

  const inputRoot = resolve(snapshotRoot, runtimeDirectory);
  mkdirSync(inputRoot, { recursive: true });
  const changedPaths = [...options.changedPaths].sort();
  const untracked = new Set(
    git(rootReal, ["ls-files", "--others", "--exclude-standard", "-z"])
      .split("\0")
      .filter(Boolean),
  );
  const trackedChanged = changedPaths.filter((path) => !untracked.has(path));
  const patchBase = options.base ?? "HEAD";
  const patch = trackedChanged.length
    ? git(rootReal, [
        "diff",
        "--binary",
        "--no-ext-diff",
        patchBase,
        "--",
        ...trackedChanged,
      ])
    : "";
  const patchPath = resolve(inputRoot, "authorized.patch");
  writeFileSync(patchPath, patch);
  const packetPath = resolve(inputRoot, "packet.md");
  writeFileSync(packetPath, "Review packet has not been initialized.\n");
  return {
    changedPaths,
    fingerprint: source.fingerprint,
    inputRoot,
    packetPath,
    patchPath,
    snapshotRoot,
  };
}

export function writeSnapshotPacket(snapshot, content) {
  writeFileSync(snapshot.packetPath, content);
}

export const reviewRuntimeDirectory = runtimeDirectory;
