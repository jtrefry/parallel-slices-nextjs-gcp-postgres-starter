# Repository instructions

Status: INITIALIZATION_REQUIRED

This repository selects the versioned `nextjs-gcp-postgres` architecture in
`.parallel-slices/architecture.json`. Treat that profile as immutable during normal
setup; changing architectures requires an explicit, reviewed migration.

This repository follows a human-directed, AI-built development workflow. The
developer describes the application, answers product questions, and approves
plans. AI writes and maintains all code, tests, configuration, infrastructure,
documentation, diagrams, and release notes.

Cursor, Codex, and Claude Code are all enabled. The default convenience tool is
recorded in `.parallel-slices/agent.json`, but any enabled tool may initialize the
project or own a later run. Use one initialization command:

- Cursor: `/parallel-slices-init` (alias `/slices-init`)
- Codex: `$parallel-slices-init` (alias `$slices-init`)
- Claude Code: `/parallel-slices-init` (alias `/slices-init`)

The initialization workflow must replace this bootstrap file with concise
project-specific instructions and create the canonical documents under
`docs/project/`. Do not ask the developer to fill placeholders or write
documentation manually.

Read the matching guide before use:

- Codex: `docs/parallel-slices/using-codex.md`
- Cursor: `docs/parallel-slices/using-cursor.md`
- Claude Code: `docs/parallel-slices/using-claude-code.md`

The project stage is stored in `.parallel-slices/project-state.json`. Only the
installed initialization workflow may advance it to `contract-ready`; only the
gate-green final foundation slice may advance it to `foundation-ready`.

## Repository purpose and workspace map

- Product or service: not decided; resolve through `/parallel-slices-init`
- Deployable applications: inspect the scaffold before planning
- Shared packages: preserve the current Turbo dependency direction
- Architecture guide: `docs/project/architecture.md` after initialization

## Required commands

Run commands from the repository root unless a section says otherwise.

Use the package manager declared by the root `package.json` to run these root
scripts after AI initialization:

```text
install
format:check
lint
typecheck
security:sql
build
test:unit
test:integration
test:e2e
security:trivy
db:migrate:status
```

Document targeted test commands and any local service prerequisites here.
`.parallel-slices/config.json` is the source of truth for step aliases, timeouts,
Husky pipeline mappings, CI, and specialized slice pipelines. Pre-commit uses
`core`; pre-push uses `full`, which reruns core before integration, E2E, and
Trivy. Do not weaken or edit a pipeline merely to make a failing change pass.

## Architecture and code rules

- Search for existing types, helpers, components, and services before adding
  another implementation.
- Keep workspace boundaries and dependency direction explicit.
- Define the project's validation, error handling, logging, data access, and
  concurrency conventions.
- Document canonical examples by path instead of restating large code samples.
- Delete dead code created by a change and avoid unrelated refactors.
- Treat curated third-party skills as advisory. Project requirements, security
  policy, and documented Google Cloud architecture always take precedence.

## Next.js rules

- State whether each application uses App Router, Pages Router, or both.
- New architecture-generated applications use Mantine Core and Hooks as their
  component system. Prefer Mantine primitives and its Styles API before writing
  product-specific components; put justified reusable compositions in the
  shared UI package.
- Do not add Tailwind dependencies, directives, configuration, or generated
  utility classes. Use Mantine, CSS Modules, or ordinary CSS.
- Preserve `MantineProvider`, `ColorSchemeScript`, `mantineHtmlProps`, and the
  core stylesheet import in every generated App Router root layout.
- Keep secrets and privileged data in server-only modules.
- Document the project's Server and Client Component boundary conventions.
- Define cache, revalidation, dynamic rendering, middleware or proxy, Route
  Handler, and Server Action policies.
- Require accessible loading, error, empty, and not-found states where relevant.

## Security and data rules

- Authentication: unresolved until project initialization
- Authorization and tenant isolation: deny by default until documented
- Input validation: required at every external boundary
- Database: PostgreSQL by default; schema history belongs in
  `apps/backend/migrations/`
- SQL: parameterize runtime values; the SQL scanner is required in configured
  gates
- Secrets and environment variables: server-only and startup-validated
- Sensitive logging: credentials and personal data are prohibited
- Uploads, rate limits, and abuse controls: resolve before exposing endpoints

Never commit credentials or customer data. List commands that can modify shared
or production systems under forbidden actions.

## Git and external actions

- Never commit or push directly to `main` or another protected branch. Changes
  reach `main` only through an approved pull request.
- Create branches as `<type>/<short-kebab-description>`, using one of
  `feature`, `feat`, `fix`, `bugfix`, `hotfix`, `chore`, `release`, `docs`,
  `test`, `refactor`, `perf`, `ci`, or `build`.
- Work on a convention-compliant feature branch before editing.
- AI owns the local Git lifecycle. Initialize Git when absent. Before planning a
  new goal, verify the checkout is clean, update the configured base with a
  fast-forward-only pull when a remote exists, and create the goal branch. Do
  not ask the developer to run routine Git commands.
