# Spec: LAB-006 - Request-Scoped Provider Credentials

## User Story

As an API client creating remote development sessions, I want every GCS and CodeSandbox session creation request to provide the credential reference explicitly, so that the orchestrator does not depend on server-wide default provider credentials and each session is tied to the account requested by the client.

## Background

The previous implementation supported server-level defaults:

- GCS could initialize from server-wide Google credential environment variables.
- CodeSandbox could fall back to a server-wide default credential reference.

This made provider selection implicit and allowed create requests to succeed without naming the credential they should use.

## Scope

In scope:

- Deprecate and remove default-provider credential fallback for GCS create requests.
- Deprecate and remove default-provider credential fallback for CodeSandbox create requests.
- Require GCS create requests to provide credentials through `x-google-credentials`, body `googleCredentialRef`, or body `credentialRef`.
- Require CodeSandbox create requests to provide credentials through `x-codesandbox-credentials` or body `credentialRef`.
- Persist the selected GCS credential reference on the session row for refresh, commands, termination, and keep-alive recovery.
- Preserve persisted CodeSandbox credential reference reuse for non-create operations.
- Update docs, project overview, and tests.

Out of scope:

- Removing credential listing endpoints.
- Encrypting credential references or existing persisted SSH keys.
- Changing S3 bucket layout.

## Acceptance Criteria

1. `POST /api/v1/sessions` with provider `gcs` and no request credential reference returns `400` with code `GOOGLE_CREDENTIALS_MISSING`.
2. `POST /api/v1/sessions` with provider `codesandbox` and no request credential reference returns `400` with code `CODESANDBOX_CREDENTIALS_MISSING`.
3. GCS create requests persist the selected credential reference in `sessions.credentialRef`.
4. GCS refresh, command execution, termination, and keep-alive use the session credential reference instead of server defaults.
5. CodeSandbox credential loading does not read any server-wide default credential reference.
6. Server startup does not promote server-wide Google credential environment variables.
7. README and `ai/project-overview.md` describe request-scoped provider credentials.

## Current Change Set

- Updated `src/routes/sessions.js` to require explicit provider credential references on create.
- Updated `src/services/google-credentials-loader.js` to stop setting or reading default Google credentials.
- Updated `src/services/providers/gcs-provider.js` to initialize credentials from the persisted session credential reference.
- Updated `src/services/providers/codesandbox/credentials-loader.js` to remove default CodeSandbox credential fallback.
- Updated `src/server.js` to remove startup Google credential initialization.
- Updated README, project overview, and credential-loader tests.
