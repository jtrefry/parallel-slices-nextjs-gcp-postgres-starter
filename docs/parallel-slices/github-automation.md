# GitHub publication automation

Parallel Slices uses Git locally for every project. GitHub publication is
optional and is controlled by `.parallel-slices/repository.json`.

## Publication unit

One approved goal owns:

- one convention-compliant branch;
- one human-approved Product Plan commit;
- one separate AI-compiled execution commit;
- one separate independent AI planning-review commit;
- one separate logical commit for every accepted slice; and
- one pull request containing the complete goal.

Do not create a branch, pull request, or human-review interruption per slice.
Required human review occurs once on the goal-level pull request.

## Authenticate the intended account

The developer performs the interactive login once:

```bash
gh auth login --hostname github.com --web
gh auth setup-git --hostname github.com
```

Verify the active account and username:

```bash
gh auth status --active --hostname github.com
gh api user --jq .login
```

When several accounts are authenticated, select the intended account:

```bash
gh auth switch --hostname github.com --user YOUR_GITHUB_USERNAME
```

Configure the Git identity recorded on commits when needed:

```bash
git config --global user.name "YOUR NAME"
git config --global user.email "YOUR VERIFIED GITHUB EMAIL"
```

Never run `gh auth status --show-token` in an agent session. Never put a token in
chat, a prompt, a committed file, or command output captured as evidence.

## Repository profile

Local-only projects retain the installed default:

```json
{
  "$schema": "./repository.schema.json",
  "version": 1,
  "mode": "local-only",
  "remote": "origin",
  "baseBranch": "main"
}
```

For GitHub publication, the initialization agent records the developer's exact
decision:

```json
{
  "$schema": "./repository.schema.json",
  "version": 1,
  "mode": "github",
  "remote": "origin",
  "baseBranch": "main",
  "repository": "OWNER/REPOSITORY",
  "account": "YOUR_GITHUB_USERNAME",
  "visibility": "private",
  "createIfMissing": true
}
```

`account` is the exact authenticated user that the agent must verify, even when
an organization owns the repository. `visibility` is `private`, `public`, or
`internal`. `internal` applies only when the selected GitHub organization
supports it. A profile change requires developer approval.

## Establish the repository during initialization

The first pull request needs a real remote base branch. Therefore repository
creation or verification happens during project initialization, before the
first plan or slice commit, rather than after implementation is complete.

The initialization tool:

1. verifies `gh` authentication and requires the active username to equal the
   configured `account`;
2. verifies the exact `OWNER/REPOSITORY` with `gh repo view`, treating an
   authentication or network error as a failure rather than proof of absence;
3. if the repository is genuinely absent, first verifies that local `HEAD` is
   still unborn, and stops unless `createIfMissing` is true and visibility is
   explicit;
4. when creation is authorized, uses `gh repo create OWNER/REPOSITORY` with the
   matching `--private`, `--public`, or `--internal` flag and `--add-readme`;
   this creates the minimal remote base commit required for a pull request;
5. reads the actual GitHub default branch, records or verifies it as
   `baseBranch`, adds only the configured remote using the repository URL from
   `gh repo view`, and fetches that base branch;
6. for the still-unborn generated checkout, attaches the current goal branch
   and index to the fetched base without overwriting the working tree; and
7. refuses a mismatched remote or an existing repository with unrelated
   application history. An existing application must be cloned first and have
   Parallel Slices adopted into that checkout.

For a newly generated repository, the safe shape is equivalent to the
following commands after substituting values from the approved profile:

```bash
gh repo create OWNER/REPOSITORY --private --add-readme
gh repo view OWNER/REPOSITORY --json nameWithOwner,defaultBranchRef,url
git remote add REMOTE https://github.com/OWNER/REPOSITORY
git fetch REMOTE BASE_BRANCH
git update-ref refs/heads/GOAL_BRANCH refs/remotes/REMOTE/BASE_BRANCH
git read-tree refs/remotes/REMOTE/BASE_BRANCH
```

Use the visibility flag from the profile, not always `--private`. The final two
commands are permitted only while local `HEAD` is unborn and the index has no
staged project work. They attach the current branch and index to the fetched
base without replacing generated working-tree files. Never use this sequence to
rewrite an existing local history.

Creating an empty repository without `--add-readme` and pushing the goal branch
first is forbidden: that branch would become the remote default and there
would be no base for the first pull request. Directly seeding `main` from the
local project is also forbidden.

## Publish the completed goal

After the final goal audit, the run controller:

1. re-verifies the active account, repository identity, configured remote, and
   base branch;
2. pushes only the current goal branch and allows the Full pre-push gate to run;
3. creates one goal PR with `gh pr create`, or updates the existing PR for that
   branch with `gh pr edit`;
4. writes a title and body covering the goal, requirement IDs, slice commits,
   acceptance evidence, preservation results, tests, release notes, rollout,
   and rollback; and
5. monitors required checks with `gh pr checks --watch --fail-fast` and inspects
   code failures with `gh run view RUN_ID --log-failed`.

The agent may correct an in-scope CI failure, rerun the gate and independent
review, add a correction commit, push, and watch again. Authentication, network,
infrastructure, permission, remote-mismatch, and out-of-scope failures stop with
evidence instead of triggering policy changes.

This profile never authorizes `gh pr merge`, self-approval, protected-branch
pushes, force pushes, branch deletion, releases, package publication, repository
settings changes, deployment, or production migration.

## CI and delivery monitoring

Before human review, the agent monitors pull-request CI with:

```bash
gh pr checks --watch --fail-fast
```

Deployment cannot start until the human-approved PR is merged. After a human
merges it, a follow-up agent may identify the resulting protected-main quality
and delivery runs with `gh run list` and observe a selected run with:

```bash
gh run watch RUN_ID --exit-status
```

This is read-only monitoring. The agent reports whether delivery is disabled,
waiting for an environment approval, successful, or failed. It must not run
`gh workflow run`, `gh run rerun`, approve an environment, or otherwise trigger
or alter delivery without separate authorization.
