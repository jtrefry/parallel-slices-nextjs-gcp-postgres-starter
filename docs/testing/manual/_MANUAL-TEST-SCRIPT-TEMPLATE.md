# <Feature or release> manual test script

Use this script to verify <one-line feature or release purpose>.

## Conventions

- Scope is `UAT`, `DEV/QA`, or `UAT, DEV/QA`.
- Status is `PASS`, `FAIL`, `BLOCKED`, or blank when not run.
- Record no secrets, production credentials, personal data, or live customer
  records.
- Leave a blank line between Actual result, Status, and Notes.

## Environment

| Item                | Value                                                       |
| ------------------- | ----------------------------------------------------------- |
| Environment         | <local, test, staging, or other non-production environment> |
| Base URL            | <URL>                                                       |
| Default test role   | <role>                                                      |
| Build or commit     | <identifier>                                                |
| Test-data reference | <safe fixture or setup link>                                |

## Shared setup

1. <Create or select safe test data.>
2. <Confirm the default role and prerequisite state.>
3. <Record shared values used by several cases.>

## Progress summary

**Already passed:** None.

**Not yet passed:** 1.1, 2.1

**Tester:**

**Run date:**

## Part A. UAT

### 1. <Area name>

### 1.1 <Observable behavior>

**Scope:** UAT

**Expected result:** <Describe the visible outcome in one or two sentences.>

**Test role:** `<role>`

1. <Open the relevant screen.>
2. <Perform one action using the exact **On-screen label**.>
3. <Confirm the expected result.>

**Actual result:**

**Status:**

**Notes:**

## Part B. DEV/QA

### 2. <Technical area>

### 2.1 <Boundary or operational behavior>

**Scope:** DEV/QA

**Expected result:** <Describe the API, database, log, job, or integration result.>

1. <Prepare or identify synthetic test data.>
2. <Exercise the technical boundary.>
3. <Verify the result and capture safe evidence.>
4. <Clean up durable test data when applicable.>

**Actual result:**

**Status:**

**Notes:**

## Sign-off

### Part A UAT

**Name:**

**Date:**

**Result:** Pass / Fail

### Part B DEV/QA (if run)

**Name:**

**Date:**

**Result:** Pass / Fail / Skipped

## Layout and polish notes (optional)

- <Record non-blocking visual or wording observations here.>
