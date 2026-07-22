# Scoped implementation plan rules

These instructions apply to every plan, state file, and scope manifest under
`docs/plans/`. They supplement the repository's existing instructions without
replacing its architecture, security, style, or testing rules.

All implementation work must run on a named branch accepted by
`.parallel-slices/config.json`. Never commit or push directly to `main`, `master`,
or another protected branch. Changes reach the default branch only through an
approved pull request with required GitHub checks.

One approved Product Plan owns one goal branch and, when GitHub publication is
configured, one pull request. Each executable slice becomes a separate logical
commit on that branch. Never create a branch or pull request per slice. Plan
approval authorizes its own local commit, AI compilation of execution files,
an independent AI planning review, audited execution-map corrections that stay
inside the approved contract, and slice commits within its approved
requirements and boundaries;
the repository publication profile controls remote creation, push, pull-request
creation, and CI monitoring.

Before writing a new goal plan, AI must ensure Git exists and create the goal
branch. In GitHub mode, start from the configured base branch after `git fetch`
and a fast-forward-only update. In local-only mode, create the goal branch from
the approved local base. Stop rather than switching branches when unrelated
work is present.

## Plan contract

Before defining slices, translate the approved product conversation, discovery
answers, existing product documents, and preservation constraints into one
formal requirement inventory. Do not treat chat history as the durable source
of truth after planning.

Requirements must:

- use stable sequential IDs such as `R1`, `R2`, and `R3`;
- express one atomic, testable outcome or constraint per ID;
- preserve material wording, limits, exceptions, and negative requirements from
  the developer rather than weakening them through summarization;
- identify their source as a developer requirement, discovery answer, existing
  product contract, or approved inference;
- include observable acceptance evidence without prescribing implementation
  details unless the implementation itself is an approved constraint; and
- remain stable after approval. Never renumber or reuse an approved ID; add a
  new ID only through an approved scope change.

Resolve contradictions, duplicates, ambiguous terms, and missing consequential
decisions before presenting the plan for approval. Every material source
statement must map to a requirement, locked decision, preservation invariant,
non-goal, or explicitly unresolved question. Do not silently drop it.

An implementation-ready plan must contain:

1. One bounded milestone and its user-visible outcome.
2. The formal requirement inventory with stable IDs and source traceability.
3. Existing behavior and integration paths that must remain unchanged.
4. Explicit non-goals, including adjacent refactors and policy changes.
5. A request dependency graph when changing loading, authentication, data
   fetching, caching, middleware, proxy, layouts, or server/client boundaries.
6. The smallest end-to-end vertical path before broad infrastructure work.
7. Product acceptance scenarios at real browser and server boundaries.
8. Release communication requirements for the complete goal.
9. An acceptance matrix mapping every requirement to observable evidence.
10. A contract and change-impact inventory naming applicable entry points,
    public or shared contracts, consumers, data side effects, test surfaces,
    and operational effects without assigning executable file paths.
11. A definition of done for the named milestone.
12. One goal branch, one goal-level pull-request title, and the repository
    publication mode from `.parallel-slices/repository.json`.

Write and present the complete human-readable Product Plan without executable
manifests, JSON run state, a slice DAG, path assignments, locks, gates, or commit
subjects. Human approval applies only to this Product Plan. Set its status to
`APPROVED` and commit it before creating any execution files.

## AI compilation contract

After the Product Plan approval commit, AI compiles its stable requirements,
decisions, invariants, non-goals, and acceptance evidence into optimized
executable slices. The selected architecture package supplies repository shape,
installed contracts, and quality floors to this compilation step.

Compilation must:

- create version 2 scope manifests and one version 4 JSON run state;
- create one version 1 `_planning.scope` that owns only the plan, state,
  review configuration, compiled-manifest namespace, correction-record
  namespace, and permanent planning-review pair;
- record the exact Product Plan approval commit in `planCommit`;
- read `sliceCompilation.sizingStrategy` from the committed
  `.parallel-slices/config.json` and record its compilation-input snapshot;
- record concrete sizing rationale explaining the material split, merge, and
  prerequisite-unlock decisions;
- map only requirement IDs and behavior already present in the Product Plan;
- trace every outcome forward from its entry point through contracts, consumers,
  data side effects, tests, and operations, then reverse-trace proposed files
  through references, importers, colocated tests, fixtures, generated outputs,
  and relevant history;
