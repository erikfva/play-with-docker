# Tasks: LAB-008 — GitHub Codespaces Provider

**Plan**: `ai/LAB-008_codespace-provider/plan.md`  
**Spec**: `ai/LAB-008_codespace-provider/spec.md`

---

## 1. Dockerfile

- [ ] LAB-008-T01: Install GitHub CLI in the Docker image.
  - Add `curl` and `gnupg` to the existing `apt-get` block.
  - Add the official GitHub CLI apt repository and keyring.
  - Install `gh` via apt in the same `RUN` layer.
  - Verify `gh --version` produces output during build.

---

## 2. Credential Loader

- [ ] LAB-008-T02: Create `src/services/providers/codespaces/credentials-loader.js`.
  - Copy `codesandbox/credentials-loader.js` as the structural template.
  - Change all error code prefixes from `CODESANDBOX_` to `CODESPACES_`.
  - Change the missing-credential error code to `CODESPACES_NO_CREDENTIAL`.
  - After reading the file buffer, attempt `JSON.parse`; if it throws, treat the
    entire trimmed buffer as the raw token (plain-text `.txt` support).
  - For JSON files, extract `credentialData.token`.
  - Validate that the resolved token is a non-empty string.
  - Compute fingerprint as `sha256:${sha256(token)}`.
  - Export `loadCodespacesCredentials(credentialRef)` → `{ token, credentialRef, credentialFingerprint }`.
  - Never log or return the raw token value.

---

## 3. GitHub API Client

- [ ] LAB-008-T03: Create `src/services/providers/codespaces/client.js`.
  - Use Node.js built-in `fetch` (no SDK, no new npm packages).
  - Set `BASE_URL = 'https://api.github.com'` and `API_VERSION = '2026-03-10'`.
  - Build per-call headers with `Authorization: Bearer <token>`,
    `Accept: application/vnd.github+json`, and `X-GitHub-Api-Version`.
  - Implement GET retry: on 429, retry up to 3 times with delays 1s → 2s → 4s.
    No retry on POST or DELETE.
  - Implement `createCodespace(token, params)`: `POST /user/codespaces`.
    Accept both 201 and 202 as success; parse and return the codespace body from both.
  - Implement `getCodespace(token, name)`: `GET /user/codespaces/{codespace_name}`.
  - Implement `deleteCodespace(token, name)`: `DELETE /user/codespaces/{codespace_name}`.
    Returns 202 with empty body — do not parse the response body.
    Treat 404 as already-deleted (return normally).
  - Implement `startCodespace(token, name)`: `POST /user/codespaces/{codespace_name}/start`.
    Returns 200 with codespace object; `state` will be `Starting`, not `Available`.
  - Implement `validateToken(token)`: `GET /user`.
    Returns `{ login }` on success; throws on 401/403.

---

## 4. Session Mapper

- [ ] LAB-008-T04: Create `src/services/providers/codespaces/session-mapper.js`.
  - Copy `codesandbox/session-mapper.js` as the structural template.
  - Map `codespace.name` → `providerSessionId`.
  - Map `codespace.display_name || codespace.name` → `envName`.
  - Set `sshCommand = \`gh codespace ssh -c ${codespace.name}\``.
  - Set `webHost = null` (always).
  - Map `codespace.state` through the 17-state `STATE_MAP`; unknown states default
    to `PENDING` with a `console.warn`.
  - Build `metadata` with: `githubState`, `machine` (name), `cpus`,
    `memoryGB` (from `memory_in_bytes / 1024^3`, rounded), `storageGB`
    (from `storage_in_bytes / 1024^3`, rounded), `idleTimeoutMinutes`,
    `retentionPeriodMinutes`, `location`, `webIdeUrl` (from `web_url`),
    `sshHost: null`, `lastUsedAt`.
  - Never include the raw token in metadata.
  - Export `mapToSession(codespace, credentialRef, credentialFingerprint)`.

---

## 5. CLI Executor

