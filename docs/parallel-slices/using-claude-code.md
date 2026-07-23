# Use Parallel Slices with Claude Code

Claude Code can initialize this repository and own a sliced implementation
run. This repository also keeps the Codex and Cursor adapters installed. The
`defaultController` in `.parallel-slices/agent.json` controls examples and
convenience output; it does not disable another tool.

For the shared lifecycle and document map, start with the
[Parallel Slices project guide](README.md).

## Initialize the project once

From the repository root, print the selected architecture's Claude Code
initializer:

```bash
node scripts/parallel-slices/architecture-profile.mjs initialize-command claude-code
```

Start Claude Code and invoke the printed command.

The architecture-provided skill verifies that Claude Code is enabled, then
follows its initialization workflow. Describe the product, answer the interview
questions, and review the generated Product Plan. Approve that human-readable
plan alone. Claude Code then commits it, applies the configured slice-sizing
strategy, and AI-compiles version 2 scope manifests plus version 4 JSON run
state in a separate commit before implementation begins. Each new manifest
includes machine-validated impact coverage derived from a forward and reverse
repository trace and a read-only worker rehearsal. When multi-agent review is
enabled, Claude Code then invokes the independent planning review and records
its approval in a separate commit. With the installed disabled default, it
omits that target and needs no review-provider credential.

Read [Planning and optimized slices](planning-and-optimized-slices.md) for the
planning contract. Ready Slices are derived from committed dependencies,
non-overlapping worker paths, logical locks, and explicit parallel policy. The
root cannot infer extra parallel work from conversational memory.

## Plan a later milestone

For every later feature or fix, invoke:

```text
/parallel-slices-plan
```

The short alias is `/slices-plan`.

That dedicated planning skill stops at `PRODUCT_PLAN_READY` for approval, then
commits the Product Plan and compiles the optimized execution files separately.
It stops at `MILESTONE_PLAN_READY`; prepare `/goal` after compilation and, when
enabled, independent AI planning review are complete.

## Prepare and start a run

Invoke:

```text
/parallel-slices-prepare
```

The short alias is `/slices-prepare`.

The skill verifies repository evidence and returns a complete `/goal`
invocation without starting it. Review that invocation, then start it. The
controller named in JSON state acquires an ignored local lease, so a Codex or
Cursor session cannot concurrently own the same run.

## How Claude Code executes slices

The `/goal` conversation is only the root orchestrator. It validates durable
state, computes the Ready Slices, and creates one detached managed
worktree per ready slice. It then spawns one fresh background subagent per
worktree and gives each only the packet defined in `run-slice-worker.md`.
Each iteration invokes `/parallel-slices-next`; `/slices-next` is the short
alias.

Claude Code subagents have isolated context and can run concurrently. Direct
each worker to the exact worktree path returned by `slice-worktree.mjs`.
Do not enable a second native `isolation: worktree` layer for that worker: the
slice worktree already pins the required base commit and worker metadata.

The root responds as workers finish, verifies each candidate from Git evidence,
and serially integrates each dependency-eligible candidate without waiting for
the others. It recomputes readiness after every acceptance, so newly unlocked
work may start while older independent work continues. It does not write
application code, and workers never edit aggregate state. `SLICE_ACCEPTED`
keeps the goal active. Only `MILESTONE_FINISHED` or `PULL_REQUEST_READY`
completes it.

Claude Code documents fresh subagent context and background concurrency in the
[subagent guide](https://code.claude.com/docs/en/sub-agents) and parallel
isolation choices in the
[agents guide](https://code.claude.com/docs/en/agents). Parallel Slices'
worktree commands remain the source of truth for slice base commits,
ownership, verification, and cleanup.

## Check status and recover

Invoke `/parallel-slices-status` for a read-only total progress bar, one bar per
slice, pipeline detail, and recovery guidance. `/slices-status` is its short
alias. After a restart, invoke either skill before continuing `/goal` and follow
[Robust local recovery](robust-recovery.md).

## Hand off to another tool

Finish or explicitly stop the run, leave no active workers, make the goal
checkout clean, and release its lease. A later run may name `cursor` or `codex`
in new JSON state. To change only the displayed default, run:

```bash
node scripts/parallel-slices/switch-agent.mjs cursor
```

Changing the default never transfers an active run.
