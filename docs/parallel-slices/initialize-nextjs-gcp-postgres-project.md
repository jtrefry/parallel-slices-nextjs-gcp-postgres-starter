# Initialize a Next.js GCP PostgreSQL project

Use this procedure only when `.parallel-slices/architecture.json` selects the
`postgres` profile. Confirm it before discovery:

```bash
node scripts/parallel-slices/architecture-profile.mjs profile "$(pwd)"
```

If the command prints another profile, use that profile's installed
initialization guide instead.

## Promise

The operating promise is:

> Describe the application, answer product questions, approve the plan, and let
> AI create everything else.

The developer is never asked to write code, tests, configuration,
infrastructure, diagrams, release notes, or documentation. The developer owns
the product and all consequential decisions, credentials, legal choices, plan
approval, production authorization, and final review.

## Safety boundary

Initialization may inspect the repository, initialize local Git when needed,
create the convention-compliant initialization goal branch, and write planning
and project documentation. When the developer explicitly selects GitHub mode,
the approved repository profile may also authorize establishing the exact
repository and its minimal base branch before the first local commit. Developer
approval of the generated Product Plan authorizes one local Product Plan
commit. AI then compiles optimized manifests and initial JSON run state into a
separate local commit without requesting a second approval. Initialization must
not implement application features, push the goal
branch, open a pull request, deploy, provision GCP resources, access production
data, or run a migration before that approval.

Never infer a consequential product, security, privacy, legal, billing,
authentication, data-retention, availability, or cost decision. Explain a
recommended default in plain language and ask the developer to choose.

## Phase 1: inspect before asking

Read root `AGENTS.md`, `docs/project/AGENTS.md`, `docs/plans/AGENTS.md`, the root
package and Turbo configuration, every application and package manifest, and
existing architecture or product documentation. Also read
`.parallel-slices/config.json`, `.parallel-slices/review.json`,
`.parallel-slices/repository.json`,
`apps/backend/migrations/AGENTS.md`, and
`apps/backend/migrations/README.md` before designing the quality or data
foundation. Read the current tool's `THIRD_PARTY.md` skill inventory when
present and treat curated skills as advisory under the repository's
requirements and Google Cloud architecture.
Identify whether this is a new scaffold or an existing product and preserve
existing behavior in the latter.

Report any private identifiers, credentials, generated artifacts, conflicting
package-manager files, protected-branch state, or existing uncommitted work
before writing.

If the directory is not already a Git repository, initialize it with `git init
-b chore/initialize-project`. Otherwise, verify that work is on a clean,
convention-compliant, non-protected goal branch before writing. Never place
initialization work directly on `main` or mix it into an unrelated branch.

## Phase 2: product interview

Ask short groups of related questions and record each answer. Recommend a
default when evidence supports one. Cover every applicable area:

1. Product purpose, target users, primary problem, and success measure.
2. Critical user journeys, roles, permissions, organizations or tenancy, and
   administrative workflows.
3. Public pages, authentication, account recovery, invitations, deletion, and
   data export.
4. Core entities, relationships, ownership, lifecycle, audit requirements, and
   retention.
5. Payments, email, files, search, analytics, AI, and external integrations.
6. Scheduled or finite background work that must run as Cloud Run Jobs through
   Cloud Scheduler.
7. Privacy, security, accessibility, localization, SEO, compliance, and age or
   geographic constraints.
8. Expected traffic, data volume, latency, availability, recovery, and cost
   constraints.
9. Brand direction, responsive behavior, supported browsers, and any product
   requirement that the installed Mantine component baseline cannot satisfy.
10. Environments, GCP organization and project ownership, domain and DNS
    ownership, observability, incident response, and release approval.
11. Package-manager choice (pnpm recommended), database access approach,
    authentication provider, transactional email provider, and any other
    architecture choice that materially affects the product.
12. GitHub publication mode. Ask for `local-only` or the exact GitHub
    `OWNER/NAME`, desired visibility, whether the agent may create it when
    absent, remote name, and base branch. When GitHub mode is selected, require
    the developer to authenticate the GitHub CLI with the intended account and
    verify the active username before recording the profile.
13. Optional independent multi-agent review. Ask whether to keep the installed
    default (`enabled=false`) or enable an ordered Codex, Claude Code,
    Antigravity, or Cursor reviewer list for planning and integrated slice
    review. Only when enabled, ask for model and supported effort choices,
    maximum rounds, and billing policy. Cursor reviewers require an explicit
    model ID, do not accept `effort`, and run as fresh Cursor Agent CLI processes
    rather than the Cursor controller conversation. For `subscription-only`,
    instruct the developer to run `cursor-agent login` and `cursor-agent status`;
    no `CURSOR_API_KEY` or project SDK dependency is required. Provider plans,
    quotas, and billing remain external.