- [ ] LAB-008-T05: Create `src/services/providers/codespaces/cli-executor.js`.
  - Use `execFile` from `child_process` (not `exec`) for token safety.
  - Pass `GH_TOKEN` via the `env` option per spawn — never mutate `process.env.GH_TOKEN`.
  - Set `BOOT_TIMEOUT_MS = 90_000` and `COMMAND_TIMEOUT_MS = 30_000`.
  - Accept `options.timeout` to override the default timeout per call.
  - Pass `command` as a single string after `--` in the args array; the remote
    shell interprets it (pipes and redirects work as expected).
  - On `error.killed` or `SIGTERM`, reject with a `CODESPACES_COMMAND_TIMEOUT` error.
  - Resolve with `{ output: (stdout + stderr).trim() }`.
  - Export `{ executeInCodespace, BOOT_TIMEOUT_MS, COMMAND_TIMEOUT_MS }`.

---

## 6. Codespaces Provider

- [ ] LAB-008-T06: Create `src/services/providers/codespaces-provider.js` extending `BaseProvider`.
  - Copy private helpers `parseMetadata`, `parseBoolean`, `parsePositiveInteger`,
    `isNotFoundError`, `normalizeStatus` from `codesandbox-provider.js` as-is.
  - Import `getRowValue` from `utils/helpers.js`.
  - Import `loadCodespacesCredentials` from `./codespaces/credentials-loader`.
  - Import `githubClient` from `./codespaces/client`.
  - Import `mapToSession`, `mapState` from `./codespaces/session-mapper`.
  - Import `executeInCodespace`, `BOOT_TIMEOUT_MS`, `COMMAND_TIMEOUT_MS`
    from `./codespaces/cli-executor`.
  - Import `ProviderError`, `ConflictError`, `InvalidCredentialsError`
    from `../errors/provider-errors`.

- [ ] LAB-008-T07: Implement `getKeepAliveConfig(sessionRow)`.
  - Parse `metadata.keepAlive.enabled` for per-session override.
  - Precedence: per-session `keepAlive.enabled` → `CODESPACES_KEEP_ALIVE_ENABLED` env var → default `true`.
  - Return `{ enabled: false }` when disabled.
  - Compute `configuredInterval` from `CODESPACES_KEEP_ALIVE_INTERVAL_MINUTES` (default 20).
  - Compute `idleTimeout` from `metadata.idleTimeoutMinutes` or `CODESPACES_DEFAULT_IDLE_TIMEOUT_MINUTES` (default 30).
  - Set `intervalMinutes = Math.max(1, Math.min(configuredInterval, idleTimeout - 10))`.
  - Return `{ enabled: true, intervalMinutes, strategy: 'gh-cli-command', runOnStart: false }`.

- [ ] LAB-008-T08: Implement `isSessionActive(sessionRow)`.
  - Extract `providerSessionId` via `getRowValue`.
  - Extract `credentialRef` via `getRowValue` falling back to `parseMetadata(sessionRow.metadata).credentialRef`.
  - Return `false` if either is missing.
  - Load token via `loadCodespacesCredentials`.
  - Call `githubClient.getCodespace(token, providerSessionId)`.
  - Return `codespace.state !== 'Deleted'`.
  - On `isNotFoundError` → return `false`.
  - On other errors → throw (recovery service will skip, not delete).

