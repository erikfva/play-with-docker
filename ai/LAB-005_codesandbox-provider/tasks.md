# Tasks: LAB-005 - Add CodeSandbox Provider

## 1. Dependencies and Setup

- [x] LAB-005-T01: Install `@codesandbox/sdk`.
  - Update `package.json`.
  - Update `package-lock.json`.
  - Pin the installed SDK version.

- [x] LAB-005-T02: Decide and configure the initial test strategy.
  - Either add a small Node test runner or document that initial validation uses focused provider tests plus `tests/api-tests.http`.
  - Ensure `npm test` no longer silently points to an unusable placeholder if automated tests are added.

## 2. Database and Session Model

- [x] LAB-005-T03: Add CodeSandbox credential columns to `sessions`.
  - Add `credentialRef`/`credentialFingerprint` support through `src/db/db.js`.
  - Account for PostgreSQL lowercasing of unquoted identifiers.
  - Keep provider helpers tolerant of both camelCase and lowercase row properties.

- [x] LAB-005-T04: Add sandbox/session-per-token uniqueness enforcement.
  - Add startup creation for a PostgreSQL partial unique index on active CodeSandbox `credentialFingerprint`.
  - Add an `ensureIndex` helper or direct `CREATE UNIQUE INDEX IF NOT EXISTS` bootstrap call.
  - Treat `TERMINATED`, `DELETED`, and `FAILED` as terminal statuses.
  - Return the existing session for the token when a duplicate create is requested.

## 3. Credential Loading

- [x] LAB-005-T05: Create CodeSandbox credentials loader.
  - Add `src/services/providers/codesandbox/credentials-loader.js`.
  - Support credential JSON format:
    ```json
    { "token": "xxxxx" }
    ```
  - Resolve credentials from `x-codesandbox-credentials` or request body `credentialRef`.
  - Support `s3://bucket/key`, S3 object key mode, and filesystem mode.
  - Reuse S3 client patterns from Google credential loading where practical.

- [x] LAB-005-T06: Add credential validation and token fingerprinting.
  - Validate JSON parse errors.
  - Validate missing or empty `token`.
  - Compute a SHA-256 token fingerprint.
  - Never log, return, or persist the raw token.

- [x] LAB-005-T07: Add filesystem credential path safety.
  - Resolve relative paths under `S3_MOUNT_DIR`, matching the Google credential loader pattern.
  - Resolve `s3://bucket/key` references to `S3_MOUNT_DIR/key` when `NODE_ENV=local`.
  - Reject path traversal outside the configured credentials directory.
  - Return a provider-safe path error.

## 4. CodeSandbox Provider

- [x] LAB-005-T08: Add SDK client helper.
  - Add `src/services/providers/codesandbox/client.js`.
  - Instantiate with `new CodeSandbox(token)`.
  - Do not use `new CodeSandbox({ apiKey: token })`.
  - Make SDK construction mockable.

- [x] LAB-005-T09: Add session mapper.
  - Add `src/services/providers/codesandbox/session-mapper.js`.
  - Map sandbox ID, title/env name, status, `cluster`, `bootupType`, `isUpToDate`, privacy, VM tier, credential ref, and credential fingerprint.
  - Keep `sshCommand` null.
  - Never include raw token in metadata.

- [x] LAB-005-T10: Implement `codesandbox-provider.js`.
  - Extend `BaseProvider`.
  - Implement `createSession`.
  - Implement `refreshSession`.
  - Implement `executeCommand`.
  - Implement `terminateSession`.
  - Disable keep-alive with `provider-managed-hibernation`.

- [x] LAB-005-T11: Implement CodeSandbox create flow.
  - Load selected credential.
  - Check for an existing session for the token before provider create.
  - Return the existing session instead of creating another sandbox when one exists.
  - Build SDK create options.
  - Always set SDK `id` to the configured Docker template id.
  - Reject non-Docker legacy `templateId` values before calling CodeSandbox.
  - Map string `vmTier` to SDK `VMTier`.
  - Support `title`, `description`, `tags`, `privacy`, `path`, `hibernationTimeoutSeconds`, and `automaticWakeupConfig`.
  - Return normalized session data with credential fields.

- [x] LAB-005-T12: Implement command execution flow.
  - Load token from the persisted credential reference.
  - Resume sandbox when needed.
  - Connect with `sandbox.connect()`.
  - Run `client.commands.run(command)`.
  - Dispose the client in `finally` when supported.
  - Return output through the existing route-compatible shape.

- [x] LAB-005-T13: Implement refresh flow without unnecessary wakeups.
  - Prefer non-waking SDK lookup if available.
  - Do not resume from `GET /sessions/:id` unless intentionally accepted.
  - If no non-waking lookup exists, return persisted state and defer resume to command execution.

- [x] LAB-005-T14: Implement termination flow.
  - Load token from the persisted credential reference.
  - Delete sandbox with the SDK.
  - Preserve current best-effort route behavior when provider cleanup fails.

## 5. Routing and Middleware

