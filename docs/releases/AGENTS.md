# Developer release-note rules

Developer notes describe implementation impact, compatibility, validation,
rollout, and monitoring for maintainers of the repository.

## Classification

- `release_notes=none`: no runtime, operational, dependency, developer-workflow,
  or user-visible effect.
- `release_notes=developer`: a developer fragment is required.

## Safety

Developer notes may not include secrets, credentials, customer data, private URLs,
real financial data, exploit instructions, or bypass details.

## Paths and names

```text
docs/releases/developer/unreleased/YYYY-MM-DD-feature-slice.md
```

Use the templates under `docs/releases/templates/`.