- derive dependencies, worker paths, coordinator paths, logical locks, gates,
  review artifacts, release classifications, and commit subjects;
- record machine-validated scope coverage for every slice and challenge whether
  a fresh worker could complete it without an out-of-scope write;
- validate the graph and inspect the expected ready slices; and
- commit manifests and initial state separately from the Product Plan.

Create the planning scope from
`docs/plans/scopes/_PLANNING-SCOPE-TEMPLATE.scope` and replace every example;
do not broaden its planning-only namespaces.

Before Product Plan approval, configure and commit at least one independent AI
reviewer in `.parallel-slices/review.json`. After the compiled-execution commit,
run the goal-level planning review and commit its generated JSON and Markdown
artifacts separately. No worker may start until the latest approval matches the
active execution-map fingerprint. A later audited correction invalidates that
approval automatically and requires a fresh planning-review attempt, not a
human manifest review.

The architecture package supplies the installed sizing default. A developer may
override it in `.parallel-slices/config.json`, but the override must be
committed before Product Plan approval so compilation can pin it reproducibly.
Both strategies preserve the same gates, evidence, review, scope, lock, and
retry contracts:

- `isolation-first` prefers the smallest coherent, independently verifiable
  vertical outcomes, even when that creates more pipeline executions. Never
  split by file or line count alone.
- `throughput-balanced` starts from those same semantic outcomes, then combines
  compatible small outcomes when separate work would add more pipeline,
  review, evidence, and integration overhead than useful concurrency, earlier
  dependency release, or retry isolation. Never combine work when doing so
  hides acceptance evidence, delays a meaningful prerequisite, enlarges the
  retry blast radius disproportionately, or makes review ambiguous.

Do not invent timing measurements. Prefer committed project evidence when it
exists and otherwise use the architecture's configured default plus concrete
dependency, path, lock, gate, and review costs. Optimize useful throughput, not
slice count, while keeping every resulting slice bounded and independently
verifiable.

Compiled execution files are machine-oriented derivatives, not a second human
approval surface. Present their DAG and expected concurrency as an informational
result. If compilation exposes an unresolved product decision, new requirement,
broader subsystem, or changed policy, stop and revise the Product Plan for a new
human approval instead of hiding the change in a manifest.

Resolve known product, UX, security, privacy, financial, performance, and
scalability decisions during planning. Do not defer a known decision to the
implementation loop.

## Slice contract

Every executable slice declares:

- requirement IDs;
- one observable outcome;
- exact files or narrow path patterns it may touch;
- preservation and coexistence invariants;
- unit, component, integration, and end-to-end tests that apply;
- the exact `docs/testing/manual/<feature>-test-script.md` path when human UAT
  or DEV/QA evidence is required, or an explicit reason it is not required;
- dependencies and the exact named pipeline from `.parallel-slices/config.json`;
- whether parallel execution is allowed, any reason it must be serialized, and
  logical resource locks for shared contracts that path matching cannot see;
- worker-owned paths separately from root-controller coordination paths;
- developer release-note classification and reason;
- its committed scope-manifest path;
- its exact permanent JSON review path and generated Markdown peer; and
- one scope-coverage disposition for every required impact surface; and
- its conventional commit subject describing the observable outcome.

Every slice requirement ID must exist in the approved inventory. Every approved
requirement must appear in at least one executable slice and in the plan's
traceability matrix. Tests must prove the requirement's observable behavior or
a named preservation invariant; merely executing a test file is not evidence.

Prefer a user-visible vertical slice. A prerequisite-only slice must name the
exact approved requirement that cannot be delivered without it and why current
infrastructure cannot be reused.

## Scope manifest

Create one manifest per executable slice at:

```text
docs/plans/scopes/<feature>/<slice>.scope
```

Format:

```text
version=2
revision=1
plan=docs/plans/2026-01-01-example.md
state=docs/plans/loop-runs/example-state.json
slice=1.1
requirements=R1,R2
depends_on=none
observable=The user can complete the smallest end-to-end workflow.
minimum_stage=foundation-ready
release_notes=developer
gate=full
parallel=allowed
lock=example-contract
review=docs/plans/reviews/example/1.1.json
commit=feat(example): deliver the smallest end-to-end workflow
coverage=entrypoint|change|app/example/route.ts|The request entry point must invoke the approved workflow.
coverage=contract|change|app/example/contract.ts|The response contract must represent every approved outcome.
coverage=consumer|change|components/example/ExampleForm.tsx|The existing user-facing consumer must handle the changed result.
coverage=data-side-effect|not-applicable|none|This slice does not create or mutate durable data.
coverage=test|change|tests/example/workflow.test.ts|The acceptance test proves the observable result and refusal path.
coverage=operations|change|docs/releases/developer/unreleased/2026-01-01-example-1-1.md|The developer fragment communicates the changed contract.
allow=app/example/**
allow=components/example/**
allow=tests/example/**
allow=docs/releases/developer/unreleased/2026-01-01-example-1-1.md
coordinate=docs/plans/loop-runs/example-state.json
coordinate=docs/plans/reviews/example/1.1.json
coordinate=docs/plans/reviews/example/1.1.md
```

Rules:

- Paths are repository-relative globs. Prefer exact files.
- `depends_on` is `none` or a comma-separated list of slice IDs from the same
  plan. The graph must be acyclic. Readiness is derived from accepted
  dependencies in durable state.
- Default to `parallel=allowed`. Use `parallel=forbidden` plus
  `parallel_reason=<exact reason>` only when the slice must run alone.
- `lock` entries are stable lowercase logical resource names such as
  `workspace-dependencies`, `authentication-contract`, or `database-schema`.
  Ready slices sharing a lock are serialized even when their paths differ.
- `allow` entries are worker-owned paths. `coordinate` entries are written only
  by the root controller or its configured review runner while integrating a
  candidate. The two sets must not overlap. Version 2 manifests coordinate the
  JSON run state and both permanent review artifacts.
- Every version 2 manifest names the shared JSON run state with `state=` and
  coordinates that exact path. Workers never edit aggregate run state.
- Ignored runtime attempt ledgers are not `allow` or `coordinate` paths. The
  root creates one worker and one integration ledger per attempt. A worker may
  update only its own ledger through `run-tracking.mjs`; the root owns the
  integration ledger. Never edit, commit, or push either ledger directly.
- Use `minimum_stage=contract-ready` only for approved quality-foundation
  slices. All product and feature slices require `foundation-ready`.
- `*` matches within one directory, `**` crosses directories, and `?` matches
  one non-separator character.
- Repository-wide `*` and `**` manifests are forbidden.
- Include tests, generated files, documentation, and developer release
  fragments in worker scope when the slice may change them.
- Every newly compiled manifest must contain at least one `coverage` record for
  each of `entrypoint`, `contract`, `consumer`, `data-side-effect`, `test`, and
  `operations`. The format is
  `surface|change|exact/repository/path|reason`,
  `surface|preserve|exact/repository/path|reason`, or
  `surface|not-applicable|none|reason`.
- `change` paths must be covered by `allow`; `preserve` paths must remain
  outside `allow` and already exist; every `allow` pattern must cover at least
  one exact `change` path. Coverage explains and checks the executable scope but
  never grants permission independently of `allow`.
- Derive coverage from repository evidence. Search the behavior's symbols and
  call sites, inspect shared schemas and types, direct producers and consumers,
  persistence or side effects, colocated and integration tests, fixtures,
  generated files, release requirements, and relevant historical co-changes.
  Do not mark a surface `not-applicable` merely because the first proposed
  implementation does not mention it.
- Include one exact JSON path under `docs/plans/reviews/` and its Markdown peer
  as `coordinate` paths. Slice review may be disabled, but independent planning
  review is mandatory for every newly compiled version 4 run.
- Include the exact manual test-script path when the slice creates or updates
  human verification steps. Follow `docs/testing/manual/AGENTS.md`.
- An allowed path permits changes only for the listed requirement IDs.
- Do not put the immutable Product Plan or scope manifest in `allow` or
  `coordinate`. Commit the approved Product Plan first. Then commit its compiled
  manifests and initial JSON run state before implementation begins. Commit
  policy refuses combining those stages and refuses later revisions to either
  source or compiled files.
- Commit each accepted executable slice separately on the single goal branch.
- Each parallel worker creates one candidate commit in a detached worktree. The
  root controller serially integrates candidates, updates run state, reruns the
  integrated gate and review, and creates the accepted slice commit.
