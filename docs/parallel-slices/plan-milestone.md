# Plan and compile a Parallel Slices milestone

This workflow creates one human-approved Product Plan, then compiles its
machine-oriented execution files in a separate step. It never implements
application code, starts a continuation loop, deploys, migrates production
data, pushes, or opens a pull request.

Read root and nested instructions, `docs/plans/AGENTS.md`, all canonical
`docs/project/` contracts, `.parallel-slices/config.json`,
`.parallel-slices/review.json`, `.parallel-slices/repository.json`, and
`planning-and-optimized-slices.md`. Search the repository for requested behavior
and existing tests before asking questions.

Before Product Plan approval, configure and commit at least one independent AI
reviewer in `.parallel-slices/review.json`, then validate the configuration:

```bash
node scripts/parallel-slices/review.mjs validate
```

This reviewer is a fresh AI context, not an additional human approval step.

## Establish the bounded goal

Resolve the exact milestone, user-visible outcome, preservation boundary,
non-goals, publication mode, and consequential product or architecture
decisions. Translate the source material into atomic, stable requirement IDs
with source traceability and observable acceptance evidence. Ask the developer
only about decisions that repository evidence cannot safely resolve.

Create or verify one clean, convention-compliant, non-protected goal branch.
Do not mix planning into unrelated work.

## Write the Product Plan

Create the Markdown Product Plan from
`docs/plans/_PRODUCT-PLAN-TEMPLATE.md`. A person must be able to evaluate the
whole milestone without opening a scope manifest. Include requirements, locked
decisions, architecture and request flow, preservation invariants, negative
cases, real acceptance scenarios, testing expectations, release and operational
impact, a behavior-level contract and change-impact inventory, risks,
non-goals, rollout, and the milestone definition of done.

Keep `Status: DRAFT`. Do not create executable manifests, JSON run state, a
slice DAG, path assignments, locks, gates, or commit subjects yet. Never use a
future machine file to hide scope, policy, or a decision absent from the Product
Plan.

## Product Plan approval checkpoint

Present only the human approval surface:

1. milestone and user-visible outcome;
2. requirement and decision summary;
3. preservation rules and acceptance evidence;
4. architecture, security, privacy, and operational boundaries;
5. risks, unknowns, non-goals, and rollout; and
6. the exact Product Plan path.

End with `PRODUCT_PLAN_READY` and request explicit approval or revision. Stop
there while approval is missing. Human approval applies only to the Product
Plan; do not ask the developer to approve manifests, state, dependencies, paths,
locks, gates, or expected concurrency.

## Commit the approved Product Plan

After explicit approval:

1. apply only the developer's approved revisions;
2. set `Status: APPROVED` and complete the approval record;
3. stage the Product Plan without any scope manifest or run state;
4. run the configured pre-commit entry point; and
5. create one local commit for the approved Product Plan.

Record the full commit SHA. Do not amend or revise that Product Plan after
compilation begins. If a material requirement or decision changes, create a new
approval checkpoint and a new Product Plan rather than altering approved
history.

## AI-compile the execution map

Use the approved Product Plan as source and the selected Architecture Package as
target configuration. Before partitioning work, capture the exact committed
compilation inputs from the repository root:

```bash
node scripts/parallel-slices/slice-compilation.mjs snapshot
```

The command reports the effective sizing strategy plus the config and
Architecture Package hashes. They must match the Product Plan approval commit;
copy them into the version 4 run state's `compilation` object. If they do not,
stop and commit the intended configuration before creating a new Product Plan.

First project the stable requirements into coherent, independently verifiable
vertical outcomes. Then apply the configured sizing strategy:

- `isolation-first` keeps the smallest meaningful outcomes separate whenever
  they can be implemented, tested, reviewed, and retried independently.
- `throughput-balanced` combines compatible small outcomes when separate
  candidate gates, integrated gates, review, evidence, and commits cost more
  than the split gains through concurrency, earlier dependency release, or a
  smaller retry surface.

Both strategies use identical quality and safety boundaries. Never split by
file count, and never merge work if it would hide acceptance evidence, delay a
meaningful prerequisite, reduce safe concurrency, make review ambiguous, or
make a failure discard a disproportionate amount of work. Record concrete
split, merge, and critical-path reasoning in `compilation.sizingRationale`.

Before assigning paths, perform an impact-closure pass for every outcome:

1. Trace forward from each product entry point through the direct producer,
   public or shared schema, type, or protocol, consumers, persistence and
   external side effects, test fixtures and evidence, generated outputs, and
   operational communication.
2. Reverse-trace every proposed change path through symbol references,
   importers, callers, colocated tests, fixtures, mocks, generated counterparts,
   and relevant Git co-change history. Use `rg` and repository-native tools;
   do not infer closure from directory names alone.
3. Classify each required manifest coverage surface as `change`, `preserve`, or
   `not-applicable` with an exact path and reason where applicable. A
   `not-applicable` claim must explain why the approved behavior cannot affect
   that surface.