- [ ] LAB-008-T09: Implement `createSession(options)`.
  - Validate `options.machine` against `VALID_MACHINES` set; throw 400 before any API call.
  - Validate `options.geo` against `VALID_GEOS` set; throw 400 before any API call.
  - Load credentials via `loadCodespacesCredentials(options.credentialRef)`.
  - Validate token via `githubClient.validateToken`; map 401 → `CODESPACES_TOKEN_INVALID`,
    403 → `CODESPACES_TOKEN_INSUFFICIENT_SCOPE`.
  - Query DB for existing session with same `credentialFingerprint` and non-terminal status.
  - If active session found (`RUNNING`/`STARTING`/`PENDING`/`STOPPING`) → throw
    `ConflictError` with code `CODESPACES_ALREADY_ACTIVE`.
  - If `STOPPED` session found → call `githubClient.deleteCodespace` (treat 404 as
    already-gone), then `DELETE FROM sessions WHERE id = ?`. Both must succeed before continuing.
  - Build create params: `repository_id` from `CODESPACES_DEFAULT_REPOSITORY_ID`,
    `ref: 'main'`, `machine`, `geo`, `idle_timeout_minutes`, `display_name`,
    `retention_period_minutes` from `CODESPACES_DEFAULT_RETENTION_PERIOD_MINUTES`.
    Apply `CODESPACES_DEFAULT_MACHINE` and `CODESPACES_DEFAULT_GEO` for omitted fields.
  - Call `githubClient.createCodespace`; on error throw `CODESPACES_CREATION_FAILED`.
  - Check `CODESPACES_DEFAULT_REPOSITORY_ID` is set; throw `CODESPACES_REPOSITORY_NOT_CONFIGURED` if missing.
  - Call `mapToSession(codespace, credentialRef, credentialFingerprint)`.
  - Build `keepAliveConfig` from `getKeepAliveConfig` using a synthetic row with the
    session's `idleTimeoutMinutes`; inject into `session.metadata.keepAlive`.
  - Return the session object.

- [ ] LAB-008-T10: Implement `refreshSession(sessionRow)`.
  - Extract `providerSessionId` via `getRowValue`.
  - Extract `credentialRef` via `getRowValue`; load token via `loadCodespacesCredentials`.
  - Call `githubClient.getCodespace(token, providerSessionId)`.
  - Return `{ status: mapState(codespace.state), webHost: null, sshCommand, metadata }`.
  - Merge `githubState` and `lastUsedAt` into existing metadata; preserve other fields.

- [ ] LAB-008-T11: Implement `executeCommand(sessionRow, command)`.
  - Normalize `sessionRow.status`.
  - If `FAILED` or `TERMINATED` → throw `ProviderError` with 409, do not load credentials.
  - Extract `providerSessionId` via `getRowValue` and `credentialRef` via `getRowValue`;
    load token via `loadCodespacesCredentials`.
  - If `STOPPED` → call `githubClient.startCodespace(token, providerSessionId)`;
    poll `githubClient.getCodespace` every 3 seconds until `state === 'Available'`
    or `BOOT_TIMEOUT_MS` exceeded → throw `CODESPACES_START_TIMEOUT`.
  - Call `executeInCodespace(providerSessionId, command, token, { timeout: COMMAND_TIMEOUT_MS })`.
  - Return `{ output: result.output }` (no `updates` key needed).

- [ ] LAB-008-T12: Implement `executeKeepAlive(sessionRow)`.
  - Normalize status; if `STOPPED`/`STOPPING`/`TERMINATED`/`FAILED` → return
    `{ success: true, action: 'skipped', message: ..., updates: {} }`.
    Must be `success: true` — returning `false` counts as a failure and will mark
    the session `FAILED` after 3 intervals.
  - Extract `providerSessionId` and `credentialRef` via `getRowValue`.
  - If either is missing → return `{ success: false, action: 'missing-session-data', ... }`.
  - Load token; call `executeInCodespace(providerSessionId, 'echo keep-alive', token, { timeout: BOOT_TIMEOUT_MS })`.
  - Return `{ success: true, action: 'keep-alive-sent', message: result.output, updates: { status: 'RUNNING' } }`.

- [ ] LAB-008-T13: Implement `terminateSession(sessionRow)`.
  - Extract `providerSessionId` via `getRowValue`; load token via `loadCodespacesCredentials`.
  - Call `githubClient.deleteCodespace(token, providerSessionId)`.
  - If 404 → log "already gone", return normally.
  - On other errors → throw (route will preserve the DB row).
  - Do not update the DB row here — the route handles `UPDATE SET status = 'TERMINATED'`.

---

## 7. Provider Registration

- [ ] LAB-008-T14: Register `codespaces` in `src/services/provider-factory.js`.
  - Import `CodespacesProvider` from `./providers/codespaces-provider`.
  - Add `codespaces: new CodespacesProvider()` to the `providers` object.
  - Confirm `GET /api/v1/sessions/providers/supported` includes `codespaces`
    (existing filter already excludes `pwd` only).

