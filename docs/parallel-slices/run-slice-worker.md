# Parallel Slices worker contract

A slice worker is a fresh, bounded implementation agent. It is not the goal
controller, does not choose another slice, does not edit aggregate run state,
and does not publish or complete the milestone.

## Required assignment

The root prompt must supply the exact worktree, worker ID, base commit, approved
plan, JSON state, scope manifest, milestone, and forbidden actions. Return
`BLOCKED` before writing if any value is missing or inconsistent.

## Worker sequence

From the assigned worktree:

1. Read root and nested instructions, the complete human plan, JSON state,
   assigned manifest, project contracts, release instructions, and relevant test
   rules. Never rely on the root chat's summary for requirements.
2. Verify the detached worktree is clean at the assigned base commit and the
   manifest is tracked, committed, and version 2. For an explicit recovery
   packet, instead verify that every preserved dirty path belongs to this
   manifest before continuing; never clean or discard partial work.
3. Run the manifest's tracked scope-only gate before writes:

   ```bash
   node scripts/parallel-slices/gate.mjs \
     --scope-file <scope-file> \
     --scope-check-only \
     --worker-id <worker-id>
   ```

   Then checkpoint `implementing` through the tracking command:

   ```bash
   node scripts/parallel-slices/run-tracking.mjs checkpoint \
     --worker-id <worker-id> \
     --role worker \
     --phase implementing
   ```

   Never edit a runtime ledger directly.

4. Implement only the named requirement IDs and `allow` paths. Never edit a
   `coordinate` path, the plan, the manifest, another slice, or runtime metadata
   directly. `run-tracking.mjs` is the only permitted writer for this worker's
   own attempt ledger.
5. Add the declared behavior-focused tests and developer release fragment.
6. Run targeted tests, then the exact tracked manifest gate so every pipeline
   step and interruption is recoverable:

   ```bash
   node scripts/parallel-slices/gate.mjs \
     --scope-file <scope-file> \
     --worker-id <worker-id>
   ```

   Never run a production deployment or migration.

7. Perform a bounded self-check against the manifest, tests, and preservation
   invariants. The root's configured review runner owns the permanent review
   artifacts and may request a fresh correction worker after integration.
8. Confirm `git status` contains only worker-owned paths, then create exactly
   one commit using the manifest's exact `commit=` subject. Record
   `candidate_ready` through:

   ```bash
   node scripts/parallel-slices/run-tracking.mjs checkpoint \
     --worker-id <worker-id> \
     --role worker \
     --phase candidate_ready \
     --candidate-commit HEAD
   ```

9. Leave the worktree clean and return only: worker ID, candidate SHA, changed
   paths, gate commands/results, self-check summary, and blockers.

## Return protocol

The worker returns `CANDIDATE_READY`, `BLOCKED`, or `FAILED`. It never returns
`SLICE_ACCEPTED`, `MILESTONE_FINISHED`, or `PULL_REQUEST_READY`.

## Corrections and failures

For a correction attempt, the root supplies a new slice worktree and the same
committed compiled manifest plus prior finding IDs. Treat it as a fresh task,
verify its new base commit, and do not rely on the rejected worker's
conversation.

When returning `BLOCKED` or `FAILED`, record the matching worker phase and a
concise, secret-free `--message` through `run-tracking.mjs` first. If the
process stops before doing so, the unchanged last phase and worktree condition
remain recovery evidence.