Do not ask the developer to choose low-level implementation details that the AI
can derive safely from the approved requirements.

Record the approved publication contract in
`.parallel-slices/repository.json`. In GitHub mode, run `gh auth status --active
--hostname github.com` and `gh api user --jq .login`. If the active account is
not the approved GitHub account, stop and ask the developer to run `gh auth switch
--hostname github.com --user USERNAME` or `gh auth login --hostname github.com
--web`. Never request, print, or store an authentication token in the
repository.

In GitHub mode, establish the configured repository before the first plan or
slice commit. Follow `docs/parallel-slices/github-automation.md`. A genuinely absent
authorized repository must be created with a minimal GitHub-initialized README
so its default branch exists as the first pull request's base. Verify the actual
default branch, configure and fetch only the named remote, and base the still
unborn goal branch on it without overwriting the generated working tree. Never
create an empty remote and make the goal branch its first push. If local commits
already exist without a compatible remote base, or the remote contains an
unrelated application, stop and report the safe adoption or recovery path.

After the interview, translate the conversation into a formal requirement
inventory before creating slices. Assign stable sequential IDs such as `R1`,
`R2`, and `R3`; make each requirement atomic and testable; record whether it
came from a developer statement, discovery answer, existing product contract,
or approved inference; and attach observable acceptance evidence. Preserve
limits, exceptions, negative requirements, and coexistence expectations. Resolve
contradictions and duplicates explicitly. Every material conversation outcome
must become a requirement, locked decision, preservation invariant, non-goal,
or stated unresolved question.

## Phase 3: lock the baseline

Unless the product requirements justify a documented exception, propose:

- Next.js App Router with strict TypeScript;
- Mantine Core and Hooks for UI components, with its SSR-safe provider,
  color-scheme script, core styles, and PostCSS configuration;
- CSS Modules or ordinary CSS for product-specific styling, with no Tailwind
  dependencies, directives, configuration, or generated utility classes;
- ESLint and check-only Prettier;
- PostgreSQL as the application database, with Cloud SQL for production unless
  approved product requirements justify another database;
- timestamped forward-only migrations under `apps/backend/migrations/`, applied
  only by `scripts/database/postgres-migration-runner.ts`;
- exact root runtime dependencies for `pg` and `tsx`, an exact development
  dependency for `@types/pg`, and root `db:migrate` plus `db:migrate:status`
  scripts;
- Vitest and Testing Library for unit and component tests;
- PostgreSQL-backed integration tests;
- Playwright for browser E2E tests;
- pure unit tests with no Docker, database, network, or emulator dependency;
- behavior-focused tests traced to numbered requirements and capable of failing
  when the protected behavior regresses, with no placeholder, assertion-free,
  or trivially true cases;
- a risk-based coverage policy recorded in `docs/project/testing-strategy.md`,
  without treating blanket 100% repository coverage as proof of quality;
- Docker Desktop as the supported local runtime, with Rancher Desktop Moby as a
  free best-effort alternative;
- Docker Compose for PostgreSQL and selected official Google emulators;
- Cloud Run services, Cloud Run Jobs, Cloud Scheduler, Cloud SQL PostgreSQL,
  Secret Manager, Artifact Registry, Workload Identity Federation, and no Cloud
  Functions;
- immutable container images, least-privilege service accounts, structured
  logs, health checks, bounded retries, digest-pinned base and CI service
  images, and explicit migration jobs;
- root `security:sql` and `security:trivy` scripts wired through the configured
  core and full pipelines and lifecycle entry points in
  `.parallel-slices/config.json`;
- weekly package and GitHub Actions dependency updates, with additional
  ecosystems added only when the initialized repository uses them;
- removal of `open-pull-requests-limit: 0` from both generated Dependabot
  entries only after the complete quality foundation is operational; preserve
  the documented compatibility holds, and do not mark initialization complete
  while routine version updates remain dormant;
- Node.js 24 LTS and the selected package manager pinned in the repository;
- LF-normalized `.gitattributes` and editor configuration suitable for the
  selected workspace files.

## Phase 4: write the decision record

Create or update these documents without placeholders:

- `docs/project/product-brief.md`
- `docs/project/architecture.md`
- `docs/project/security-and-privacy.md`
- `docs/project/testing-strategy.md`
- `docs/project/local-development.md`
- `docs/project/gcp-operations.md`
- `docs/project/decision-log.md`

Include Mermaid diagrams for workspace ownership, request/data flow, deployment,
and background jobs where applicable. State unknowns honestly. Do not copy the
same policy into several documents; link to one owner.