- The root integrates a verified, dependency-eligible candidate as soon as the
  goal checkout is available; it does not wait for unfinished independent
  workers. After each accepted slice, recompute readiness and start newly
  unlocked non-conflicting work.
- Each retry receives a new attempt ledger and worker ID. Preserve earlier
  failure and pipeline evidence instead of replacing it.
- Never expand a manifest after editing an out-of-scope file.
- Pre-push and CI evaluate the complete branch range from the target merge base.
  Every changed path must be covered by a new manifest on that branch.
- Existing scope manifests are immutable. A permitted execution-map correction
  adds a consecutive replacement revision and correction record; it never edits
  or deletes an earlier revision.
- The review runner is the only writer for review artifacts. Follow
  `docs/plans/reviews/AGENTS.md` and commit both artifacts with an accepted
  reviewed slice.
- When multi-agent review is disabled, use a fresh independent read-only
  reviewer and record its evidence in the slice's `reviewEvidence` state field.
  Do not create placeholder JSON or Markdown review artifacts.

Run the preflight before writes:

```bash
node scripts/parallel-slices/gate.mjs \
  --scope-file docs/plans/scopes/<feature>/<slice>.scope \
  --scope-check-only
```

Default implementation slices to `gate=full`. Use `gate=core` only when the
plan records why integration and E2E tests cannot exercise the slice's behavior.
Projects may define a more specific named pipeline, such as
`gate=database-change`, when it extends the required default evidence with
approved checks. Never invent a pipeline name that is absent from the committed
configuration.

## Scope changes

Mechanical splitting, merging, or reordering is allowed only when requirement
IDs, observable behavior, subsystems, non-goals, and the union of allowed paths
remain unchanged. Record the adjustment in durable state.

If repository evidence or an independent planning review proves that an
unstarted slice cannot complete its already-approved observable outcome, the
controller may correct the compiled map without another human approval only by:

1. adding one immutable replacement manifest with the same requirement IDs,
   observable, dependencies, gate, locks, release class, and commit subject;
2. adding only exact worker paths, never globs, and recording exact `change`
   coverage for every addition;
3. writing one schema-valid record under
   `docs/plans/corrections/<feature>/` with discovery evidence and every
   unchanged-boundary attestation set to `true`;
4. changing only the run state's manifest and review-artifact pointers for that
   slice, resetting it to `not_started` before any candidate or acceptance
   evidence exists; and
5. committing those three files alone, then renewing the independent planning
   review before worker creation.

The original manifest remains in history and the graph resolves only the
unsuperseded revision. The commit gate refuses removed paths, removed locks,
removed changed or preservation coverage, wildcard additions, changed product
semantics, combined implementation edits, or corrections after candidate
evidence exists.

Stop for explicit approval before adding or changing:

- a requirement or user-visible behavior;
- an allowed subsystem or path outside the approved union;
- authentication, authorization, billing, privacy, financial, or security
  policy;
- caching, rendering, performance, or scalability behavior;
- a database or infrastructure migration;
- deployment or external-system actions;
- an adjacent fix or refactor not required by the milestone.

Changing the configured GitHub repository, visibility, base branch, or
create-if-missing policy also requires explicit approval. A configured GitHub
profile authorizes only the named goal branch, its one pull request, and CI
monitoring. It never authorizes merge, deployment, publication, release
creation, repository-settings changes, or production migration.

Record out-of-scope discoveries in the state file with evidence, severity,
whether they block the slice, the narrowest in-scope alternative, and a proposed
follow-up. A discovery is not permission to fix it.

## Architecture preservation review

For each slice, read `.parallel-slices/architecture.json`, the root instructions,
and architecture documentation, then explicitly review applicable boundaries:

- application lifecycle, process, navigation, and state boundaries;
- client, service, backend, device, operating-system, and external API boundaries;
- loading, error, empty, unavailable, offline, and recovery behavior;
- accessibility and platform interaction conventions where applicable;
- framework, language, dependency, and shared-component boundaries declared by
  the selected architecture;
- environment-variable exposure and server-only secrets;
- public protocol, route, command, file-format, and status-code compatibility;
- concurrency, validation, authorization, data ownership, and isolation; and
- packaging, signing, deployment, distribution, and platform-version behavior.

Do not claim a boundary is preserved without an applicable test or documented
inspection result.
