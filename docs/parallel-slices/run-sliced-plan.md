# Parallel Slices plan orchestrator

The active Codex `/goal`, Cursor `/loop`, or Claude Code `/goal` thread is the
root orchestrator. It owns continuation, the controller lock, ready-set
selection, candidate integration, aggregate state, final audit, and goal-level
publication. It must not implement application code itself. Every slice is
implemented by a fresh worker with isolated conversation context and an
assigned detached Git worktree.

Read `docs/parallel-slices/planning-and-optimized-slices.md` before operating this
workflow. Also read `docs/parallel-slices/robust-recovery.md`. Read the run
controller's guide under `docs/parallel-slices/` for its native worker-spawning
instructions.

## Required invocation contract

The invoking prompt must identify:

- the controller (`codex`, `cursor`, or `claude-code`);
- one approved human-readable plan path;
- one committed JSON run-state path;
- one explicit vertical milestone and final slice;
- one convention-compliant goal branch;
- the repository publication mode from `.parallel-slices/repository.json`;
- forbidden external actions and the final stopping boundary.

Return `BLOCKED` before writing if any item is missing, the controller differs
from run state, or the milestone is an open-ended multiphase program.

## Claim the run

All generated repositories enable every supported controller. Exactly one
controller owns a particular run. From the repository root, acquire or verify
the ignored local lease before lifecycle work:

```bash
node scripts/parallel-slices/run-lock.mjs acquire \
  --controller <controller> \
  --state docs/plans/loop-runs/<feature>-state.json
```

An existing matching lease is idempotent. A different controller or run ID is
an actionable `BLOCKED` condition. Never delete another controller's lease or
guess that it is stale. Acquisition also creates the ignored runtime index that
references every later per-slice attempt ledger.

## Load and validate the contract

Read completely, in order:

1. root `AGENTS.md` and applicable nested instructions;
2. the controller-specific guide under `docs/parallel-slices/`;
3. `docs/plans/AGENTS.md`;
4. the approved plan;
5. its JSON run state;
6. every version 2 scope manifest named by state;
7. `.parallel-slices/project-state.json`, `.parallel-slices/repository.json`, and
   `.parallel-slices/review.json`;
8. canonical `docs/project/` documents referenced by the plan; and
9. release and testing instructions applicable to the ready slices.

Validate the durable sources rather than trusting chat memory:

```bash
node scripts/parallel-slices/run-state.mjs verify --state <state-path>
node scripts/parallel-slices/slice-graph.mjs validate --plan <plan-path>
node scripts/parallel-slices/slice-graph.mjs ready \
  --plan <plan-path> \
  --state <state-path>
```

When `.parallel-slices/review.json` has `enabled=true`, also run
`planning-review.mjs verify --state <state-path>` before calculating ready
slices. With review disabled, state omits `planningReview` and this command does
not apply.

The `ready` result is the next optimized set. It contains only slices whose
dependencies are accepted and whose worker paths, logical resource locks, and
parallel policies do not conflict. Do not add another slice to a set based on
intuition or chat history.

## Preflight before spawning workers

Require:

- the active branch equals the run state's non-protected goal branch;
- the root checkout is clean except for ignored Parallel Slices runtime files;
- the plan, state, and manifests are tracked and committed;
- when multi-agent review is enabled, the latest independent planning review is
  approved for the active execution-map fingerprint;
- no other run owns the same checkout or goal;
- the monotonic project stage satisfies every ready manifest;
- each ready manifest has exact worker paths, coordinator paths, dependencies,
  parallel policy, logical locks, machine-validated scope coverage, tests,
  release classification, review path, gate, and commit subject; and
- every worktree can run the project's deterministic setup without production
  credentials or production migrations.

## Create an isolated worker per ready slice

For every slice in the ready result, create its managed detached
worktree:

```bash
node scripts/parallel-slices/slice-worktree.mjs create \
  --controller <controller> \
  --state <state-path> \
  --scope-file <scope-file>
```

The command atomically claims a new attempt and refuses a dirty goal checkout,
a missing run lease, an unready slice, a duplicate worker, and any conflict
with an active worker. Preserve the returned attempt number, worker ID, base
commit, and worktree path.

