# Project documentation instructions

These instructions apply to AI-generated product, architecture, security,
testing, local-development, decision, and operations documents in this folder.

The developer supplies intent and decisions; AI writes and maintains every
document. Use direct language, concrete paths, diagrams where relationships are
otherwise difficult to follow, and links to one canonical owner instead of
duplicated policy.

Never invent a product or legal decision. Mark an unresolved decision clearly
and stop before implementation when it changes scope, security, privacy,
billing, data ownership, availability, cost, or external systems.

Every document must:

- describe the live repository rather than an aspirational architecture;
- distinguish current behavior, approved work, and later possibilities;
- identify ownership and dependency direction;
- include security, failure, recovery, observability, and cost implications
  where applicable;
- contain no credentials, private hosts, customer data, or machine-specific
  paths;
- avoid placeholders after project initialization is approved; and
- be updated in the same slice that changes its contract.

The selected architecture records the canonical initialized set in
`.parallel-slices/architecture.json`. Every architecture must cover product,
architecture, security, testing, local-development, and decision records; it
may add platform-specific documents when they are relevant. The currently
selected package is the source of truth instead of this file containing a
framework or cloud-specific list.

A typical initialized set starts with:

```text
docs/project/product-brief.md
docs/project/architecture.md
docs/project/security-and-privacy.md
docs/project/testing-strategy.md
docs/project/local-development.md
docs/project/decision-log.md
```

Do not create these as empty shells. The initialization skill writes them
from answered product questions before the Product Plan is approved.
