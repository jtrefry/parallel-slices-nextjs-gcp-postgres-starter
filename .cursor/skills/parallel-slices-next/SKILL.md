---
name: parallel-slices-next
description: Orchestrate the next ready Parallel Slices set from Cursor /loop, using fresh workers and isolated worktrees.
---

# Orchestrate one approved set

Run `node scripts/parallel-slices/agent-profile.mjs require-enabled cursor`
before taking any other action. Then acquire the run lease as `cursor`; stop if
another controller owns that run.

Read `docs/parallel-slices/run-sliced-plan.md` completely and follow it as the
authoritative orchestration workflow. The `/loop` thread is a coordinator, not
a slice worker. Use Cursor async subagents or `/multitask` to spawn one fresh
worker per ready slice, direct each worker to its managed worktree and
`docs/parallel-slices/run-slice-worker.md`. Respond to worker events: verify and
serially integrate each eligible candidate as soon as it is ready, without
waiting for the entire set, then recompute readiness after every accepted
slice. Never invoke another `/loop`; the outer Cursor controller owns
continuation.