---

## 8. Credentials Lister

- [ ] LAB-008-T15: Update `src/services/credentials-lister.js` to support `.txt` files.
  - In `listCredentialsS3`: change `.filter((key) => key.toLowerCase().endsWith('.json'))`
    to also accept `.endsWith('.txt')`.
  - In `listCredentialsFs`: change the `entry.name.toLowerCase().endsWith('.json')` check
    to also accept `.endsWith('.txt')`. Note: this filter uses `entry.name` (dirent), not `key`.

---

## 9. Database

- [ ] LAB-008-T16: Add Codespaces unique index in `src/db/db.js`.
  - After the existing `idx_sessions_codesandbox_active_token` creation block,
    add an equivalent duplicate-check and `CREATE UNIQUE INDEX IF NOT EXISTS`
    for `idx_sessions_codespaces_active_token`.
  - Index condition: `provider = 'codespaces' AND credentialFingerprint IS NOT NULL
    AND COALESCE(status, '') NOT IN ('TERMINATED', 'FAILED')`.
  - `STOPPED` sessions are intentionally covered — the application layer handles
    delete-and-recreate for this case.

---

## 10. Routes

- [ ] LAB-008-T17: Add credential extraction helpers in `src/routes/sessions.js`.
  - Add `getCodespacesCredentialRef(req)` returning `x-codespaces-credentials` header
    or `req.body?.credentialRef`.
  - Add `requireCodespacesCredentialRef(req)` throwing `CODESPACES_NO_CREDENTIAL` (401) if missing.
  - In `POST /` handler, add `else if (providerName === 'codespaces')` branch calling
    `requireCodespacesCredentialRef`.

- [ ] LAB-008-T18: Add `GET /codespaces-credentials` route.
  - Add after the existing `codesandbox-credentials` route.
  - Calls `listAvailableCredentials('codespaces')` and returns the result.
  - Requires server token (inherited from global middleware).

- [ ] LAB-008-T19: Add `?provider=` filter to `GET /` route.
  - Destructure `provider` from `req.query` alongside existing `status`.
  - Add `provider = ?` condition when present.
  - Existing `?status=` filter is preserved unchanged.

- [ ] LAB-008-T20: Add per-provider branching to `DELETE /:id`.
  - After `provider.terminateSession(row)` succeeds:
    - `codespaces` → `UPDATE sessions SET status = 'TERMINATED' WHERE id = ?`
    - all others → `DELETE FROM sessions WHERE id = ?` (existing behavior)
  - Existing CodeSandbox error-on-fail behavior (skip DELETE when terminateSession throws) is unchanged.

- [ ] LAB-008-T21: Add per-provider branching to `POST /terminate-all`.
  - Inside the loop, after `provider.terminateSession(row)` succeeds:
    - `codespaces` → `UPDATE sessions SET status = 'TERMINATED' WHERE id = ?`; set `result.deleted = true`
    - all others → `DELETE FROM sessions WHERE id = ?`; set `result.deleted = true` (existing behavior)

---

## 11. Keep-Alive Service

- [ ] LAB-008-T22: Add `STOPPED` status pre-check to `recoverKeepAlivesOnStartup` in `src/services/keep-alive-service.js`.
  - Before the `isSessionActive` call, check if `normalizeStatus(sessionRow.status) === 'STOPPED'`.
  - If so, increment `summary.skipped` and `continue` — do not call `isSessionActive`,
    do not delete the row, do not start a keep-alive timer.
  - All other logic is unchanged.

---

## 12. Tests

- [ ] LAB-008-T23: Add unit tests for the credentials loader.
  - Valid JSON file: loads token and fingerprint.
  - Valid plain-text `.txt` file: loads token and fingerprint.
  - Missing file: returns `CODESPACES_NO_CREDENTIAL`.
  - Malformed JSON with non-token text: treated as plain-text token.
  - Empty file: returns `CODESPACES_NO_CREDENTIAL`.
  - Path traversal: rejected.