4. Challenge the result in a separate read-only pass using only the future
   worker packet. Ask whether the observable outcome and preservation cases can
   be completed without any write outside `allow`. Expand or repartition the
   compiled map before committing when the answer is no.

This pass must inspect existing contracts for incompatibility with negative or
empty outcomes. For example, behavior that creates no entity must be
representable by its current response schema, consumers, and tests.

For each resulting slice:

1. map only Product Plan requirement IDs and acceptance evidence;
2. keep tightly coupled implementation and tests together;
3. declare exact worker-owned `allow` paths;
4. add `coverage` entries for entry points, contracts, consumers, data side
   effects, tests, and operations; every `allow` pattern must be justified by
   at least one exact `change` path;
5. reserve JSON state and review artifacts as root-owned `coordinate` paths;
6. add dependency edges only for genuine completed-outcome prerequisites;
7. add logical locks for shared semantic resources that path matching cannot
   see;
8. default to `parallel=allowed`, using `parallel=forbidden` only with an exact
   reason dependencies, paths, or locks cannot express;
9. declare the exact gate, review path, release classification, and conventional
   commit subject; and
10. create one version 4 JSON state file from
    `docs/plans/_LOOP-STATE-TEMPLATE.json`, setting `planCommit` to the Product
    Plan approval commit; and
11. copy `docs/plans/scopes/_PLANNING-SCOPE-TEMPLATE.scope` to
    `docs/plans/scopes/<feature>/_planning.scope` and replace every example. The
    version 1 scope allows only review configuration, immutable planning
    contracts, the feature's manifest and correction-record namespaces, and
    the `planning.json`/`planning.md` pair declared by state.

Optimize according to the selected policy, not the greatest slice count.
Separate work only when it remains meaningful, testable, and safe in an
isolated worktree.
Shared package manifests, lockfiles, schemas, generated contracts, and
repository-wide configuration normally require a lock or serial slice.

Compilation is not authorized to reinterpret or expand the Product Plan. If it
exposes an unresolved decision, new behavior, broader subsystem, or changed
policy, stop and return to `PRODUCT_PLAN_READY` for human revision and approval.

## Validate and commit compiled execution files

Run from the repository root:

```bash
node scripts/parallel-slices/run-state.mjs verify \
  --state docs/plans/loop-runs/<feature>-state.json
node scripts/parallel-slices/slice-graph.mjs validate \
  --plan docs/plans/<plan>.md
node scripts/parallel-slices/slice-graph.mjs sets \
  --plan docs/plans/<plan>.md
```

Inspect every reported group of ready slices. Confirm that concurrent slices
have disjoint worker paths and locks, and that each dependency reflects a
causal prerequisite. Inspect the coverage records as the durable result of the
read-only worker challenge. Fix compilation mechanics rather than weakening
validation.

Stage only the compiled version 2 scope manifests, version 1 `_planning.scope`,
and initial version 4 JSON state. The Product Plan must not be staged. Run the
configured pre-commit entry point and create a separate local
compiled-execution commit.

## Run the independent planning review

After the compiled-execution commit, run from the repository root:

```bash
node scripts/parallel-slices/review.mjs planning \
  --state docs/plans/loop-runs/<feature>-state.json
```

The existing multi-agent review engine gives every configured reviewer a
read-only snapshot containing the approved Product Plan, active manifests,
state, current implementation, tests, architecture contracts, coverage map,
and authorized patch. Every reviewer must approve in the same reconciliation
round with no open critical or high finding.

If review requests an omitted exact path that is already required by the
approved outcome, follow the audited correction procedure in
`docs/plans/AGENTS.md`: add one replacement manifest, one correction JSON
record, and only that slice's state-pointer update. Do not include application
changes. A changed requirement, observable, subsystem, security or privacy
policy, migration, deployment, external action, or non-goal returns to Product
Plan revision and human approval.

Stage and commit only the generated `planning.json` and `planning.md` after an
approval. Verify the durable checkpoint:

```bash
node scripts/parallel-slices/planning-review.mjs verify \
  --state docs/plans/loop-runs/<feature>-state.json
```

Any correction changes the planning-contract fingerprint, so the prior
approval becomes stale and the same planning-review command must run again.
Worker creation enforces this checkpoint automatically.

Present the compiled result for traceability, not approval:

1. slice DAG with each outcome and gate;
2. initial Ready Slices and every serial reason;
3. worker, coordinator, and logical-lock ownership;
4. scope coverage and any `preserve` or `not-applicable` dispositions;
5. effective sizing strategy, compilation-input hashes, and sizing rationale;
6. Product Plan approval commit recorded by `planCommit`; and
7. exact compiled files and their commit; and
8. independent reviewer IDs, planning-review artifact paths, and approval
   fingerprint.

End with `MILESTONE_PLAN_READY`. Implementation begins later through the chosen
tool's preparation workflow and sliced-plan orchestrator.