Spawn one fresh native worker for each returned worktree. Request no inherited
conversation turns where the controller exposes that option. Give the worker
only the controller-neutral packet required by
`docs/parallel-slices/run-slice-worker.md`: repository worktree, plan, state,
manifest, milestone, base commit, attempt number, worker ID, and forbidden
actions.

Workers in one ready result may run concurrently because their detached
worktrees are isolated. The root may accept a finished candidate on the goal
checkout while sibling workers continue at their recorded base commits. Only
one integration attempt may own the goal checkout at a time, and no second
lifecycle controller may write.

## Verify candidate boundaries

Each successful worker returns a concise result containing its worker ID,
candidate commit, gate, self-check, changed paths, and blockers. Verify the
repository rather than trusting the summary:

```bash
node scripts/parallel-slices/slice-worktree.mjs verify --worker-id <worker-id>
```

Verification requires a passed tracked worker gate, a matching
`candidate_ready` checkpoint, and exactly one clean candidate commit based on
the assigned worker base. It also enforces the manifest's exact subject and
worker-owned paths only. Preserve a blocked or failed worktree for recovery;
never advance its slice.

## Integrate candidates serially

Although workers build concurrently, only the root mutates the goal branch.
As soon as a candidate is verified and all of its declared dependencies are
accepted, send it through serial integration. Do not wait for unfinished
sibling workers. If several eligible candidates are already verified when the
goal checkout becomes free, choose the lowest numeric slice ID among those
available candidates. A global numeric order must not delay an available
candidate behind an unfinished independent worker.

The worker has already run its declared gate before creating the isolated
candidate commit. That candidate is not yet an accepted goal-branch commit. The
root applies it without committing, reruns the gate against the integrated goal
checkout, performs independent review, and creates the accepted slice commit
only after both pass.

1. Atomically claim the serial integration boundary and apply the verified
   candidate from the repository root:

   ```bash
   node scripts/parallel-slices/slice-worktree.mjs apply \
     --worker-id <worker-id>
   ```

   This command rechecks the lease, candidate, dependencies, and clean goal
   checkout; refuses another integration owner; applies the candidate without
   committing; proves the applied paths equal the verified candidate paths;
   and records the candidate and goal-base commits. Never substitute an
   untracked manual cherry-pick.

2. Update only the manifest's `coordinate` paths. In JSON state, record the
   candidate SHA, evidence, and the slice status that reflects the current
   integration attempt. The configured review runner is the only writer of the
   permanent JSON and Markdown review artifacts.
   Rehydrate a prior correction attempt's review ledger when present:

   ```bash
   node scripts/parallel-slices/slice-worktree.mjs restore-evidence \
     --worker-id <worker-id>
   ```

3. Run the integrated gate, which permits worker and coordinator paths:

   ```bash
   node scripts/parallel-slices/gate.mjs \
     --scope-file <scope-file> \
     --integrated \
     --worker-id <worker-id>
   ```

4. Review the integrated diff independently. When
   `.parallel-slices/review.json` is enabled, run the configured review
   orchestrator with `--worker-id <worker-id>` so approval and progress are
   tracked and its JSON and Markdown artifacts are generated. When it is
   disabled, use a fresh read-only review agent that did not implement the
   slice and record its identity, reviewed boundary, outcome, and concise
   findings in the slice's committed `reviewEvidence`; do not invent or
   manually write multi-agent review artifacts. On a failed gate or requested
   change, preserve review evidence, restore the goal checkout, replace the
   candidate worktree at the latest accepted base, and spawn a fresh worker
   context for the returned packet:

   ```bash
   node scripts/parallel-slices/slice-worktree.mjs retry \
     --worker-id <worker-id>
   ```

   The retry creates a new attempt ledger and worker ID while retaining the
   rejected attempt. If the process stops during replacement, rerun the same
   retry command with the rejected worker ID; it resumes the already allocated
   next attempt. Use the returned identity for the fresh worker. The root does
   not make application-code fixes. Stop after three bounded fresh-worker
   retries.

5. After an approved review, set the state slice to `accepted`, record the
   candidate SHA plus non-empty gate and review evidence, rerun the scope-only
   integrated check, and create exactly one accepted goal-branch commit using
   the manifest subject.
