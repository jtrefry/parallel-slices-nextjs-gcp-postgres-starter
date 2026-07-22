import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { assertSafeRelativePath } from "./scope-policy.mjs";

function fail(message) {
  throw new Error(message);
}

function assertInsideRoot(rootReal, path, label) {
  const absolute = resolve(rootReal, path);
  if (absolute !== rootReal && !absolute.startsWith(`${rootReal}${sep}`)) {
    fail(`${label} escapes the repository: ${path}`);
  }
  return absolute;
}

function ensureSafeDirectory(rootReal, directory) {
  const relativeDirectory = relative(rootReal, directory);
  let current = rootReal;
  for (const segment of relativeDirectory.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    if (existsSync(current)) {
      if (lstatSync(current).isSymbolicLink()) {
        fail(
          `refusing review artifact directory symlink: ${relative(rootReal, current)}`,
        );
      }
      continue;
    }
    mkdirSync(current);
  }
}

function assertWritableArtifact(rootReal, path) {
  const absolute = assertInsideRoot(rootReal, path, "review artifact");
  ensureSafeDirectory(rootReal, dirname(absolute));
  if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
    fail(`refusing symlinked review artifact: ${path}`);
  }
  return absolute;
}

export function resolveReviewArtifactPaths(manifest) {
  if (!manifest.review) {
    fail(
      "scope manifest must declare review=docs/plans/reviews/<feature>/<slice>.json",
    );
  }
  assertSafeRelativePath(manifest.review, "review artifact");
  if (!/^docs\/plans\/reviews\/.+\.json$/.test(manifest.review)) {
    fail("review artifact must be a JSON file under docs/plans/reviews");
  }
  return {
    json: manifest.review,
    markdown: manifest.review.replace(/\.json$/, ".md"),
  };
}

export function acquireReviewLock(root, paths) {
  const rootReal = realpathSync(root);
  const relativePath = `${paths.json}.lock`;
  const absolutePath = assertWritableArtifact(rootReal, relativePath);
  let descriptor;
  try {
    descriptor = openSync(absolutePath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      fail(
        `review lock already exists: ${relativePath}; wait for the active review or verify it stopped before removing the lock`,
      );
    }
    throw error;
  }
  writeFileSync(
    descriptor,
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
  );
  return { absolutePath, descriptor, relativePath };
}

export function releaseReviewLock(lock) {
  closeSync(lock.descriptor);
  if (existsSync(lock.absolutePath)) unlinkSync(lock.absolutePath);
}

export function assertNoReviewTemporaries(root, paths) {
  const rootReal = realpathSync(root);
  const directory = dirname(
    assertInsideRoot(rootReal, paths.json, "review artifact"),
  );
  if (!existsSync(directory)) return;
  const names = new Set([
    `${paths.json.split("/").at(-1)}.tmp-`,
    `${paths.markdown.split("/").at(-1)}.tmp-`,
  ]);
  const stale = readdirSync(directory)
    .filter((name) => [...names].some((prefix) => name.startsWith(prefix)))
    .sort();
  if (stale.length) {
    fail(
      `stale review temporary files require inspection before retry: ${stale.join(", ")}`,
    );
  }
}

function validateExistingLedger(ledger, scopeFile, manifest) {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    fail("existing review artifact must be a JSON object");
  }
  if (ledger.version !== 1) fail("existing review artifact version must be 1");
  if (ledger.scopeFile !== scopeFile || ledger.slice !== manifest.slice) {
    fail("existing review artifact belongs to a different scope manifest");
  }
  if (!Array.isArray(ledger.attempts)) {
    fail("existing review artifact attempts must be an array");
  }
}

export function loadReviewLedger(root, scopeFile, manifest, config, now) {
  const rootReal = realpathSync(root);
  const paths = resolveReviewArtifactPaths(manifest);
  const jsonPath = assertInsideRoot(rootReal, paths.json, "review artifact");
  let ledger;
  if (existsSync(jsonPath)) {
    if (lstatSync(jsonPath).isSymbolicLink()) {
      fail(`refusing symlinked review artifact: ${paths.json}`);
    }
    try {
      ledger = JSON.parse(readFileSync(jsonPath, "utf8"));
    } catch (error) {
      fail(
        `cannot parse existing review artifact ${paths.json}: ${error.message}`,
      );
    }
    validateExistingLedger(ledger, scopeFile, manifest);
    for (const attempt of ledger.attempts) {
      if (new Set(["in_progress", "waiting_for_auth"]).has(attempt.status)) {
        attempt.status = "interrupted";
        attempt.completedAt = now;
        attempt.outcome =
          "The previous runner stopped before recording a terminal result.";
      }
    }
  } else {
    ledger = {
      version: 1,
      scopeFile,
      slice: manifest.slice,
      requirements: manifest.requirements.split(","),
      attempts: [],
    };
  }
  ledger.configuration = {
    billingPolicy: config.billingPolicy,
    maxRounds: config.maxRounds,
    turnTimeoutSeconds: config.turnTimeoutSeconds,
    overallTimeoutSeconds: config.overallTimeoutSeconds,
    authWaitSeconds: config.authWaitSeconds,
    reviewers: config.reviewers.map(({ id, provider, model, effort }) => ({
      id,
      provider,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    })),
  };
  return { ledger, paths };
}

