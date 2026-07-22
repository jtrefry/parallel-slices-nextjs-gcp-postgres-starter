# Robust local recovery

Parallel Slices checkpoints accepted outcomes in Git and records in-flight work
under ignored `.parallel-slices/runtime/`. A machine or controller restart must
recover from repository evidence rather than conversation memory.

## Tracking layout

The committed `docs/plans/loop-runs/<feature>-state.json` remains the authority
for accepted slices and terminal milestone status. Acquiring a run lease creates
one ignored runtime index at:

```text
.parallel-slices/runtime/runs/<run-id>/index.json
```

The index references a new pair of single-writer ledgers for every slice
attempt:

```text
slices/<slice>/attempts/<number>/worker.json
slices/<slice>/attempts/<number>/integration.json
```

The worker ledger records its worktree, base and candidate commits, lifecycle
phase, and every candidate-pipeline attempt and step. The root-owned integration
ledger records candidate verification, application, integrated pipelines,
exclusive integration claim, review, retries, acceptance, and cleanup. A retry
creates a new attempt and worker ID; it never overwrites the failed attempt.
Runtime writes use temporary files, atomic rename, and filesystem
synchronization where the platform supports it.

Workers must never edit these JSON files directly. They may update only their
own attempt through `run-tracking.mjs`. The root alone writes integration
tracking and the committed aggregate state.

An active version 1 worker-metadata file from an earlier installation is
migrated into the indexed attempt layout on its first lifecycle read. The
migration preserves its retry count, candidate and accepted commits, review
evidence, worktree, and source metadata before replacing the old file with a
stable pointer.

## Resume on the same machine

After a restart, use the same repository and controller and first run the
read-only status command from the repository root:

```bash
node scripts/parallel-slices/run-status.mjs --state <state-path>
```

Then reacquire the same controller lease. Acquisition is idempotent for its
recorded owner and reconciles a complete atomically written attempt directory
if a crash happened before the runtime index or worker pointer was updated:

```bash
node scripts/parallel-slices/run-lock.mjs acquire \
  --controller <controller> \
  --state <state-path>
```

Then inspect the reported condition:

- An accepted slice is complete only when committed JSON state records it.
- If an attempt was claimed but worktree setup did not reach `worktree_ready`,
  verify that the prior process stopped and resume the same attempt without
  changing its worker ID:

  ```bash
  node scripts/parallel-slices/slice-worktree.mjs resume \
    --worker-id <worker-id>
  ```

  The command recreates only the recorded managed worktree at its recorded
  commit. It refuses a dirty or mismatched claimed worktree.

- A clean candidate commit with a passed tracked worker gate and matching
  `candidate_ready` checkpoint may be verified without rebuilding it. Run
  `slice-worktree.mjs apply --worker-id <worker-id>` to atomically claim and
  apply it when the goal checkout is clean.
- If `integration_claimed` is recorded and the goal checkout is still clean,
  verify the prior process stopped and rerun that same `apply` command. If the
  goal checkout is dirty, preserve it and reconcile the recorded candidate
  before continuing; never let another attempt claim integration.
- A `running` pipeline may still have a live process. Verify the prior worker or
  root process stopped, then rerun the entire declared gate. Starting the new
  run marks the unfinished pipeline attempt `interrupted`; no partial pipeline
  is treated as passing.
- A dirty worker worktree preserves partial scoped work. Spawn a fresh recovery
  worker with the same worker ID and worktree only after verifying every changed
  path belongs to the manifest. Never clean or discard it automatically.
- An interrupted review is retained in the permanent review ledger and a new
  review attempt evaluates a fresh source fingerprint.
- A dirty goal checkout must match exactly one verified candidate and its
  worker and coordinator paths before integrated work resumes. Otherwise stop
  with `BLOCKED`.
- Never remove a lock merely because it looks old. Verify that its owning
  process stopped and preserve any temporary evidence before recovery. Status
  reports tracking-update locks and incomplete atomic-write staging files.
- A retry is restart-safe across worktree replacement. Rerun:

  ```bash
  node scripts/parallel-slices/slice-worktree.mjs retry \
    --worker-id <rejected-worker-id>
  ```

  The command returns or recreates the same next attempt instead of allocating
  another retry.

The controller must rerun `run-state.mjs verify`, `slice-graph.mjs validate`,
and `slice-graph.mjs ready` after reconciliation. Readiness is always computed
from accepted committed dependencies, not from runtime progress. Recompute it
after each recovered acceptance; unfinished independent workers may continue
at their recorded bases.

## Cross-machine boundary

Runtime ledgers, worker worktrees, and unaccepted candidate commits are local
and intentionally Git-ignored. Cross-machine recovery begins only at the last
accepted slice commit that was pushed to the authorized goal branch. On a new
machine, fetch that branch, validate committed state, recompute Ready Slices,
and restart every slice not recorded as accepted.

Do not commit or push runtime ledgers, partial candidates, dirty worktrees,
pipeline-in-progress records, leases, or locks for recovery. If a repository
chooses to push accepted slice commits before the final goal audit, that is an
explicit publication-policy change; it does not authorize publishing in-flight
runtime data.
