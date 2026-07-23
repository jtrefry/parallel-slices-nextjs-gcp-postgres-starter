# Use Parallel Slices with Cursor

Cursor can initialize this repository and own a sliced implementation run.
This repository also keeps the Codex and Claude Code adapters installed. The
`defaultController` in `.parallel-slices/agent.json` controls examples and
convenience output; it is not an exclusive controller selection.

For the shared lifecycle and document map, start with the
[Parallel Slices project guide](README.md).

## Initialize the project once

From the repository root, print the selected architecture's Cursor initializer:

```bash
node scripts/parallel-slices/architecture-profile.mjs initialize-command cursor
```

Open Cursor Agent and run the printed command.

The architecture-provided command verifies that Cursor is enabled and loads the
installed initialization skill. Describe the product, answer the interview
questions, and review the generated Product Plan. Approve that human-readable
plan alone. Cursor then commits it, applies the configured slice-sizing
strategy, and AI-compiles version 2 scope manifests plus version 4 JSON run
state in a separate commit before implementation begins. Each new manifest
includes machine-validated impact coverage derived from a forward and reverse
repository trace and a read-only worker rehearsal. When
`.parallel-slices/review.json` has `enabled=true`, Cursor then invokes the
multi-agent engine for an independent planning review and records its approval
in a separate commit. With the default `enabled=false`, it omits that target and
continues without provider credentials.

Read [Planning and optimized slices](planning-and-optimized-slices.md) for the
planning contract. Parallelism comes only from the manifest dependency graph,
non-overlapping worker paths, logical resource locks, and explicit parallel
policy. The prose plan remains the review surface; the manifests are the
machine execution boundary.

## Keep Cursor as controller while Cursor models review

Cursor is both a supported lifecycle controller and an independent review
provider. These roles do not share an agent. The foreground `/loop` conversation
continues to own orchestration, while each configured Cursor reviewer turn
starts a separate `cursor-agent --print` process against the disposable review
snapshot. A later round starts fresh again; the runner uses the cached Cursor
account login but never resumes `/loop` or an earlier reviewer.

To use two Cursor models, keep the run state's `controller` set to `cursor` and
configure reviewers like this in `.parallel-slices/review.json`:

```json
{
  "enabled": true,
  "billingPolicy": "subscription-only",
  "maxRounds": 3,
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

Retain the other required timeout and schema fields from the installed file.
Cursor reviewers require explicit model IDs and do not accept `effort`. Install
the Cursor Agent CLI, run `cursor-agent login`, and verify the cached
subscription login with `cursor-agent status`. Choose explicit model IDs from
`cursor-agent --list-models`; no API key or project SDK dependency is required
for `subscription-only`. See
[Multi-agent review](multi-agent-review.md) for billing policy, preflight,
timeouts, and the complete configuration.

## Plan a later milestone

For every later feature or fix, run:

```text
/parallel-slices-plan
```

The short alias is `/slices-plan`.

That command stops at `PRODUCT_PLAN_READY` for approval, then commits the
Product Plan and compiles the optimized execution files separately. When
multi-agent review is enabled, it reaches `MILESTONE_PLAN_READY` only after the
independent AI planning approval. When disabled, it reaches that checkpoint
after the compiled execution commit.

## Prepare and start a run

Run:

```text
/parallel-slices-prepare
```

The short alias is `/slices-prepare`.

The command verifies repository evidence and returns a complete `/loop`
invocation without starting it. Review the invocation, then start it in
Cursor. Every loop iteration must invoke `/parallel-slices-next` (or
`/slices-next`). The controller
named in JSON state acquires an ignored local lease, preventing another tool
from concurrently owning the same run.

## How Cursor executes slices

The `/loop` conversation is the root orchestrator and must not implement slice
code. Each iteration validates the durable plan, recomputes the Ready Slices,
and creates one detached managed worktree per ready slice. It then uses
Cursor's async subagents or `/multitask` for one fresh worker per returned
worktree.

Give each worker the exact packet from `run-slice-worker.md`, including its
worktree path, base commit, manifest, and worker ID. Do not ask `/multitask` to
invent a different split, and do not let multiple workers share the foreground
checkout. The slice graph already decided the safe split.

Workers returned as Ready Slices may run concurrently. The root responds as
workers finish, verifies each commit from repository evidence, and serially
integrates each dependency-eligible candidate without waiting for the other
workers. It recomputes readiness after every acceptance, so newly unlocked work
may start while older independent work continues. Workers never edit aggregate
state. `SLICE_ACCEPTED` continues the loop; only `MILESTONE_FINISHED` or
`PULL_REQUEST_READY` finishes the run.

Cursor describes independent subagent contexts in its
[subagents release](https://cursor.com/changelog/2-4) and async `/multitask`
plus worktree support in its
[multitask release](https://cursor.com/changelog/04-24-26). Parallel Slices'
own worktree commands remain the source of truth for slice base commits,
ownership, verification, and cleanup.

## Check status and recover

Run `/parallel-slices-status` for a read-only total progress bar, one bar per
slice, pipeline detail, and recovery guidance. `/slices-status` is its short
alias. After a restart, run either command before continuing `/loop` and follow
[Robust local recovery](robust-recovery.md).

## Hand off to another tool

Finish or explicitly stop the run, leave no active workers, make the goal
checkout clean, and release its lease. A later run may name `codex` or
`claude-code` in new JSON state. To change only the displayed default, run:

```bash
node scripts/parallel-slices/switch-agent.mjs codex
```

Changing the default never transfers an active run.