6. Prove the accepted commit preserved all worker-owned blobs, then remove the
   accepted worktree:

   ```bash
   node scripts/parallel-slices/gate.mjs \
     --scope-file <scope-file> \
     --integrated \
     --scope-check-only \
     --base HEAD^ \
     --worker-id <worker-id>
   node scripts/parallel-slices/slice-worktree.mjs accept --worker-id <worker-id>
   node scripts/parallel-slices/slice-worktree.mjs remove --worker-id <worker-id>
   ```

7. Immediately recompute Ready Slices from the new accepted commit. Start any
   newly eligible, non-conflicting worker even if older independent workers are
   still running. Also integrate the next already verified eligible candidate
   as soon as the goal checkout is clean.

If an integrated apply check cannot be safely represented by the bounded retry,
preserve evidence and the worktree. Do not integrate later dependent slices.
After three rejected fresh-worker corrections, return `FAILED`.

## Inspect status and recover interruptions

At any time, including after a machine or controller restart, run this read-only
command from the repository root:

```bash
node scripts/parallel-slices/run-status.mjs --state <state-path>
```

It reads the committed state, runtime index, every worker and integration
attempt, worktree condition, pipeline steps, and permanent reviews. It prints
one total progress bar and one status and progress bar per slice. Follow its
recovery guidance and `docs/parallel-slices/robust-recovery.md`; never treat a
`running` phase as stale without checking the former process, never count a
partial pipeline as passing, and never discard a dirty worktree automatically.
If worktree creation was interrupted, use the reported `slice-worktree.mjs
resume --worker-id <worker-id>` command rather than creating another attempt.

## Recalculate after every accepted slice

Never cache future scheduling decisions. After accepted commits update the goal
branch and state, rerun `slice-graph.mjs ready`. The next Ready Slices may differ
as accepted dependencies unlock later work or in-progress recovery narrows what
can proceed. An active worker for a slice is not created again; other newly
ready, non-conflicting slices may start immediately.

## Scope and safety boundary

Return `BLOCKED` before adding requirements, paths, subsystems, migrations,
user-visible behavior, product policy, or external actions. A gate failure does
not authorize gate or infrastructure edits. Never deploy, publish, merge,
force-push, push a protected branch, change repository settings, or run a
production migration.

## Final audit and publication

Only the root performs the final milestone audit, once, after every slice is
accepted and its worktree is removed. Prove every requirement, preservation
scenario, gate, review, release fragment, accepted slice commit, state entry,
and explicit non-goal. Record `finalAudit.version`, a canonical `completedAt`,
the current pre-terminal-state `auditedCommit`, every slice ID in numeric
`acceptedSlices` order, and non-empty evidence arrays for `requirements`,
`preservation`, `gates`, `reviews`, `releaseFragments`, `state`, and
`nonGoals`. The run-state validator refuses `finished` or
`pull_request_ready` unless all slices are accepted, all per-slice gate and
review evidence is present, any configured multi-agent review artifacts are a
complete JSON/Markdown pair at that audited commit, and the structured audit
is complete.

In local-only mode, commit the terminal state and return
`MILESTONE_FINISHED`. In GitHub mode, follow
`docs/parallel-slices/github-automation.md`, push only the goal branch, create or
update one goal-level pull request, monitor CI to green, and return
`PULL_REQUEST_READY`.

Release the lease only after the committed state is terminal, all accepted
worktrees are removed, and no attempt remains active. Historical attempt
ledgers remain ignored local recovery evidence:

```bash
node scripts/parallel-slices/run-lock.mjs release \
  --controller <controller> \
  --state <state-path>
```

## Return protocol

- `SLICE_ACCEPTED`: one candidate is integrated, reviewed, state-recorded, and
  committed; the milestone remains incomplete and scheduling is recalculated.
- `PULL_REQUEST_READY`: the complete goal has one CI-green pull request.
- `MILESTONE_FINISHED`: the complete local-only goal branch is ready.
- `BLOCKED`: a decision, ownership conflict, unsafe state, or scope expansion
  requires the user.
- `FAILED`: the bounded correction cycle ended without acceptance.

`SLICE_ACCEPTED` never satisfies `/goal` and never stops Cursor `/loop`. Only the
two successful milestone markers complete the goal. `BLOCKED` and `FAILED` are
terminal impasses and must stop further work.
