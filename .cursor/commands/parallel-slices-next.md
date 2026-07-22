# Orchestrate the next approved slice set

Execute exactly one root-orchestrator iteration of the repository's scoped
development loop.

Run `node scripts/parallel-slices/agent-profile.mjs require-enabled cursor`
before taking any other action. Read
`.cursor/skills/parallel-slices-next/SKILL.md` completely and follow it as the
authoritative set procedure. Also read root `AGENTS.md` when present,
applicable Cursor rules, nested plan instructions, the complete active plan,
durable run state, and next committed scope manifest named by the invoking
prompt.

The invoking prompt must supply the plan path, run-state path, exact milestone,
goal branch, repository publication mode, forbidden external actions, and final
stopping boundary. If any are absent, stop with `BLOCKED` before writing.

The root thread must not implement a slice. Use Cursor async subagents or
`/multitask` to run one fresh worker per ready slice in its managed worktree,
then integrate each verified, dependency-eligible candidate serially as soon as
it becomes available. Recompute readiness after every accepted slice instead
of waiting for a whole worker set. Do not start another Cursor
`/loop`, a hook, a shell scheduler, an automation, Codex `/goal`, or Claude Code
`/goal`. The outer Cursor `/loop` invocation owns all continuation.

Return only one of the skill's terminal markers with the required evidence
summary. The outer loop may continue after `SLICE_ACCEPTED`.
