# Multi-agent review provider manual test script

Use this script to verify the installed Codex, Claude Code, Antigravity, or
Cursor Agent CLI integration with non-production repository content.

## Conventions

- Scope is `DEV/QA`.
- Status is `PASS`, `FAIL`, `BLOCKED`, or blank when not run.
- Record no secrets, production credentials, personal data, account identity,
  or live customer records.
- Leave a blank line between Actual result, Status, and Notes.

## Environment

| Item                     | Value                                             |
| ------------------------ | ------------------------------------------------- |
| Environment              | Local, non-production                             |
| Repository               | `<repository-relative name>`                      |
| Goal branch              | `<convention-compliant non-protected branch>`     |
| Scope manifest           | `docs/plans/scopes/<feature>/<slice>.scope`       |
| Review artifact          | `docs/plans/reviews/<feature>/<slice>.json`       |
| Planning state           | `docs/plans/loop-runs/<feature>-state.json`       |
| Planning review artifact | `docs/plans/reviews/<feature>/planning.json`      |
| Configured providers     | `<provider names and versions, no account names>` |
| Build or commit          | `<safe commit identifier>`                        |

## Shared setup

1. Use a disposable or non-production slice with a committed plan and scope
   manifest, one in-scope implementation change, and a green declared gate.
2. Configure the intended ordered reviewers in `.parallel-slices/review.json`.
3. Install only official provider CLIs. Complete authentication in each
   provider's own terminal flow. For Cursor subscription review, run
   `cursor-agent login`, `cursor-agent status`, and
   `cursor-agent --list-models`; do not supply `CURSOR_API_KEY`.
4. Confirm no other controller or review process owns the checkout.

## Progress summary

**Already passed:** None.

**Not yet passed:** 2.1, 2.2, 2.3, 2.4, 2.5

**Tester:**

**Run date:**

## Part A. UAT

There are no product-UI cases. This script verifies a developer CLI boundary.

## Part B. DEV/QA

### 2. Provider orchestration

### 2.1 Configuration validation makes no provider call

**Scope:** DEV/QA

**Expected result:** Validation reports the enabled reviewer count without a
login prompt, provider turn, or review artifact change.

1. From the repository root, run:

   ```bash
   node scripts/parallel-slices/review.mjs validate
   ```

2. Confirm the ordered reviewer configuration in `.parallel-slices/review.json`.
3. Confirm neither permanent review artifact changed.

**Actual result:**

**Status:**

**Notes:**

### 2.2 Signed-in reviewers create one ordered permanent ledger

**Scope:** DEV/QA

**Expected result:** Every configured reviewer runs once in order against one
source fingerprint. The command returns `APPROVED` or actionable
`CHANGES_REQUESTED`, and the JSON ledger plus generated Markdown view contain
the same attempt without account identity or credentials.

1. Run the slice's exact gate from its committed scope manifest.
2. Run:

   ```bash
   node scripts/parallel-slices/review.mjs run \
     --scope-file docs/plans/scopes/<feature>/<slice>.scope
   ```

3. Inspect the JSON and Markdown artifact paths printed by the runner.
4. Confirm reviewer order, provider versions, source fingerprint, turns,
   findings, assessments, and terminal outcome.
5. Confirm the live implementation did not change during the provider turns
   and no `.lock` or `.tmp-<pid>` file remains.

**Actual result:**

**Status:**

**Notes:**

### 2.3 Signed-out recovery is bounded and resumable

**Scope:** DEV/QA

**Expected result:** When a configured test provider is already signed out or
requires onboarding, the interactive runner pauses with an exact instruction.
Authentication completed in a separate terminal resumes the unchanged source;
a non-interactive run exits instead of waiting.

1. Use a configured provider that is already signed out in the test
   environment. Do not sign out an account needed by another active task.
2. Run once with `--non-interactive` and confirm authentication/setup status 20
   is returned without waiting or creating an empty artifact.
3. Start the review without `--non-interactive` and confirm the pause message.
4. In a separate terminal, complete only the provider's official login or
   onboarding flow.
5. Return to the review terminal and press Enter.
6. Confirm the review resumes only after readiness and source-fingerprint
   checks.

**Actual result:**

**Status:**

**Notes:**

### 2.4 Planning approval becomes stale after an audited correction

**Scope:** DEV/QA

**Expected result:** Configured reviewers approve the committed execution map
without regard to its Cursor, Codex, or Claude Code controller. A valid
replacement-manifest correction makes that approval stale, blocks worker
creation, and requires a new unanimous planning-review attempt.

1. Use a disposable approved Product Plan with a committed version 4 run state,
   version 2 slice manifests, and version 1 `_planning.scope`. Do not use an
   in-progress application milestone.
2. Run:

   ```bash
   node scripts/parallel-slices/review.mjs planning \
     --state docs/plans/loop-runs/<feature>-state.json
   node scripts/parallel-slices/planning-review.mjs verify \
     --state docs/plans/loop-runs/<feature>-state.json
   ```

3. Confirm every configured reviewer appears in order, the latest attempt is
   `approved`, and the JSON and generated Markdown record the same planning
   fingerprint.
4. In the disposable fixture only, add a schema-valid exact-path correction as
   documented in `docs/plans/AGENTS.md`; commit no implementation file.
5. Confirm `planning-review.mjs verify` reports the prior approval as stale and
   `slice-worktree.mjs create` refuses to start a worker.
6. Run the planning review again, confirm every reviewer runs again, and confirm
   verification succeeds with a different planning fingerprint.

**Actual result:**

**Status:**

**Notes:**

### 2.5 Cursor controller and reviewers remain independent

**Scope:** DEV/QA

**Expected result:** Cursor remains the `/loop` controller while two configured
Cursor reviewer ids run in order with different model ids. Neither review turn
continues the controller conversation or an earlier reviewer context.

1. Use a disposable run state whose `controller` is `cursor`.
2. Configure two `provider: "cursor"` reviewers with unique ids and different
   model IDs accepted by `cursor-agent --model`; omit `effort`. Run
   `cursor-agent status` to confirm the cached subscription login first.
3. Keep the Cursor `/loop` conversation open, then run the planning or slice
   review command from a separate terminal.
4. Confirm the ledger configuration records both reviewer ids and their exact
   model ids, and the round records one turn for each id in order.
5. Confirm the `/loop` conversation received no reviewer prompt or response and
   can continue orchestration from its prior controller context.
6. If a second round is required, confirm each reviewer starts without chat
   history from its earlier turn.

**Actual result:**

**Status:**

**Notes:**

## Sign-off

### Part A UAT

**Name:** Not applicable

**Date:**

**Result:** Skipped

### Part B DEV/QA (if run)

**Name:**

**Date:**

**Result:** Pass / Fail / Skipped