The testing strategy must define requirement-to-test traceability, test-layer
ownership, regression-test expectations, deterministic test-data rules,
coverage thresholds or a documented reason they are not yet applicable,
critical paths requiring complete branch coverage, permitted coverage
exclusions, and whether mutation testing is required for high-risk code. When a
quantitative coverage policy is approved, the Product Plan must require its check
to a named pipeline rather than relying on an unenforced document.

Replace the bootstrap root `AGENTS.md` with concise project-specific
instructions that point to these canonical documents and exact commands. Do not
leave `INITIALIZATION_REQUIRED`, angle-bracket placeholders, sample application
names, or unused sections.

Advance the explicit project stage only after the contract documents and root
instructions are complete:

```bash
node scripts/parallel-slices/project-state.mjs advance contract-ready
```

## Phase 5: write the Product Plan

Create the complete Product Plan under `docs/plans/` from
`docs/plans/_PRODUCT-PLAN-TEMPLATE.md`. It must be understandable without a
scope manifest. Include:

- the formal numbered requirement inventory derived from discovery, with source
  traceability and observable acceptance evidence;
- existing behavior to preserve for an adopted repository;
- locked product and architecture decisions;
- security, privacy, data, cost, and operational boundaries;
- unit, integration, E2E, container-smoke, manual, coverage, and
  mutation-testing expectations, including why each selected layer proves the
  relevant behavior;
- Docker Desktop and emulator dependencies;
- PostgreSQL ownership, migration, rollback, and recovery policy;
- Cloud Run, Cloud SQL, job, scheduler, IAM, secrets, monitoring, rollback, and
  cost impact;
- one goal branch, publication mode, rollout, risks, explicit non-goals, later
  milestones, and the exact milestone definition of done; and
- acceptance traceability connecting every requirement to observable automated
  or manual evidence.

Keep `Status: DRAFT`. Do not create scope manifests, JSON run state, a slice
DAG, Ready Slices, path assignments, resource locks, quality-gate assignments,
or slice commit subjects yet. Those are compiled execution details, not part of
the human approval surface.

Run `node scripts/parallel-slices/doctor.mjs --initialized` after writing the
project documents and replacing the bootstrap root instructions. Resolve every
contract error before presenting the approval checkpoint. Missing executable
quality scripts may remain warnings because the future foundation slices own
their implementation.

## Product Plan approval checkpoint

Present only:

1. the concise product and milestone outcome;
2. requirements, locked decisions, and preservation rules;
3. architecture, security, privacy, data, and operational boundaries;
4. acceptance evidence, rollout, risks, costs, unknowns, and non-goals; and
5. the exact Product Plan path.

End with `INITIALIZATION_PRODUCT_PLAN_READY` and ask the developer to approve or
revise the Product Plan. Stop while approval is missing. Do not ask the
developer to approve a slice graph, manifest, state file, path assignment,
lock, gate, commit subject, or concurrency grouping.

## Commit the approved Product Plan

After explicit approval:

1. apply only the approved revisions and set `Status: APPROVED`;
2. stage the Product Plan and human-readable initialization contracts without
   any scope manifest or run state;
3. run the initialization pre-commit gate;
4. create one local Product Plan commit on the initialization goal branch; and
5. record its full commit SHA for compiled state as `planCommit`.

Do not amend or revise the approved Product Plan after compilation begins. A
material requirement or decision change requires a new Product Plan and a new
human approval checkpoint.

## Phase 6: AI-compile the optimized slice map

Use the approved Product Plan as source and the installed `nextjs-gcp-postgres`
Architecture Package as target configuration. Compile version 2 scope
manifests, the dependency DAG, and one version 5 JSON run-state file from
`docs/plans/_LOOP-STATE-TEMPLATE.json`. The state must name the controller,
reference every executable manifest, and record the Product Plan approval SHA
as `planCommit`. Run
`node scripts/parallel-slices/slice-compilation.mjs snapshot` and copy its
effective strategy and input hashes into `compilation`, then add concrete
sizing rationale. Add the version 1 `_planning.scope` only when
`.parallel-slices/review.json` enables configured multi-agent review.

The smallest vertical foundation outcome must result in a running, tested page
through the production-like local container path. Later slices may add selected
data, authentication, integrations, GCP definitions, and the first product
journey. Keep tightly coupled implementation and tests together. Optimize for
useful concurrency, not the largest slice count.

Before freezing paths, trace each outcome forward through its route, action, or
job entry point; shared request and response contracts; server and client
consumers; database, queue, cache, or external side effects; tests, fixtures,
and generated types; and release or operational artifacts. Reverse-trace every
proposed path through importers, callers, colocated tests, mocks, generated
counterparts, and useful Git co-change history. Then rehearse the future worker
packet in a separate read-only pass and revise the compiled map if the outcome
would require another write.

