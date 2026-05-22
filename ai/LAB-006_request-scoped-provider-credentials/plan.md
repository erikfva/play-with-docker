# Plan: LAB-006 - Request-Scoped Provider Credentials

## Step 1: Remove Server-Wide Defaults

- Remove startup initialization that copies server-wide Google credential env vars.
- Stop CodeSandbox credential loading from reading server-wide default credential references.
- Keep S3, s3fs, and local resolution behavior for explicit credential references.

## Step 2: Require Credentials on Create

- For GCS create requests, resolve credentials from:
  - `x-google-credentials`
  - `googleCredentialRef`
  - `credentialRef`
- For CodeSandbox create requests, resolve credentials from:
  - `x-codesandbox-credentials`
  - `credentialRef`
- Return provider-safe `400` errors when required references are missing.

## Step 3: Persist and Reuse Session Credentials

- Store the selected GCS credential reference in `sessions.credentialRef`.
- Use stored GCS credential references for refresh, command execution, delete, terminate-all, and keep-alive.
- Continue using stored CodeSandbox credential references for existing sessions.

## Step 4: Update Documentation and Tests

- Update README examples to include provider credential headers.
- Update `ai/project-overview.md`.
- Add this story, plan, and tasks under `ai/LAB-006_request-scoped-provider-credentials`.
- Update tests that expected CodeSandbox default credential fallback.

## Step 5: Verify

- Run `npm test`.
- Confirm git branch contains only the intended code, docs, and AI planning files.
