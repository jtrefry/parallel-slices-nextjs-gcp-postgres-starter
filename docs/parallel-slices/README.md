# Parallel Slices project guide

This directory contains the workflows and operating guides installed into this
project. Start with a controller guide; use the remaining documents when you
need to understand planning, status, recovery, publication, review, or the
agent execution boundary.

## Start a project or milestone

Choose the controller you want to use. All supported controllers remain
installed; the default in `.parallel-slices/agent.json` is only a convenience.

| Controller  | Start here                                                   | Native continuation |
| ----------- | ------------------------------------------------------------ | ------------------- |
| Codex       | [Use Parallel Slices with Codex](using-codex.md)             | `/goal`             |
| Cursor      | [Use Parallel Slices with Cursor](using-cursor.md)           | `/loop`             |
| Claude Code | [Use Parallel Slices with Claude Code](using-claude-code.md) | `/goal`             |

The controller guide explains both first-time initialization and later
milestones. In both cases, the developer approves the human-readable Product
Plan before AI compiles executable slices. Configured independent AI reviewers
then approve that map before any application worker can start.

## Lifecycle at a glance

| Stage             | Developer action                                                                                    | Canonical guide                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Initialize once   | Describe the product, answer consequential questions, and approve the Product Plan                  | Selected controller guide above                                            |
| Plan a later goal | Invoke the controller's `parallel-slices-plan` command and approve the new Product Plan             | [Planning and optimized slices](planning-and-optimized-slices.md)          |
| Prepare execution | Invoke `parallel-slices-prepare` and review the generated `/loop` or `/goal` invocation             | Selected controller guide above                                            |
| Run slices        | Start the reviewed native invocation; the root schedules workers and integrates verified candidates | [Root-controller contract](run-sliced-plan.md)                             |
| Check progress    | Invoke `parallel-slices-status` or its `slices-status` alias                                        | [Status guide](check-run-status.md)                                        |
| Recover locally   | Run status first, preserve evidence, and follow the reported condition                              | [Robust recovery](robust-recovery.md)                                      |
| Finish            | Review the local milestone handoff or the single CI-green goal pull request                         | [Root-controller contract](run-sliced-plan.md#final-audit-and-publication) |

## Guides for developers

- [Planning and optimized slices](planning-and-optimized-slices.md) explains the
  human Product Plan, compiled dependency graph, Ready Slices, ownership, and
  serial integration boundary.
- [Status](check-run-status.md) explains the read-only progress report.
- [Robust recovery](robust-recovery.md) explains same-machine and cross-machine
  recovery limits.
- [GitHub publication](github-automation.md) explains optional repository
  authorization, the goal-level pull request, and actions that remain forbidden.
- [Multi-agent review](multi-agent-review.md) explains required planning-review
  evidence, integrated slice review, provider failure behavior, and how Cursor
  can remain the `/loop` controller while separate Cursor SDK agents review.

## Contracts used by controllers and workers

These documents are normative execution contracts. Developers normally do not
need to operate them directly:

- [Plan and compile a milestone](plan-milestone.md)
- [Prepare a native run](prepare-controller.md)
- [Root-controller contract](run-sliced-plan.md)
- [Slice-worker contract](run-slice-worker.md)

The selected architecture also installs its own initialization workflow and
platform documentation. Project-specific product, architecture, security,
testing, local-development, operations, and decision records live under
`docs/project/` after initialization.

## Safety boundary

Planning approval does not authorize merge, deployment, production migration,
package publication, release creation, repository-settings changes, or other
external actions. GitHub publication is optional and limited by
`.parallel-slices/repository.json`. When status or recovery evidence is
ambiguous, stop instead of cleaning worktrees, removing locks, or inferring
success.