- [ ] LAB-008-T24: Add unit tests for the session mapper.
  - All 17 GitHub states map to the correct orchestrator status.
  - Unknown state defaults to `PENDING` and logs a warning.
  - `webHost` is always `null`.
  - `webIdeUrl` is populated from `web_url`.
  - `memoryGB` and `storageGB` are correctly converted from bytes.

- [ ] LAB-008-T25: Add unit tests for `getKeepAliveConfig`.
  - Keep-alive disabled per-session override wins over env var default.
  - Effective interval is `min(configured, idleTimeout - 10)`.
  - Effective interval is floored at 1 when `idleTimeout - 10 <= 0`.
  - `runOnStart` is always `false`.

- [ ] LAB-008-T26: Add unit tests for `executeKeepAlive`.
  - Returns `success: true` (not false) for `STOPPED`, `STOPPING`, `TERMINATED`, `FAILED`.
  - Returns `success: false` for missing `providerSessionId` or `credentialRef`.

- [ ] LAB-008-T27: Add route-level tests for delete and terminate-all branching.
  - `DELETE /:id` on a `codespaces` session: calls `terminateSession`, then `UPDATE` (not `DELETE`).
  - `DELETE /:id` on a non-codespaces session: existing hard-delete behavior unchanged.
  - `POST /terminate-all` with a mix of `codespaces` and `gcs` sessions: codespaces rows are updated, gcs rows are deleted.

- [ ] LAB-008-T28: Add unit test for `STOPPED` pre-check in keep-alive recovery.
  - Session with `status = 'STOPPED'` is skipped without calling `isSessionActive`.
  - Session with `status = 'RUNNING'` proceeds to `isSessionActive` as before.

---

## 13. Documentation

- [ ] LAB-008-T29: Update `README.md`.
  - Add `codespaces` to the supported providers list.
  - Document GitHub PAT creation and required `codespace` scope.
  - Add `x-codespaces-credentials` header example to the API section.
  - Document credential file formats (JSON and plain text).
  - Document credential storage location (`codespaces/` folder).
  - Add example `curl` commands for create, command, and list credentials.

- [ ] LAB-008-T30: Update `.env.example`.
  - Add all `CODESPACES_*` environment variables with defaults:
    `CODESPACES_DEFAULT_REPOSITORY_ID`, `CODESPACES_DEFAULT_MACHINE`,
    `CODESPACES_DEFAULT_GEO`, `CODESPACES_DEFAULT_IDLE_TIMEOUT_MINUTES`,
    `CODESPACES_DEFAULT_RETENTION_PERIOD_MINUTES`,
    `CODESPACES_KEEP_ALIVE_ENABLED`, `CODESPACES_KEEP_ALIVE_INTERVAL_MINUTES`.

- [ ] LAB-008-T31: Update `tests/api-tests.http`.
  - Add Codespaces create request with `x-codespaces-credentials` header.
  - Add `GET /api/v1/sessions/codespaces-credentials`.
  - Add command execution request for a Codespaces session.
  - Add `DELETE` request for a Codespaces session.
  - Add `GET /api/v1/sessions?provider=codespaces` filter example.

---

## 14. Definition of Done

- [ ] `codespaces` appears in `GET /api/v1/sessions/providers/supported`.
- [ ] Session create with `{"provider": "codespaces"}` provisions a real GitHub Codespace.
- [ ] Command execution runs `docker ps` successfully in the codespace.
- [ ] Keep-alive fires at configured interval and prevents idle shutdown.
- [ ] `STOPPED` sessions are preserved across server restart (not deleted by recovery).
- [ ] `DELETE /:id` transitions codespaces row to `TERMINATED`, not hard-deleted.
- [ ] Active duplicate token returns `409 CODESPACES_ALREADY_ACTIVE`.
- [ ] `STOPPED` duplicate token deletes remote + DB row and creates fresh session.
- [ ] Raw token never appears in logs, API responses, or DB.
- [ ] `GH_TOKEN` never set on global `process.env` — per-spawn isolation only.
- [ ] All existing GCS and CodeSandbox behavior preserved (existing tests pass).
- [ ] `GET /api/v1/sessions/codespaces-credentials` lists available credential files.
- [ ] `README.md` and `.env.example` updated.
