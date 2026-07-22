# Review artifact instructions

These instructions apply to permanent multi-agent review artifacts under this
directory.

- The adjacent JSON file is the canonical append-only review ledger. The
  Markdown file is generated from it by
  `scripts/parallel-slices/review.mjs`. Do not edit either file manually.
- Use the exact artifact paths declared by the committed scope manifest. Keep
  every attempt, including interrupted, operationally failed, and
  changes-requested attempts.
- Record reviewer findings, cross-review assessments, consensus, source
  fingerprint, changed paths, provider version, and only coarse authentication
  mode. Never record account identity, tokens, credentials, raw authentication
  output, environment values, or unrelated repository content.
- A successful artifact is evidence for only its recorded source fingerprint
  and scope manifest. Any source change requires the quality gate and a new
  review attempt.
- A planning artifact also records the normalized execution-map fingerprint.
  Commit its JSON and Markdown pair separately after the compiled-execution or
  correction commit. Any active-manifest or correction change requires a new
  attempt before worker creation.
- Commit slice JSON and Markdown files with the accepted slice. Never use any
  review output as permission to expand the Product Plan or weaken a quality
  gate.
- Never commit `.lock` or `.tmp-<pid>` runtime files. If one remains after a
  forced termination, verify that no review process owns it and follow the
  recovery message from the runner.
