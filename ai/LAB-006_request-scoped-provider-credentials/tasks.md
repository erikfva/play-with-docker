# Tasks: LAB-006 - Request-Scoped Provider Credentials

## Task 1: Branch Isolation

- Create branch `deprecate-provider-default-credentials`.
- Keep all changes for this PR on that branch.

## Task 2: GCS Credential Flow

- Require `x-google-credentials`, `googleCredentialRef`, or `credentialRef` on GCS create.
- Persist the selected reference in `sessions.credentialRef`.
- Use the persisted reference from GCS provider operations and keep-alive recovery.
- Remove server-wide Google credential fallback behavior.

## Task 3: CodeSandbox Credential Flow

- Require `x-codesandbox-credentials` or body `credentialRef` on CodeSandbox create.
- Remove server-wide default credential fallback from the credential loader.
- Preserve stored credential reference reuse for non-create provider operations.

## Task 4: Documentation

- Update README credential mode and create examples.
- Update `ai/project-overview.md`.
- Add `spec.md`, `plan.md`, and `tasks.md` for this user story.

## Task 5: Verification

- Run the Node test suite.
- Review `git diff` and `git status` before handing off.
