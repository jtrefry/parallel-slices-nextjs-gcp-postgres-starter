# Check run status

Report the active Parallel Slices milestone without changing repository or
runtime state. Cursor and Claude Code expose `/parallel-slices-status` with
`/slices-status` as its alias; Codex exposes `$parallel-slices-status` with
`$slices-status` as its alias.

## Run the report

Every adapter runs this shared command from the repository root:

```bash
node scripts/parallel-slices/run-status.mjs
```

The command reads the committed Product Plan and JSON run state, the ignored
runtime run index, every per-slice attempt ledger, managed worktree condition,
pipeline step tracking, and permanent review artifacts. It prints one total
progress bar followed by one status and progress bar for every slice. It also
reports short-lived tracking locks, incomplete atomic-write staging files, and
the exact worker ID for resumable worktree setup.

## Select a state

When more than one nonterminal run state exists and no local run lease selects
one, pass the repository-relative state explicitly:

```bash
node scripts/parallel-slices/run-status.mjs \
  --state docs/plans/loop-runs/<feature>-state.json
```

## Preserve read-only behavior

Use `--json` only when another local tool needs structured output. Status is a
read-only observation: never create a lease, alter a ledger, remove a lock,
clean a worktree, rerun a pipeline, or infer that a `running` phase is stale.
Report recovery guidance exactly as rendered by the command.
