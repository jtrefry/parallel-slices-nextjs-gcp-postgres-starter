# Use Parallel Slices with Codex

Codex can initialize this repository and own a sliced implementation run. This
repository also keeps the Cursor and Claude Code adapters installed. The
`defaultController` in `.parallel-slices/agent.json` controls examples and
convenience output; it does not disable either other tool.

For the shared lifecycle and document map, start with the
[Parallel Slices project guide](README.md).

## Initialize the project once

From the repository root, print the selected architecture's Codex initializer:

```bash
node scripts/parallel-slices/architecture-profile.mjs initialize-command codex
```

Open Codex and invoke the printed command.

The architecture-provided skill first verifies that Codex is enabled, then
follows that package's initialization workflow. Describe the product, answer
the interview questions, and review the generated Product Plan. Approve that
human-readable plan alone. Codex then commits it, applies the configured
slice-sizing strategy, and AI-compiles version 2 scope manifests plus version 4
JSON run state in a separate commit before implementation begins. Each new
manifest includes machine-validated impact coverage derived from a forward and
reverse repository trace and a read-only worker rehearsal. When multi-agent
review is enabled, Codex then invokes the independent planning review and
records its approval in a separate commit. With the installed disabled default,
it omits that target and needs no review-provider credential.

Read [Planning and optimized slices](planning-and-optimized-slices.md) for the
planning contract. In particular, a parallel set is computed from explicit
dependencies, worker-owned paths, logical resource locks, and the manifest's
parallel policy. It is not an invitation to let agents choose overlapping work
from prose.

## Plan a later milestone

For every later feature or fix, invoke:

```text
$parallel-slices-plan
```

The short alias is `$slices-plan`.

That dedicated planning skill stops at `PRODUCT_PLAN_READY` for approval, then
commits the Product Plan and compiles the optimized execution files separately.
It runs and records the independent AI planning review only when enabled, then
stops at `MILESTONE_PLAN_READY`; use the preparation skill after that checkpoint.

## Prepare and start a run

Ask Codex to invoke:

```text
$parallel-slices-prepare
```

The short alias is `$slices-prepare`.

The skill verifies repository evidence and returns a complete `/goal`
invocation without starting it. Review that invocation, then start it in Codex.
The controller named in the JSON state acquires an ignored local lease, so a
Cursor or Claude Code session cannot concurrently own the same run.

## How Codex executes slices

The `/goal` thread is only the root orchestrator. Goal persistence continues
that thread and may compact it; it does not create a fresh context for each
slice. The installed `$parallel-slices-next` skill (alias `$slices-next`)
therefore explicitly
requires Codex to:

1. validate the committed plan, state, and manifest graph;
2. compute the next Ready Slices;
3. create one detached managed worktree per slice;
4. spawn one fresh `worker` subagent per worktree, with no inherited
   conversation turns when that option is exposed;
5. receive only the compact worker evidence described in
   `run-slice-worker.md`;
6. verify and serially integrate each dependency-eligible candidate as soon as
   it arrives; and
7. recompute readiness after every accepted slice while sibling workers may
   continue.

Workers may run concurrently only when `slice-graph.mjs ready` places them in
the same ready result. The root does not write application code and workers do
not edit aggregate state. It does not wait for every worker before integrating
an eligible candidate. After a slice is accepted, `SLICE_ACCEPTED` keeps the
goal active. Only `MILESTONE_FINISHED` or `PULL_REQUEST_READY` completes it.

Codex documents subagent context isolation and project-scoped custom agents in
the [subagent guide](https://learn.chatgpt.com/docs/agent-configuration/subagents.md),
and documents `/goal` continuation in the
[long-running work guide](https://learn.chatgpt.com/docs/long-running-work.md).
The repository's own worktree commands remain the source of truth for slice
base commits, ownership, verification, and cleanup.

## Check status and recover

Invoke `$parallel-slices-status` for a read-only total progress bar, one bar per
slice, pipeline detail, and recovery guidance. `$slices-status` is its short
alias. After a restart, invoke either skill before continuing the `/goal` and
follow [Robust local recovery](robust-recovery.md).

## Hand off to another tool

Finish or explicitly stop the run, leave no active workers, make the goal
checkout clean, and release its lease. A later run may name `cursor` or
`claude-code` in new JSON state. To change only the displayed default, run:

```bash
node scripts/parallel-slices/switch-agent.mjs cursor
```

Changing the default never transfers an active run.
