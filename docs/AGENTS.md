# Repository documentation instructions

These instructions apply to the complete `docs/` tree. Documentation belongs
at the repository root under `docs/`; never place a Next.js application,
workspace package, package manifest, framework configuration, or application
source files in this directory.

Keep each document in the established owner:

| Path                    | Purpose                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `docs/project/`         | Live product, architecture, security, testing, development, decision, and operations contracts |
| `docs/plans/`           | Approved Product Plans plus compiled state, scopes, corrections, and permanent review evidence |
| `docs/releases/`        | Developer-facing release fragments and templates                                               |
| `docs/testing/manual/`  | Human UAT and developer or QA test procedures                                                  |
| `docs/parallel-slices/` | Version-matched Parallel Slices operating procedures installed with this repository            |

Follow every more-specific `AGENTS.md` below these directories. Product Plans
use `docs/plans/YYYY-MM-DD-<short-kebab-description>.md`; their generated run
state, scope manifests, corrections, and review artifacts use the subdirectories
and templates defined by `docs/plans/AGENTS.md`.

For all documentation:

- keep one canonical owner for each fact or procedure and link to it instead of
  maintaining copies;
- use lowercase kebab-case filenames unless an installed template defines a
  different contract;
- describe the current repository, clearly separating approved future work
  from implemented behavior;
- update affected documents in the same change as the code, configuration, or
  workflow they describe;
- use repository-relative paths and links that still resolve after installation
  into a newly created repository;
- write commands for execution from the repository root unless a step names a
  different working directory;
- keep examples synthetic and free of credentials, private identifiers,
  customer data, and machine-specific absolute paths;
- preserve templates as templates and create feature-specific documents at the
  paths their local instructions require; and
- add or update the nearest documentation index when introducing a new
  documentation category or changing how maintainers discover it.

Create a nested `AGENTS.md` when a new generated documentation subtree needs a
specialized contract. Do not weaken or duplicate the repository's root safety,
Git, testing, or delivery rules here.
