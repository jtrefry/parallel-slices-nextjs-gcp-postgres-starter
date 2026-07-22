# Execution-map correction record instructions

These instructions apply to immutable correction records under this directory.

- Create records only for a discovered omission that prevents an unstarted
  slice from delivering its already-approved requirement and observable.
- Put each record at
  `docs/plans/corrections/<feature>/<slice>-revision-<n>.json` and reference
  `../../../../.parallel-slices/scope-correction.schema.json`.
- Name the predecessor and replacement manifests, the Product Plan approval
  commit, exact newly allowed paths, and concrete repository evidence.
- Set an attestation to `true` only after checking the Product Plan and current
  repository. A false or uncertain requirement, subsystem, policy, migration,
  deployment, external-action, or non-goal attestation means the correction is
  not authorized and requires a new Product Plan approval.
- Never use a wildcard in `addedAllow`, combine implementation changes with the
  correction commit, edit an earlier manifest or record, or correct a slice
  after candidate, gate, review, or acceptance evidence exists.
- Commit the record with exactly its replacement manifest and run-state pointer
  update. Then renew the independent planning review before creating a worker.