export function beginReviewAttempt(
  ledger,
  fingerprint,
  changedPaths,
  configuration,
  now,
) {
  const attempt = {
    number: ledger.attempts.length + 1,
    fingerprint,
    changedPaths: [...changedPaths],
    status: "in_progress",
    startedAt: now,
    completedAt: null,
    outcome: null,
    rounds: [],
    findings: [],
    nextFindingNumber: 1,
    activeReviewer: null,
    configuration: JSON.parse(JSON.stringify(configuration)),
  };
  ledger.attempts.push(attempt);
  return attempt;
}

function markdownCell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\r?\n/g, " ")
    .trim();
}

function markdownProse(value) {
  return String(value ?? "")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderFindings(findings) {
  if (!findings.length) return "No findings were recorded.\n";
  const sections = [];
  for (const finding of findings) {
    const evidence = finding.evidence
      .map(
        (item) =>
          `- \`${item.path}:${item.line}\` — ${markdownProse(item.detail)}`,
      )
      .join("\n");
    const votes = Object.entries(finding.votes)
      .map(([reviewer, vote]) => `${reviewer}: ${vote.disposition}`)
      .join(", ");
    sections.push(
      `### ${finding.id}: ${finding.title}\n\n` +
        `- Severity: ${finding.severity}\n` +
        `- Category: ${finding.category}\n` +
        `- Status: ${finding.status}\n` +
        `- Raised by: ${finding.raisedBy}\n` +
        `- Reviewer positions: ${votes || "none"}\n\n` +
        `${markdownProse(finding.description)}\n\n` +
        `Evidence:\n\n${evidence}\n\n` +
        `Recommendation: ${markdownProse(finding.recommendation)}\n`,
    );
  }
  return `${sections.join("\n")}\n`;
}

export function renderReviewMarkdown(ledger) {
  const reviewKind = ledger.attempts.at(-1)?.reviewKind ?? "slice";
  const lines = [
    `# ${reviewKind === "planning" ? "Planning" : `Slice ${ledger.slice}`} multi-agent review`,
    "",
    `Scope manifest: \`${ledger.scopeFile}\``,
    `Requirements: ${ledger.requirements.join(", ")}`,
    `Configured reviewers: ${ledger.configuration.reviewers.map((item) => item.id).join(", ") || "none"}`,
    `Maximum reconciliation rounds: ${ledger.configuration.maxRounds}`,
    "",
    "This document is generated from the adjacent JSON ledger. Review agents do",
    "not edit either artifact directly.",
    "",
  ];
  for (const attempt of ledger.attempts) {
    const configuration = attempt.configuration ?? ledger.configuration;
    lines.push(
      `## Attempt ${attempt.number}: ${attempt.status}`,
      "",
      `- Source fingerprint: \`${attempt.fingerprint}\``,
      ...(attempt.contractFingerprint
        ? [
            `- Planning contract fingerprint: \`${attempt.contractFingerprint}\``,
          ]
        : []),
      `- Started: ${attempt.startedAt}`,
      `- Completed: ${attempt.completedAt || "pending"}`,
      `- Outcome: ${attempt.outcome || "pending"}`,
      `- Reviewers: ${configuration.reviewers.map((item) => item.id).join(", ")}`,
      `- Maximum rounds: ${configuration.maxRounds}`,
      `- Changed paths: ${attempt.changedPaths.map((path) => `\`${path}\``).join(", ")}`,
      "",
    );
    for (const round of attempt.rounds) {
      lines.push(
        `### Round ${round.number}`,
        "",
        "| Reviewer | Provider | Verdict | Duration | Summary |",
        "| --- | --- | --- | ---: | --- |",
      );
      for (const turn of round.turns) {
        lines.push(
          `| ${markdownCell(turn.reviewerId)} | ${markdownCell(turn.provider)} | ${markdownCell(turn.verdict)} | ${turn.durationMs} ms | ${markdownCell(turn.summary)} |`,
        );
      }
      lines.push("");
      for (const turn of round.turns) {
        if (!turn.assessments.length) continue;
        lines.push(`Reviewer comments from ${turn.reviewerId}:`, "");
        for (const assessment of turn.assessments) {
          lines.push(
            `- ${assessment.findingId}: ${assessment.disposition} — ${markdownProse(assessment.rationale)}`,
          );
        }
        lines.push("");
      }
    }
    lines.push("### Findings", "", renderFindings(attempt.findings));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function writeReviewLedger(root, paths, ledger) {
  const rootReal = realpathSync(root);
  const jsonPath = assertWritableArtifact(rootReal, paths.json);
  const markdownPath = assertWritableArtifact(rootReal, paths.markdown);
  const suffix = `.tmp-${process.pid}`;
  const jsonTemporary = `${jsonPath}${suffix}`;
  const markdownTemporary = `${markdownPath}${suffix}`;
  writeFileSync(jsonTemporary, `${JSON.stringify(ledger, null, 2)}\n`, {
    mode: 0o644,
  });
  writeFileSync(markdownTemporary, renderReviewMarkdown(ledger), {
    mode: 0o644,
  });
  renameSync(jsonTemporary, jsonPath);
  renameSync(markdownTemporary, markdownPath);
}