- [x] LAB-005-T15: Register the provider.
  - Update `src/services/provider-factory.js`.
  - Ensure `GET /api/v1/sessions/providers/supported` includes `codesandbox`.
  - Keep default provider as `gcs`.

- [x] LAB-005-T16: Refactor Google credential middleware usage.
  - Remove global `setGoogleCredentials` from all session routes.
  - Keep `requireServerToken` global for session routes.
  - Initialize Google credentials only for GCS create/refresh/command/terminate.
  - Preserve `x-google-credentials` behavior for GCS.
  - Ensure CodeSandbox and provider discovery do not require Google credentials.

- [x] LAB-005-T17: Update session creation route.
  - Pass `x-codesandbox-credentials` into provider context.
  - Persist `webHost`, `sshCommand`, `credentialRef`, and `credentialFingerprint` when returned.
  - Store `envName` as `created.envName || created.providerSessionId`.
  - Handle unique-index conflicts by returning the existing CodeSandbox session.
  - Best-effort delete the just-created sandbox if DB insert fails after provider create.

- [x] LAB-005-T18: Update command route only if needed.
  - Keep `{ output }` response for compatibility.
  - If adding safe provider fields, ensure GCS response compatibility is preserved.

## 6. Error Handling

- [ ] LAB-005-T19: Add provider-safe CodeSandbox errors.
  - Add or reuse `ProviderError` subclasses/codes:
    - `CODESANDBOX_CREDENTIALS_MISSING`
    - `CODESANDBOX_CREDENTIALS_INVALID`
    - `CODESANDBOX_TOKEN_MISSING`
    - `CODESANDBOX_TOKEN_IN_USE`
    - `CODESANDBOX_CREDENTIALS_PATH_INVALID`
    - `CODESANDBOX_CREATE_FAILED`
    - `CODESANDBOX_NOT_FOUND`
    - `CODESANDBOX_COMMAND_FAILED`
    - `CODESANDBOX_DELETE_FAILED`
  - Sanitize SDK errors.
  - Never include credential tokens in details.
  - Status note: credential-loader errors and command/not-found/template errors exist, but the full requested CodeSandbox-specific code set is not implemented consistently yet.

## 7. Documentation and API Tests

- [ ] LAB-005-T20: Update docs.
  - Update `README.md`.
  - Update `ai/project-overview.md`.
  - Document credential JSON format, `x-codesandbox-credentials`, Docker-only creation, one sandbox/session per token behavior, and termination semantics.
  - Status note: `README.md` and `ai/project-overview.md` still need CodeSandbox operator-limit and delete-on-terminate details.

- [ ] LAB-005-T21: Update HTTP request collection.
  - Ensure `tests/api-tests.http` has CodeSandbox create/get/command/delete requests.
  - Use `x-codesandbox-credentials`.
  - Add duplicate token reuse check.
  - Add missing/malformed credential scenario notes.
  - Status note: create/get/command/delete, custom credential header, unsupported template, and missing configuration examples exist; duplicate-token reuse and malformed credential notes are still missing.

## 8. Verification

- [x] LAB-005-T22: Add focused credential loader tests.
  - Valid file loads token and fingerprint.
  - Missing file returns provider-safe error.
  - Malformed JSON returns provider-safe error.
  - Missing `token` returns provider-safe error.
  - Path traversal is rejected.

- [ ] LAB-005-T23: Add focused provider tests with mocked SDK.
  - SDK constructor receives token string.
  - Create maps options correctly.
  - Command calls resume/connect/run/dispose.
  - Delete calls SDK delete.
  - Refresh does not wake when non-waking lookup is unavailable.
  - Status note: mocked provider tests cover create, command, command failure, Docker host injection, and delete; refresh/non-waking coverage is still missing.

- [ ] LAB-005-T24: Add route/integration tests or manual verification.
  - Provider discovery includes `codesandbox`.
  - CodeSandbox routes do not require Google credentials.
  - GCS routes still support `x-google-credentials`.
  - Duplicate token returns the existing session without creating a new sandbox.
  - DB unique-index conflict triggers best-effort sandbox cleanup and returns the existing session.
  - Status note: delete route behavior has focused tests, but the full route/integration checklist is not covered in automated tests.

- [ ] LAB-005-T25: Run verification.
  - Run automated tests if configured.
  - Run existing/manual API checks from `tests/api-tests.http`.
  - Run a real CodeSandbox smoke test using a credential JSON file.
  - Confirm temporary sandbox is deleted after test.
  - Status note: not marked complete until automated/manual verification results are recorded.

## 9. Definition of Done Checklist

- [x] `codesandbox` appears in supported providers.
- [x] CodeSandbox session create/get/command/delete works.
- [x] CodeSandbox creation uses the Docker template only.
- [x] CodeSandbox token is loaded from JSON file in S3 or server directory.
- [x] Raw token is never returned, logged, or persisted.
- [x] One CodeSandbox sandbox/session per token is enforced.
- [x] Duplicate CodeSandbox create requests for the same token reuse and return the existing session.
- [x] CodeSandbox routes do not require Google credential configuration.
- [ ] Existing GCS behavior is preserved.
- [ ] Docs and HTTP examples are updated.