The installed Next.js/GCP default is `throughput-balanced` because its full
pipeline includes builds, integration tests, E2E tests, and repository security
scanning. Begin with the smallest coherent vertical outcomes and explicitly
compare which user journeys, API behaviors, persistence changes, operations,
and test evidence can start from the same accepted base. Draft and inspect that
dependency-minimal graph before combining compatible small outcomes. Combine
only when another complete candidate and integrated pipeline, review, evidence
record, and commit would cost more than the split gains through safe
concurrency, earlier dependency release, or retry isolation. If the committed
project config selects `isolation-first`, retain the smallest coherent outcomes
instead. Both strategies preserve identical gates, evidence, locks, review,
exclusive serial integration, streaming dependency release, and final audit.

Challenge every dependency before accepting the map. A path overlap, shared
lock, preferred technical-layer order, or desire to finish the backend first is
not a dependency; the downstream slice must consume an accepted upstream
outcome that cannot be represented by a committed contract, fixture, test
double, or narrower prerequisite. Record one
`compilation.parallelism.dependencyRationale` entry for every surviving edge,
then run:

```bash
node scripts/parallel-slices/slice-graph.mjs analyze \
  --plan docs/plans/<plan>.md
```

A non-trivial result with `maxParallelWidth` equal to `1` must be repartitioned
and analyzed again. Use `serialOnlyJustification` only when repository evidence
proves no safe pair can run concurrently; otherwise set it to `null`.

For every compiled slice, define:

- the Product Plan requirement IDs and evidence it implements;
- exact worker-owned and root-owned paths;
- machine-validated `coverage` dispositions for entry points, contracts,
  consumers, data side effects, tests, and operations;
- genuine dependency edges and logical resource locks;
- `parallel=allowed` unless a documented safety reason requires serialization;
- exact unit, integration, E2E, container-smoke, manual, coverage, or mutation
  evidence as applicable;
- its configured quality gate and permanent JSON/Markdown review paths;
- developer release-note classification and logical commit subject; and
- no separate branch, pull request, or human approval.

Set `minimum_stage=contract-ready` on quality-foundation manifests. Set
`minimum_stage=foundation-ready` on every product or feature manifest, including
the first product journey. The final foundation slice alone may advance
`.parallel-slices/project-state.json` to `foundation-ready`, and only after all
required quality scripts, the lockfile, test tiers, and selected local
dependencies are operational.

Compilation must not add or reinterpret product scope. If it exposes an
unresolved decision, new behavior, broader subsystem, or changed policy, return
to `INITIALIZATION_PRODUCT_PLAN_READY` for revision and approval.

Validate run state and graph, inspect the graph analysis, scope coverage, and
Ready Slices for unnecessary dependencies, omissions, overlapping paths, or
locks, and fix compilation mechanics without weakening gates. Stage the
compiled manifests and initial state, plus the planning scope only when
`.parallel-slices/review.json` has `enabled=true`. Run the initialization
pre-commit gate and create a separate local AI-compiled execution commit.

When multi-agent review is enabled, run the installed goal-level review against
that committed map:

```bash
node scripts/parallel-slices/review.mjs planning \
  --state docs/plans/loop-runs/<feature>-state.json
```

When review is disabled, skip that command and create no planning artifact or
provider credential. When enabled, resolve in-contract omissions only through the audited replacement-manifest
procedure in `docs/plans/AGENTS.md`; return semantic, subsystem, policy,
migration, deployment, external-action, or non-goal changes for Product Plan
approval. After all configured AI reviewers approve, stage and commit only the
generated `planning.json` and `planning.md`, then verify them with
`planning-review.mjs verify --state <state-path>`. In enabled mode, no worker may
start before that fingerprinted approval.

Present the compiled map as informational traceability: its sizing strategy and
rationale, slice DAG, initial Ready Slices, serial reasons, ownership and scope
coverage boundaries, `planCommit`, and exact compiled files. End with
`INITIALIZATION_PLAN_COMPILED` and, when enabled, the planning-review
fingerprint.

Implementation begins only after both commits. Use the installed sliced-plan
orchestrator rather than inventing a second continuation mechanism. Direct the
developer to `using-codex.md`, `using-cursor.md`, or `using-claude-code.md` so
the chosen controller generates the exact native `/loop` or `/goal` invocation.
Ready Slices may build concurrently in isolated worktrees, but the root
integrates each dependency-eligible candidate one at a time as it arrives and
recomputes readiness after every acceptance. In GitHub mode, it publishes one
pull request for the complete goal only after the final audit.
