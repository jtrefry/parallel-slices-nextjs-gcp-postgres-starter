# Prepare an approved native run

Generate the exact copy-paste invocation for the controller the developer wants
to own this run. Cursor uses `/loop`; Codex and Claude Code use `/goal`. The
default in `.parallel-slices/agent.json` is only a convenience and may be
overridden for a new run. Do not start a controller, edit files, commit, push,
open a pull request, deploy, or run a migration.

## Verify run evidence

Read root `AGENTS.md`, `.parallel-slices/agent.json`,
`.parallel-slices/project-state.json`,
`.parallel-slices/repository.json`,
`docs/plans/AGENTS.md`, the approved active plan, and its durable state. Verify
that the requested controller is enabled, the plan, JSON state, and executable
manifests are committed and unchanged, the current branch is the plan's
convention-compliant goal branch and is not protected, no different controller
owns its ignored local run lease, and the requested milestone does not extend
beyond the approved plan.

Infer the plan path, state path, next slice, final slice, preservation boundary,
repository publication mode, and excluded later work from repository evidence.
Ask the developer only when the exact milestone or GitHub repository profile is
not explicit. Never ask the developer to derive paths or fill placeholders.

## Return the invocation

Return:

1. the controller, active milestone, and next Ready Slices in one sentence;
2. any blocking preflight problem;
3. one complete plain-text native-controller invocation, following that
   controller's guide or the invocation contract in
   `docs/parallel-slices/run-sliced-plan.md` otherwise; and
4. the exact instruction for starting that controller.

The invocation must name the controller, plan, durable JSON state, exact
milestone and final slice, goal branch, repository publication mode, all stop
markers, forbidden external actions, and excluded later work. It must state
that the root is an orchestrator, must not implement slice code, and must spawn
one fresh worker in each managed worktree for every Ready Slice. Cursor must
direct every iteration to `.cursor/commands/parallel-slices-next.md`. Codex
must direct continuation through `$parallel-slices-next`; Claude Code must
direct continuation through `/parallel-slices-next`. For `/goal`, define
`PULL_REQUEST_READY` in GitHub
mode and `MILESTONE_FINISHED` in local-only mode as successful completion
conditions. `SLICE_ACCEPTED` means the goal remains active. `BLOCKED` and
`FAILED` are terminal impasses that must preserve evidence and stop further
work.

## Publication boundaries

In GitHub mode, initialization must already have established the exact named
repository, base branch, and remote authorized by the approved repository
profile. The invocation may verify that identity, push the goal branch, create
or update its single goal-level pull request, and monitor CI. It must still
forbid repository creation during completed-goal publication, merge,
deployment, package publication, release creation, unrelated external contact,
repository settings changes, protected-branch pushes, and production migration.
In local-only mode, it must forbid all remote operations.
