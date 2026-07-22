# Manual test scripts: agent instructions

These instructions apply to every manual test script in this directory. Create
feature or release scripts here, for example `account-settings-test-script.md`.
Start from
[`_MANUAL-TEST-SCRIPT-TEMPLATE.md`](./_MANUAL-TEST-SCRIPT-TEMPLATE.md).

## Purpose

Manual scripts are for people performing user acceptance testing (UAT) or
developer and QA verification. Keep them short, runnable, and easy to complete
while testing. Prefer a concise expected result followed by numbered steps.

Automated tests remain required. A manual script supplements unit, integration,
and end-to-end coverage when a person must evaluate usability, visual behavior,
external integration, operational behavior, or another result that automation
does not adequately prove.

## Document structure

Use this order:

1. Title and one-line purpose describing the feature or release.
2. Conventions, including scope values and execution fields.
3. Environment table with URLs, roles or test accounts, and useful deep links.
4. Shared setup and reusable test-data notes.
5. Progress summary when the script carries results across test runs.
6. Part A for UAT cases that can be completed through the product UI.
7. Part B for optional DEV/QA cases requiring database, API, log, or engineer
   access.
8. Sign-off fields.
9. Optional non-blocking layout or polish observations.

Do not put secrets, production credentials, personal data, or live customer
records in a test script. Reference an approved secret manager or test-data
procedure instead.

## Test IDs and headings

| Level   | Pattern                         | Example                                          |
| ------- | ------------------------------- | ------------------------------------------------ |
| Section | `## N. Short area name`         | `## 3. Account settings`                         |
| Test    | `### N.M Short behavior phrase` | `### 3.2 Saving preserves the selected timezone` |

- Number sections and tests so results have stable references.
- State the behavior under test, not only the control being clicked.
- Prefer one primary assertion per test. Split unrelated cases.

## Scope line

Place the scope immediately under every test heading:

```markdown
**Scope:** UAT
```

Allowed values are:

| Value         | Meaning                                                                           |
| ------------- | --------------------------------------------------------------------------------- |
| `UAT`         | A product stakeholder can complete the case through the UI.                       |
| `DEV/QA`      | The case requires database, API, logs, test-data preparation, or engineer access. |
| `UAT, DEV/QA` | Either path is acceptable.                                                        |

Do not bury the scope in the expected result.

## Execution fields

Every test uses this order:

1. Expected result before the steps.
2. Numbered steps.
3. Actual result, status, and notes after the steps.

Do not put these fields in a Markdown table. Narrow columns make scripts hard to
complete on smaller screens.

```markdown
### 1.1 Short behavior title

**Scope:** UAT

**Expected result:** One or two sentences describing the observable outcome.

**Test role:** `member` <!-- Omit when the section default applies. -->

1. Open **Account settings**.
2. Select the test value and choose **Save**.
3. Confirm the result described above.

**Actual result:**

**Status:**

**Notes:**
```

Use the fields as follows:

| Field               | Rule                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| **Expected result** | Describe what should happen, including important values, role, or visibility. Do not repeat every step. |
| **Actual result**   | Record what happened, such as `Matches expected.` or one concise deviation.                             |
| **Status**          | Use `PASS`, `FAIL`, `BLOCKED`, or leave blank when not run.                                             |
| **Notes**           | Add evidence such as a screenshot, trace, request, test-record ID, defect link, or prior test mapping.  |

Leave a blank line between Actual result, Status, and Notes so Markdown renders
each field separately. The heading already identifies the case, so do not
repeat its test ID inside each field.

When recording a run:

```markdown
**Actual result:** Matches expected.

**Status:** PASS

**Notes:** Test record `settings-104`; screenshot attached to the pull request.
```

## Writing steps

- Use a numbered list and one action per step where practical.
- Reproduce on-screen labels exactly and render them in bold.
- Put shared URLs in the environment table. Repeat a deep link only when the
  case requires a specific route or test record.
- State the role or test account when it differs from the section default.
- Keep Part A UAT cases verifiable through the UI without database access.
- Put SQL in Part B DEV/QA inside a fenced `sql` block, and identify the
  non-production database when it is not obvious.
- Put common roles, fixtures, accounts, dates, and other safe test values in
  shared setup instead of repeating them in every case.
- Include cleanup steps when a case creates durable test data.

## Progress and carry-forward

When revising a script after an earlier test run:

- Optionally include an Already passed table mapping the new test ID to the old
  test ID and result.
- Keep a one-line Not yet passed list for remaining cases.
- Do not invent internal requirement IDs in tester-facing titles. Use product
  language and keep requirement or issue IDs in Notes when helpful.
- Preserve prior evidence or link to the archived result. Never silently turn a
  previous pass into an unexecuted case.

## Sign-off

Use labeled fields rather than a narrow result table:

```markdown
## Sign-off

### Part A UAT

**Name:**

**Date:**

**Result:** Pass / Fail

### Part B DEV/QA (if run)

**Name:**

**Date:**

**Result:** Pass / Fail / Skipped
```

## Anti-patterns

| Avoid                                                 | Prefer                                                 |
| ----------------------------------------------------- | ------------------------------------------------------ |
| Expected, actual, status, and notes in a wide table   | Labeled fields with blank lines                        |
| Several result fields on one source line              | One field per line                                     |
| Repeating a test ID in every result field             | The numbered test heading                              |
| Long expected-result prose that duplicates every step | A short outcome plus numbered actions                  |
| SQL or engineer-only checks in Part A                 | Part B DEV/QA                                          |
| Placeholder values treated as saved results           | Explicit save, submit, refresh, and verification steps |
| Production data or credentials                        | Synthetic test data and approved secret references     |
| Em dashes in headings or notes                        | A colon, period, comma, or hyphen-minus                |

## Related evidence

- The approved implementation plan defines which manual scenarios apply.
- The scope manifest must allow the exact manual script path before the loop
  creates or edits it.
- The pull request links the completed script or summarizes its status.
- Developer release notes describe shipped behavior, not test execution detail.