- One approved goal uses one branch and one pull request. Each accepted slice
  is a separate logical commit on that branch. Never create a branch, pull
  request, or human-review interruption for every slice.
- Preserve unrelated changes in a dirty worktree.
- Human approval applies only to the Product Plan and authorizes its local
  commit. AI then compiles optimized manifests, the dependency graph, and
  version 4 JSON state into a separate commit using the sizing strategy already
  committed in `.parallel-slices/config.json`. Those derived files are not a
  second approval surface. The completed planning sequence authorizes
  subsequent accepted slice commits on the named goal branch.
  `.parallel-slices/repository.json` is the durable publication authorization:
  `local-only` forbids remote contact; `github` authorizes only the named
  repository, remote, goal-branch push, one goal-level pull request, and CI
  monitoring.
- In GitHub mode, use `gh` during initialization to verify authentication and
  establish the exact repository and remote base before the first project
  commit, creating it only when `createIfMissing` is true. After the final goal
  audit, push the goal branch, create or update its one PR with a meaningful
  title and description, and monitor checks. Never merge or approve the PR on
  the developer's behalf.
- Do not deploy, publish packages or releases, change repository settings,
  migrate production data, or contact unrelated external systems without
  separate explicit authorization.
- Never force-push or use destructive Git commands to discard work.
- Forbidden commands include production deployment and migration commands until
  the initialized repository documents exact approved workflows.

Configure a GitHub ruleset that requires pull requests and the `quality` status
check for `main`; local hooks can be bypassed and are not sufficient protection.

## Deployment and data platform

- Deploy HTTP applications only as Cloud Run services.
- Use Cloud SQL for PostgreSQL and Secret Manager for database credentials.
- Keep applied migration files immutable and use a new forward migration for
  corrections. Never add transaction control to migration files because the
  installed runner owns each transaction.
- Run production schema migrations only through an explicitly authorized Cloud
  Run Job or migration workflow, never during application startup.
- Implement scheduled or finite background work as Cloud Run Jobs invoked by
  Cloud Scheduler. Do not deploy Cloud Functions.
- Use immutable Artifact Registry images and Workload Identity Federation.
- The implementation loop may write reviewed workflow or migration files but
  must never execute a deployment or production migration.

## Testing and definition of done

- Add the smallest test that proves each changed behavior at the correct layer.
- Trace tests to formal requirement IDs, acceptance scenarios, regression cases,
  or preservation invariants in the approved plan. A passing command without
  observable evidence is not proof of a requirement.
- Do not add placeholder, assertion-free, trivially true, skipped, focused, or
  filler-snapshot tests. A changed test must be capable of failing when its
  protected behavior regresses.
- Design production code with testable boundaries and explicit external
  dependencies. Do not expose internals or add production-only hooks merely to
  satisfy a test.
- Preserve existing integration paths and add regression coverage for fixed
  defects.
- Run targeted tests while developing and the repository's required root gates
  before reporting completion.
- State what was not tested and why.
- Keep pure unit tests independent of Docker, databases, networks, and cloud
  emulators. Container-backed tests belong in integration or E2E suites.
- Follow the risk-based coverage policy in `docs/project/testing-strategy.md`.
  Do not treat blanket 100% repository coverage as proof of quality, lower a
  threshold to pass a change, or accept an unexplained coverage regression.
- Use Docker Desktop as the supported local container runtime. Rancher Desktop
  with `dockerd (moby)` is a free, best-effort alternative only.

## Documentation and release notes

- Architecture and developer docs: `docs/project/`
- User documentation: define during initialization when applicable
- Developer release fragments: `docs/releases/developer/unreleased/`
- Record rollout, compatibility, monitoring, and rollback concerns for runtime
  changes.

## Scoped loop work

When executing an approved slice plan, also follow `docs/plans/AGENTS.md`, the
active human-readable plan, its JSON state, every committed scope manifest, and
the run controller's `parallel-slices-next` skill. Read
`docs/parallel-slices/planning-and-optimized-slices.md` and treat
`docs/parallel-slices/run-sliced-plan.md` as canonical. Use
`docs/parallel-slices/robust-recovery.md` and the native
`parallel-slices-status` command (or `slices-status` alias) to inspect or
recover an interrupted run.

Exactly one controller may own a particular run through the durable state and
ignored local lease: Cursor uses `/loop`; Codex and Claude Code use `/goal`.
That continuing thread is the root orchestrator and must not implement slice
code. It computes the next Ready Slices and spawns one fresh worker in an
isolated slice worktree for each safe slice. Ready workers may build concurrently;
the root verifies and integrates each eligible commit serially as it arrives,
updates aggregate state and review evidence, and recalculates readiness after
every accepted slice without waiting for unfinished independent workers.

Stop before expanding requirements, paths, systems, or policy beyond the
committed compiled manifest. Run each exact named pipeline and commit every accepted
slice separately. When the milestone is complete, publish and monitor one
goal-level PR only when `.parallel-slices/repository.json` selects GitHub mode;
otherwise stop with the committed local goal branch ready.
