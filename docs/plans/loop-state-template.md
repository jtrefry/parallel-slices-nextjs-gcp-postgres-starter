# Durable loop-state contract

Copy `_LOOP-STATE-TEMPLATE.json` to
`docs/plans/loop-runs/<feature>-state.json` and replace every example value.
The JSON file is the authoritative run state consumed by the controller lock,
slice scheduler, and worktree manager. Validate it from the repository root:

```bash
node scripts/parallel-slices/run-state.mjs verify \
  --state docs/plans/loop-runs/<feature>-state.json
```

Generate a fresh controller-neutral run identifier with:

```bash
node scripts/parallel-slices/run-state.mjs new-id
```

The state records one controller owner for the current goal, but every generated
repository enables Codex, Cursor, and Claude Code. Choose the controller when
creating the run state. A different controller may take over only through the
documented clean-boundary handoff.

`planCommit` records the full SHA of the separate human-approved Product Plan
commit. Verification requires that commit to introduce the plan and requires
the committed and working copies of the plan to remain identical to it.

The version 4 `compilation` object records the effective slice-sizing strategy,
the exact config and Architecture Package hashes at Product Plan approval, and
concrete sizing rationale. Its `planningReview` object declares the immutable
goal-level review scope and permanent JSON artifact that must receive an
independent AI approval before any worker starts. Generate the reproducible input fields after the
approval commit with:

```bash
node scripts/parallel-slices/slice-compilation.mjs snapshot
```

The compiled-execution commit adds the declared `_planning.scope`. Run
`review.mjs planning --state <state-path>` only after that commit, then commit
the generated `planning.json` and `planning.md` pair separately. Worker
creation recomputes the planning-contract fingerprint and refuses a missing,
rejected, malformed, or stale approval.

Both strategies retain identical quality and safety rules. The snapshot keeps
an active run pinned even if a later, separate goal changes repository policy.
The runtime can finish an existing version 3 run after an upgrade, but the
planning commit gate requires version 4 for every newly compiled goal.

Each `slices` entry maps one compiled manifest to its status, candidate commit,
gate evidence, review evidence, and declared permanent multi-agent review
artifact. Workers never edit this aggregate
file. The root controller updates it while serially integrating a candidate,
then includes that update in the accepted slice commit. Git history owns the
accepted commit SHA because a commit cannot truthfully contain its own ID.
The root may accept one eligible candidate while independent detached workers
continue, then recomputes readiness from this newly committed state.

Status meanings:

- `not_started`: no candidate is being accepted.
- `in_progress`: the root is recovering or correcting this same slice.
- `accepted`: the integrated goal-branch commit passed its gate and review.
- `blocked`: a user decision or external prerequisite is required.
- `failed`: the bounded correction cycle ended without acceptance.

Run-level `finished` and `pull_request_ready` are successful completion states.
They require every slice to be `accepted` and a structured `finalAudit` that
records the pre-terminal-state commit, every accepted slice ID in numeric
order, a canonical completion time, and non-empty evidence arrays for
requirements, preservation, gates, reviews, release fragments, state, and
non-goals. All other statuses require `finalAudit` to remain `null`. The
validator also proves each accepted slice has gate and review evidence. When a
configured multi-agent review ran, both permanent review artifacts must exist
at the audited commit; when it is disabled, the root records the fresh
independent review evidence directly in the slice state without inventing a
multi-agent ledger.

`blocked` and `failed` are terminal impasses. Runtime worker paths and controller
locks live under ignored `.parallel-slices/runtime/`; they supplement, but never
replace, this committed state. The run lease creates a runtime `index.json`
that references separate worker and integration ledgers for every slice
attempt. Retries append attempts instead of overwriting failure evidence, and
pipeline runs retain interrupted and failed step results.

Use `node scripts/parallel-slices/run-status.mjs --state <state-path>` for the
read-only aggregate view. Follow `docs/parallel-slices/robust-recovery.md` after
an interruption. Runtime ledgers are never committed or pushed; cross-machine
recovery begins at the last accepted slice commit available on the authorized
goal branch.
