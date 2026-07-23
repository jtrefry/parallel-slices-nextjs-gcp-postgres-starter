# Multi-agent planning and slice review

<p align="center">
  <img src="assets/multi-agent-review.svg" alt="AI reviewers collaborating around one checked review document" width="360">
</p>

Multi-agent review runs configured AI reviewers in order against one
disposable, read-only snapshot and maintains one permanent JSON ledger plus a
generated Markdown view. It is optional: the installed configuration defaults
to `enabled=false` with no reviewers. When enabled, goal-level planning review
must approve the compiled version 5 run before any worker starts, and slice
review runs after each slice passes its declared quality gate. Reviewers never
edit the ledger or the live working tree.

## Configure reviewers

Edit `.parallel-slices/review.json` before approving the plan contract. This
Cursor-led example keeps Cursor as the `/loop` controller while two independent
Cursor Agent CLI reviewers use different explicit models:

```json
{
  "$schema": "./review.schema.json",
  "version": 1,
  "enabled": true,
  "billingPolicy": "subscription-only",
  "maxRounds": 3,
  "turnTimeoutSeconds": 600,
  "overallTimeoutSeconds": 3600,
  "authWaitSeconds": 900,
  "reviewers": [
    {
      "id": "cursor-review-a",
      "provider": "cursor",
      "model": "<cursor-model-id>"
    },
    {
      "id": "cursor-review-b",
      "provider": "cursor",
      "model": "<different-cursor-model-id>"
    }
  ]
}
```

Reviewer IDs must be unique lowercase kebab-case names. Cursor reviewers require
an explicit `model`; the Codex, Claude Code, and Antigravity CLIs may use their
configured default when `model` is omitted. `effort` is unsupported for Cursor
and Antigravity. Repeating any provider with a different reviewer ID is
supported. The configuration permits one to five reconciliation rounds and at
most ten reviewers.

Leave `enabled=false` and `reviewers=[]` to compile and execute without the
multi-agent planning-review target or its provider preflight. Set
`enabled=true` only when the project wants independent multi-agent planning and
slice review; at least one reviewer is then required. This is an AI checkpoint,
not another human approval surface. Using multiple providers or reviewer
identities increases diversity; all configured reviewers must agree.

`billingPolicy=subscription-only` refuses known API-key and cloud-credential
overrides and refuses authentication that reports API billing. Cursor review
uses the Cursor Agent CLI's cached browser login, so it does not require or
forward `CURSOR_API_KEY`. Authenticate once with the same Cursor account used
by the controller:

```bash
cursor-agent login
cursor-agent status
cursor-agent --list-models
```

Cursor Agent CLI access, supported model IDs, plan quotas, and billing remain
owned by Cursor. `provider-managed` may forward `CURSOR_API_KEY` for an account
that deliberately uses API billing. Never put a key in `review.json`, shell
history, a committed environment file, or a review artifact. Review artifacts
record only provider versions and a coarse authentication mode, never an
account identity, token, or raw login output.

Validate configuration without contacting a provider:

```bash
node scripts/parallel-slices/review.mjs validate
```

## Declare the artifact

When review is enabled, the version 5 run state declares a goal-level planning
target:

```json
{
  "planningReview": {
    "scope": "docs/plans/scopes/<feature>/_planning.scope",
    "artifact": "docs/plans/reviews/<feature>/planning.json"
  }
}
```

When review is disabled, omit `planningReview` and do not create a
`_planning.scope` or planning artifact. When enabled, the version 1
`_planning.scope` allows only the approved Product Plan, run
state, review configuration, compiled-manifest namespace, correction-record
namespace, and planning JSON/Markdown pair. Commit the compiled map and
planning scope before invoking review; commit the generated pair separately
afterward.

Every version 2 reviewed scope manifest names and coordinates both permanent
files because the root invokes the review runner during integration:

```text
review=docs/plans/reviews/<feature>/<slice>.json
coordinate=docs/plans/reviews/<feature>/<slice>.json
coordinate=docs/plans/reviews/<feature>/<slice>.md
```

The JSON file is the source ledger. The runner generates the adjacent Markdown
file for people. A later implementation attempt appends to the same ledger, so
failed findings and their eventual resolution remain auditable.

## Run a review

When review is enabled, run the goal-level planning review after the
compiled-execution commit and before creating any worker:

```bash
node scripts/parallel-slices/review.mjs planning \
  --state docs/plans/loop-runs/<feature>-state.json
```

