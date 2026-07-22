import { blockingSeverities } from "./review-contract.mjs";

export function openFindingIds(attempt) {
  return attempt.findings
    .filter((finding) => finding.status === "open")
    .map((finding) => finding.id);
}

export function refreshFindingStatuses(attempt, reviewerIds) {
  for (const finding of attempt.findings) {
    const dismissedByAll = reviewerIds.every(
      (reviewerId) => finding.votes[reviewerId]?.disposition === "dismiss",
    );
    finding.status = dismissedByAll ? "dismissed" : "open";
  }
}

export function applyReviewerResponse(
  attempt,
  round,
  reviewer,
  response,
  durationMs,
  reviewerIds,
) {
  for (const assessment of response.assessments) {
    const finding = attempt.findings.find(
      (candidate) => candidate.id === assessment.findingId,
    );
    if (!finding) {
      throw new Error(
        `review response references missing finding: ${assessment.findingId}`,
      );
    }
    finding.votes[reviewer.id] = {
      disposition: assessment.disposition,
      rationale: assessment.rationale,
      round: round.number,
    };
  }

  const findingIds = [];
  for (const submitted of response.findings) {
    const id = `F${String(attempt.nextFindingNumber).padStart(3, "0")}`;
    attempt.nextFindingNumber += 1;
    findingIds.push(id);
    attempt.findings.push({
      id,
      ...submitted,
      raisedBy: reviewer.id,
      raisedInRound: round.number,
      status: "open",
      votes: {
        [reviewer.id]: {
          disposition: "uphold",
          rationale: "Reviewer raised this finding.",
          round: round.number,
        },
      },
    });
  }
  refreshFindingStatuses(attempt, reviewerIds);
  round.turns.push({
    reviewerId: reviewer.id,
    provider: reviewer.provider,
    providerVersion: reviewer.version,
    verdict: response.verdict,
    summary: response.summary,
    findingIds,
    assessments: response.assessments,
    durationMs,
  });
}

export function evaluateConsensus(attempt, round, reviewerIds) {
  const verdicts = new Map(
    round.turns.map((turn) => [turn.reviewerId, turn.verdict]),
  );
  const allApproved = reviewerIds.every(
    (reviewerId) => verdicts.get(reviewerId) === "approve",
  );
  const blocking = attempt.findings.filter(
    (finding) =>
      finding.status === "open" &&
      blockingSeverities.includes(finding.severity),
  );
  return {
    approved: allApproved && blocking.length === 0,
    allApproved,
    blockingFindingIds: blocking.map((finding) => finding.id),
  };
}

export function reviewPacketMarkdown(options) {
  const {
    attempt,
    manifest,
    reviewKind = "slice",
    roundNumber,
    reviewer,
    scopeFile,
    snapshot,
  } = options;
  const open = attempt.findings.filter((finding) => finding.status === "open");
  const findingText = open.length
    ? open
        .map(
          (finding) =>
            `#### ${finding.id}: ${finding.title}\n` +
            `Severity: ${finding.severity}\n` +
            `Category: ${finding.category}\n` +
            `Raised by: ${finding.raisedBy}\n` +
            `Description: ${finding.description}\n` +
            `Recommendation: ${finding.recommendation}\n` +
            `Current positions: ${Object.entries(finding.votes)
              .map(
                ([id, vote]) => `${id}=${vote.disposition} (${vote.rationale})`,
              )
              .join("; ")}\n`,
        )
        .join("\n")
    : "No open findings.";
  const priorTurns = attempt.rounds
    .flatMap((round) =>
      round.turns.map((turn) => ({ round: round.number, ...turn })),
    )
    .map(
      (turn) =>
        `- Round ${turn.round}, ${turn.reviewerId}: ${turn.verdict} — ${turn.summary}`,
    )
    .join("\n");
  const reviewInstructions =
    reviewKind === "planning"
      ? `Read the approved Product Plan, every active scope manifest, run state,
scope coverage, repository instructions, architecture contracts, current
implementation, tests, fixtures, and relevant history. Verify requirement and
preservation traceability; entrypoint, contract, consumer, data-side-effect,
test, generated-file, release, and operations closure; exact worker paths;
dependency and lock correctness; safe concurrency; negative outcomes; and
non-goal preservation. Request changes for an omitted path, unjustified
not-applicable disposition, changed subsystem or policy, hidden migration or
external action, or any slice that cannot be completed from its worker packet.
Do not approve based only on manifest self-assertions.`
      : `Read the root instructions, plan, scope manifest, authorized patch, changed
files, tests, release notes, and relevant surrounding code. Review security,
correctness, UX, accessibility, selected-architecture boundaries,
performance, scalability, workspace coverage, requirement-to-test traceability,
negative and preservation cases, documentation, release notes, and accidental
files.`;
  return `# Parallel Slices ${reviewKind} review packet

You are reviewer \`${reviewer.id}\` (${reviewer.provider}) in round ${roundNumber}.
Review the immutable source snapshot in this directory. Do not write files,
execute mutating commands, contact external systems, or change Git state.

## Contract

- Scope manifest: \`${scopeFile}\`
- Plan: \`${manifest.plan}\`
- Slice: ${manifest.slice}
- Requirements: ${manifest.requirements}
- Observable outcome: ${manifest.observable}
- Review kind: ${reviewKind}
- Source fingerprint: \`${attempt.fingerprint}\`
- Authorized patch: \`${snapshot.patchPath.slice(snapshot.snapshotRoot.length + 1)}\`
- Changed paths: ${attempt.changedPaths.map((path) => `\`${path}\``).join(", ")}

${reviewInstructions} Findings require precise repository-relative file and
line evidence.

## Prior reviewer summaries

${priorTurns || "No prior reviewer turns."}

## Open findings to assess

${findingText}

Return one assessment for every open finding listed above. Use \`uphold\` when
the finding remains valid and \`dismiss\` only when the evidence or another
review proves it invalid. Add new findings separately. An approval may include
non-blocking medium or low suggestions, but it cannot introduce critical or
high findings.
`;
}
