import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

const secretPatterns = Object.freeze([
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bsk_live_[A-Za-z0-9]{16,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/,
]);
const machinePathPatterns = Object.freeze([
  /\/Users\/[A-Za-z0-9._-]+\//,
  /\/home\/[A-Za-z0-9._-]+\//,
  /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/,
]);

export function containsPotentialSecret(text) {
  return secretPatterns.some((pattern) => pattern.test(text));
}

export function containsMachineSpecificPath(text) {
  return machinePathPatterns.some((pattern) => pattern.test(text));
}

export function containsUnsafeTextControl(text) {
  return [...text].some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127;
  });
}

export function assertNoPotentialSecrets(root, paths, label = "file") {
  const prefix = `${resolve(root)}${sep}`;
  for (const path of paths) {
    const absolute = resolve(root, path);
    if (!absolute.startsWith(prefix))
      throw new Error(`unsafe ${label} path: ${path}`);
    if (!existsSync(absolute) || statSync(absolute).size > 2_000_000) continue;
    const content = readFileSync(absolute);
    if (content.includes(0)) continue;
    if (containsPotentialSecret(content.toString("utf8"))) {
      throw new Error(`possible secret detected in ${label}: ${path}`);
    }
  }
}

export function assertNoPotentialSecretsAtRevision(
  root,
  paths,
  revision = "HEAD",
  label = "committed file",
) {
  for (const path of paths) {
    if (
      !path ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((segment) => ["", ".", ".."].includes(segment))
    ) {
      throw new Error(`unsafe ${label} path: ${path}`);
    }
    const object = `${revision}:${path}`;
    let size;
    try {
      size = Number(
        execFileSync("git", ["cat-file", "-s", object], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim(),
      );
    } catch {
      continue;
    }
    if (!Number.isFinite(size) || size > 2_000_000) continue;
    const content = execFileSync("git", ["cat-file", "blob", object], {
      cwd: root,
      encoding: null,
      maxBuffer: 2_100_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (content.includes(0)) continue;
    if (containsPotentialSecret(content.toString("utf8"))) {
      throw new Error(`possible secret detected in ${label}: ${path}`);
    }
  }
}