Planning reviewers receive the approved Product Plan, active scope revisions,
run state, current implementation and tests, architecture contracts, and
coverage declarations. They check requirement and preservation traceability,
contracts and consumers, side effects, tests, operations, path completeness,
dependencies, locks, concurrency, non-goals, migrations, and external actions.
The approval records a planning-contract fingerprint. Worker creation refuses
a missing, rejected, malformed, or stale fingerprint.

If an audited correction adds already-required exact paths to an unstarted
slice, the fingerprint changes and the planning review must run again. Follow
`docs/plans/AGENTS.md`; never use a correction to add product behavior,
subsystems, policy, migrations, deployments, or external actions.

For slice review, run the slice's quality gate first, then run:

```bash
node scripts/parallel-slices/review.mjs run \
  --scope-file docs/plans/scopes/<feature>/<slice>.scope
```

The runner performs non-billing authentication checks before creating an
attempt. Cursor preflight checks `cursor-agent --version`,
`cursor-agent status`, and every configured model ID against
`cursor-agent --list-models`. The runner then copies
tracked and non-ignored untracked repository files into a temporary directory,
adds the authorized Git patch and review packet, and runs reviewers sequentially
with read-only tool restrictions. The live source fingerprint is checked after
every reviewer. A concurrent edit stops the review as stale instead of
combining evidence from different revisions.

Provider processes receive a small environment allowlist needed for the CLI,
local account cache, locale, certificates, and temporary files. Project,
database, cloud, and arbitrary shell environment variables are not inherited.
In `subscription-only` mode the Cursor child never receives `CURSOR_API_KEY`.
In `provider-managed` mode only the Cursor child may receive that key. Unrelated
provider credentials remain stripped. The provider CLI still owns its
authentication and sandbox behavior, so use only official packages and keep
their versions current.

Every Cursor turn launches a separate `cursor-agent --print` process with the
review packet, explicit model, JSON output, and disposable snapshot as its
working directory. It does not pass `--resume`, so it uses the current cached
Cursor account login but never reuses the `/loop` controller conversation,
another reviewer, or its own earlier round. Two reviewer entries may therefore
select different model IDs while Cursor remains the controller.

Each response must match the installed structured schema. The first reviewer
records findings; every later reviewer receives all prior summaries and must
assess every open finding before adding its own. Further rounds repeat the same
ordered process. Consensus requires every configured reviewer to approve in
the same round and no open critical or high finding. An existing finding is
dismissed only after every configured reviewer has explicitly dismissed it.

The provider turn and total provider-time limits are hard bounds. The runner
terminates the provider process group on a timeout or excessive output and
records an operational failure. It never silently treats an unavailable,
malformed, or timed-out reviewer as an approval.

One exclusive lock protects each slice ledger. A second runner refuses to
start. If a process is forcibly terminated, inspect the recorded PID and active
processes before removing the reported `.lock` file. Likewise, inspect and
remove only the exact stale `.tmp-<pid>` file reported after a crash; the runner
never guesses that another writer's file is safe to delete.

## Authentication pauses

If a provider CLI is missing, authentication is unavailable, or a
provider needs interactive onboarding, an interactive review prints an exact
recovery instruction and pauses. Open a separate terminal, install or complete
the provider's authentication flow there, return to the original terminal, and
press Enter. Never paste a token into the review terminal. The runner checks
readiness and verifies that the source fingerprint did not change before
continuing.

The wait is bounded by `authWaitSeconds` and retries at most three times. In a
non-interactive terminal or with `--non-interactive`, the runner exits
immediately with an authentication/setup status so automation cannot hang.
Authentication detected before an attempt does not create an empty ledger;
authentication lost during a turn records the attempt as waiting and then
resumes or terminates it.

## Outcomes

- `APPROVED` (exit 0): commit the planning pair separately or continue slice
  integration, according to the review kind.
- `CHANGES_REQUESTED` (exit 10): return to implementation with the JSON and
  Markdown artifact paths and unresolved finding IDs, rerun the gate, then
  start a new review attempt.
- authentication/setup unavailable (exit 20): follow the printed recovery
  instructions or retry from an interactive terminal.
- quota unavailable (exit 21), stale source (exit 22), provider timeout (exit
  23), or invalid/provider output (exit 24): preserve the artifact when an
  attempt started and stop for an operational correction.

Do not hand-edit either artifact, delete failed attempts, or copy provider raw
output into project documentation. See `docs/plans/reviews/AGENTS.md` for the
artifact contract. Use
`docs/testing/manual/multi-agent-review-test-script.md` to verify installed
provider versions and real signed-in account behavior in a non-production
slice.
