---
name: parallel-slices-next
description: Orchestrate the next ready Parallel Slices set from Claude Code /goal, using fresh workers and isolated worktrees.
---

# Orchestrate the next approved set

Run `node scripts/parallel-slices/agent-profile.mjs require-enabled claude-code`
before taking any other action. Then acquire the run lease as `claude-code`;
stop if another controller owns that run.

Read `docs/parallel-slices/run-sliced-plan.md` completely and follow it as the
authoritative orchestration workflow. The `/goal` thread is a coordinator, not
a slice worker. Spawn one fresh background subagent per ready slice and direct
it to the managed worktree and `docs/parallel-slices/run-slice-worker.md`.
Respond to worker events: verify and serially integrate each eligible candidate
as soon as it is ready, without waiting for the entire set, then recompute
readiness after every accepted slice. Never invoke `/goal`; the active Claude
Code goal owns continuation.
