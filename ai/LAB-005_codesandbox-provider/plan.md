# Plan: LAB-005 - Add CodeSandbox Provider

## 1. Technical Context

Current project shape:
- Provider abstraction lives under `src/services/providers/`.
- Provider registration lives in `src/services/provider-factory.js`.
- Session API routes live in `src/routes/sessions.js`.
- Session records are stored in PostgreSQL through `src/db/db.js`.
- `src/routes/sessions.js` currently passes only `req.body` into `provider.createSession(...)`; it does not pass request headers to providers.
- `src/routes/sessions.js` currently inserts only `id`, `provider`, `providerSessionId`, `envName`, `status`, and `metadata`, with `envName` always set to `created.providerSessionId`.
- `src/routes/sessions.js` currently returns only `{ output: result.output }` for command execution, dropping provider-specific fields.
- `src/server.js` applies `setGoogleCredentials` to every `/api/v1/sessions` route, so CodeSandbox requests and provider discovery currently still require Google credential configuration.
- `sessions.metadata` is stored as text, not JSONB, so reliable indexed lookup by metadata fields is awkward.
- PostgreSQL returns unquoted camelCase columns as lowercase property names through `pg` (for example `providerSessionId` is read as `providersessionid` in current provider code).
- `package.json` currently has no real automated test runner; `npm test` exits with an error placeholder.
- Current implemented provider is `gcs`.
- `pwd` remains a deprecated stub.

CodeSandbox integration target:
- Use `@codesandbox/sdk`.
- Use CodeSandbox sandbox creation for session creation.
- Create Docker sandboxes only by using the CodeSandbox Docker template.
- Use SDK command execution instead of SSH.
- Use SDK resume/connect behavior before command execution when needed.
- Use SDK delete for session termination.
- Load CodeSandbox tokens from JSON credential files, following the same S3/server-directory pattern used by Google credentials.
- Enforce one CodeSandbox sandbox/session per token to avoid overloading free or low-capacity accounts.

Live SDK smoke-test result:
- `new CodeSandbox(token)` is the verified constructor shape for the installed SDK version.
- `new CodeSandbox({ apiKey: token })` failed with `TypeError: token.startsWith is not a function`.
- `sandbox.connect()` followed by `client.commands.run("echo codesandbox-api-ok && pwd")` returned command output successfully.
- The temporary sandbox exposed `id`, `cluster`, `bootupType`, and `isUpToDate`.
- `sdk.sandboxes.delete(sandbox.id)` deleted the temporary sandbox successfully.

Reference docs:
- SDK quickstart and API key setup: https://codesandbox.io/docs/sdk
- Sandbox creation: https://codesandbox.io/docs/sdk/create
- Commands: https://codesandbox.io/docs/sdk/commands
- Resume: https://codesandbox.io/docs/sdk/resume
- Delete: https://codesandbox.io/docs/sdk/delete
- Lifecycle management: https://codesandbox.io/docs/sdk/manage-sandboxes
- VM specs: https://codesandbox.io/docs/sdk/specs
- Pricing and plan limits: https://codesandbox.io/docs/sdk/pricing

## 2. Implementation Steps

### Step 1: Add Dependency

Add the CodeSandbox SDK:

```bash
npm install @codesandbox/sdk
```

This updates:
- `package.json`
- `package-lock.json`

Pin the installed version and avoid broad version assumptions in provider code.

### Step 2: Add Provider Folder

Create:

```text
src/services/providers/codesandbox/
```

Initial helper files:

```text
src/services/providers/codesandbox/client.js
src/services/providers/codesandbox/credentials-loader.js
src/services/providers/codesandbox/session-mapper.js
```

Rationale:
- Keep SDK client creation and response mapping separate from provider lifecycle methods.
- Make SDK behavior mockable for tests.

### Step 3: Add Provider Implementation

Create:

```text
src/services/providers/codesandbox-provider.js
```

The provider should extend `BaseProvider` and implement:
- `createSession(options)`
- `refreshSession(sessionRow)`
- `executeCommand(sessionRow, command)`
- `terminateSession(sessionRow)`
- `getKeepAliveConfig()`
- `executeKeepAlive(sessionRow)`
- `isSessionActive(sessionRow)`

Initial keep-alive config:

```js
getKeepAliveConfig() {
  return {
    enabled: false,
    intervalMinutes: null,
    strategy: 'provider-managed-hibernation'
  };
}
```

Reasoning:
- Current keep-alive is SSH-oriented.
- CodeSandbox supports provider-managed hibernation/resume.
- Command execution can resume the sandbox when needed.

### Step 4: SDK Client Helper

Implement `src/services/providers/codesandbox/client.js`.

Requirements:
- Import `CodeSandbox` from `@codesandbox/sdk`.
- Accept a token loaded from the selected CodeSandbox credential JSON file.
- Keep `process.env.CSB_API_KEY` and `process.env.CODESANDBOX_API_KEY` only as local smoke-test/development fallbacks if desired; provider runtime should prefer credential files.
- Validate the token during provider operation, not at module load.
- Export a factory or lazy singleton so tests can replace/mock the SDK.
- Instantiate the SDK with the token string:

  ```js
  const sdk = new CodeSandbox(token);
  ```

- Do not instantiate the SDK with `{ apiKey: token }`; that shape failed against the tested SDK version.

Configuration errors should be translated into provider-safe errors, not raw thrown SDK or environment errors.

### Step 5: CodeSandbox Credentials Loader

Create:

```text
src/services/providers/codesandbox/credentials-loader.js
```

Credential file format:

```json
{
  "token": "xxxxx"
}
```

Inputs:
- Request header: `x-codesandbox-credentials`
- Default env var: `CODESANDBOX_DEFAULT_CREDENTIALS`
- S3 mode setting: reuse `S3FS_ENABLED`
- S3 bucket/env config: reuse `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, and AWS credential env vars
- Filesystem fallback directory: `CODESANDBOX_CREDENTIALS_DIR`, falling back to `S3_MOUNT_DIR` when `S3FS_ENABLED=1`

Resolution rules:
1. If request header `x-codesandbox-credentials` is present, use that credential reference.
2. Otherwise use `CODESANDBOX_DEFAULT_CREDENTIALS`.
3. If the reference starts with `s3://`, parse bucket/key from the reference.
4. If `S3FS_ENABLED=0`, treat non-`s3://` references as S3 object keys under `S3_BUCKET`.
5. If `S3FS_ENABLED=1`, treat non-`s3://` references as filesystem paths. Relative paths resolve under `CODESANDBOX_CREDENTIALS_DIR` or `S3_MOUNT_DIR`.
6. Read and parse the JSON file.
7. Validate that `token` is a non-empty string.
8. Return `{ token, credentialRef, credentialFingerprint }`.

Security rules:
- Never log or return the raw token.
- Do not persist the raw token in `sessions.metadata`.
- Store a stable token fingerprint for one sandbox/session per token enforcement.
- Use a cryptographic hash such as SHA-256 over the token for `credentialFingerprint`.
- Reject filesystem references that resolve outside the configured credentials directory.
- Provider errors may include full S3 bucket/key or filesystem paths to make operator troubleshooting direct.

Implementation notes:
- Reuse helper logic from `src/services/google-credentials-loader.js` where practical.
- Reuse `buildS3Client()` and `streamToBuffer()` patterns, or extract shared S3 credential-object loading helpers if implementation duplication becomes meaningful.
- Cache downloaded credential files in `/tmp` only if the cache key is the credential reference and file permissions are restrictive.

### Step 6: One Sandbox/Session Per Token Enforcement

Before creating a CodeSandbox sandbox:
1. Load the selected credential JSON.
2. Compute `credentialFingerprint`.
3. Query existing `sessions` rows for provider `codesandbox` with non-terminal status and matching `credentialFingerprint`.
4. If a matching non-terminal session row exists, return that existing session instead of creating another CodeSandbox sandbox.
5. Include a response flag or equivalent response field so clients can tell the existing sandbox/session was reused.

Initial non-terminal statuses:
- `STARTING`
- `RUNNING`
- `ACTIVE`
- `SUSPENDED`
- Unknown/null statuses should be treated as active to avoid accidental over-provisioning.

Terminal statuses:
- `TERMINATED`
- `DELETED`
- `FAILED`

Concurrency requirement:
- The check and insert should be made race-safe.
- Preferred approach: add a database-level unique guard for active CodeSandbox credential fingerprints if the current schema can support it cleanly.
- If a DB unique guard is not added in the initial implementation, create a short-lived in-process lock keyed by `credentialFingerprint` and document the limitation for multi-process deployments.

Recommended database direction:
- Add nullable top-level columns to `sessions`:
  - `credentialRef TEXT`
  - `credentialFingerprint TEXT`
- Keep `credentialRef` and `credentialFingerprint` duplicated in `metadata` only for provider diagnostics.
- Add these columns through the existing lightweight startup schema bootstrap in `src/db/db.js`.
- Because existing schema code uses unquoted identifiers, either:
  - use lowercase SQL column names (`credentialref`, `credentialfingerprint`) and normalize them in code, or
  - quote identifiers consistently everywhere.
- Preferred local style: keep unquoted SQL identifiers and add provider helpers that read both camelCase and lowercase row properties.
- Add a PostgreSQL partial unique index for active CodeSandbox sessions:

  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_codesandbox_active_token
  ON sessions (credentialFingerprint)
  WHERE provider = 'codesandbox'
    AND credentialFingerprint IS NOT NULL
    AND COALESCE(status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED');
  ```

- This index is the preferred enforcement mechanism because the app can run in more than one process.
- Also keep an in-process lock keyed by `credentialFingerprint` to avoid double provider calls inside one process before the insert reaches the database.
- If the insert fails on the unique index, attempt best-effort deletion of the newly created CodeSandbox sandbox and return the existing session for that token.
- Add an `ensureIndex` or direct startup `CREATE INDEX IF NOT EXISTS` call in `src/db/db.js`; the current bootstrap has `ensureColumn` only.

### Step 7: Session Mapper

Implement `src/services/providers/codesandbox/session-mapper.js`.

Map SDK sandbox objects into the app's existing session model:

```json
{
  "provider": "codesandbox",
  "providerSessionId": "sandbox-id",
  "envName": "sandbox-id-or-title",
  "sshCommand": null,
  "webHost": null,
  "status": "RUNNING",
  "metadata": {
    "sandboxId": "sandbox-id",
    "title": "my-sandbox",
    "credentialRef": "codesandbox/account-a.json",
    "credentialFingerprint": "sha256:...",
    "cluster": "...",
    "bootupType": "FORK",
    "isUpToDate": true,
    "privacy": "public-hosts",
    "vmTier": "Nano"
  }
}
```

Rules:
- Do not assume every SDK field exists.
- Store provider-specific values in `metadata`.
- Keep normalized top-level fields compatible with GCS session rows.
- Do not set `sshCommand` unless CodeSandbox exposes a supported SSH path later.
- Persist `bootupType` because CodeSandbox resume can be `FORK`, `RESUME`, or `CLEAN`, and clean boots may require setup handling.
- Persist credential reference and fingerprint, but never the raw token.

### Step 8: Provider Creation Behavior

Support request options:
- `title`
- `description`
- `tags`
- `privacy`
- `path`
- `vmTier`
- `hibernationTimeoutSeconds`
- `automaticWakeupConfig`

Environment defaults:

```env
CODESANDBOX_DEFAULT_PRIVACY=public-hosts
CODESANDBOX_DEFAULT_VM_TIER=Nano
CODESANDBOX_HIBERNATION_TIMEOUT_SECONDS=86400
CODESANDBOX_AUTOMATIC_WAKEUP=false
```

Request values override environment defaults.

Template policy:
- The provider must always create Docker sandboxes.
- SDK create options must set `id: "docker"`.
- `CODESANDBOX_TEMPLATE_ID` is not supported because arbitrary templates are outside this story.
- If legacy clients send `templateId`, only `docker` is accepted; any other value should return a clear 400 provider error before calling CodeSandbox.

Creation flow:
1. Resolve the CodeSandbox credential reference from `x-codesandbox-credentials` or `CODESANDBOX_DEFAULT_CREDENTIALS`.
2. Load and validate the credential JSON.
3. Compute token fingerprint.
4. Look up an existing session for the token before calling CodeSandbox.
   - If one exists, return the existing session and do not call CodeSandbox create.
5. Build SDK create options.
6. Set SDK option `id` to `docker` and reject non-Docker template requests.
7. Map string VM tier names to SDK `VMTier` constants.
8. Instantiate SDK with `new CodeSandbox(token)`.
9. Use `sdk.sandboxes.create(...)`.
10. Optionally connect to prove readiness if the route should only return usable sessions.
11. Dispose the connected client after readiness checks when supported.
12. Map SDK sandbox to normalized provider session shape, including `credentialRef` and `credentialFingerprint` metadata.
13. Return normalized session data to the existing route layer.

Route integration required:
- Update `src/routes/sessions.js` so provider creation receives request-derived context:

  ```js
  const created = await provider.createSession({
    ...(req.body || {}),
    credentialRef: req.headers['x-codesandbox-credentials']
  });
  ```

- The route insert must persist provider-returned `webHost`, `sshCommand`, `metadata`, `credentialRef`, and `credentialFingerprint` when present.
- The route insert should use `created.envName || created.providerSessionId` instead of always storing `created.providerSessionId` in `envName`.
- If the DB unique index rejects the insert after a CodeSandbox sandbox was created, the route or provider must delete that sandbox best-effort before returning the existing session.
- Cleanup after failed insert can call `provider.terminateSession(...)` with a constructed temporary row containing `providerSessionId`, `credentialRef`, `credentialFingerprint`, and `metadata`.

Verified creation:
- The initial smoke test proved default sandbox creation works, but the product requirement now restricts the provider to Docker sandboxes only.
- Creation should call `sdk.sandboxes.create({ id: "docker", ... })`.

Lifecycle default:
- Prefer `hibernationTimeoutSeconds=86400` and `automaticWakeupConfig=false` when the orchestrator actively deletes sessions on termination.
- A lower timeout may be configured by operators when cost control is more important than preserving active session state.

### Step 9: Command Execution Behavior

Use CodeSandbox SDK Commands API.

Flow:
1. Read CodeSandbox sandbox ID from `sessionRow.providerSessionId`.
2. Resolve the credential reference/fingerprint from `sessionRow.credentialRef` and `sessionRow.credentialFingerprint`, falling back to metadata only for older rows.
3. Load the CodeSandbox token from the same credential reference.
4. Instantiate SDK with `new CodeSandbox(token)`.
5. Resume sandbox if needed with `sdk.sandboxes.resume(id)`.
6. Connect to the sandbox.
7. Run command through `client.commands.run(command)`.
8. Dispose/close SDK client when supported by the SDK.
9. Return normalized command result:

```json
{
  "provider": "codesandbox",
  "sandboxId": "sandbox-id",
  "output": "command output"
}
```

The tested SDK returned command output as a string. Do not expose or require `exitCode` unless implementation verifies a stable exit-code field from the SDK return value.

Route response decision:
- Current route returns only `{ output: result.output }`.
- For minimal compatibility, CodeSandbox can return command output through the existing shape.
- If provider-specific fields like `provider` or `sandboxId` are desired in API responses, update `src/routes/sessions.js` to include safe extra result fields without breaking GCS.

If `sandbox.bootupType === "CLEAN"` after resume, evaluate whether project setup must complete before running the requested command. Initial implementation may return a clear `409` not-ready provider error if a clean boot cannot be prepared safely.

### Step 10: Refresh Behavior

Refresh flow:
1. Resolve the credential reference/fingerprint from `sessionRow.credentialRef` and `sessionRow.credentialFingerprint`, falling back to metadata only for older rows.
2. Load the CodeSandbox token from the same credential reference.
3. Instantiate SDK with `new CodeSandbox(token)`.
4. Prefer a non-waking SDK lookup if one exists in the pinned SDK version.
5. Do not wake/resume CodeSandbox from `GET /api/v1/sessions/:id` unless the product explicitly accepts that cost.
6. If no non-waking lookup exists, return persisted state plus metadata and defer resume to command execution.
7. Map current SDK sandbox data into normalized fields when available.
8. Return status and metadata for route/database update.

If CodeSandbox reports the sandbox no longer exists, translate to a provider `not found` style error.

### Step 11: Termination Behavior

Termination flow:
1. Read sandbox ID from `providerSessionId`.
2. Resolve the credential reference/fingerprint from `sessionRow.credentialRef` and `sessionRow.credentialFingerprint`, falling back to metadata only for older rows.
3. Load the CodeSandbox token from the same credential reference.
4. Instantiate SDK with `new CodeSandbox(token)`.
5. Call `sdk.sandboxes.delete(sandboxId)`.
6. Return success if provider cleanup succeeds.
7. If delete fails, preserve current route best-effort semantics and return/log a sanitized warning.

Design decision:
- Initial terminate means delete, not hibernate.
- Add a future story for explicit hibernate/resume endpoints if state preservation is required.

### Step 12: Register Provider

Modify:

```text
src/services/provider-factory.js
```

Add:

```js
const CodeSandboxProvider = require('./providers/codesandbox-provider');
```

Register:

```js
codesandbox: new CodeSandboxProvider()
```

Verify:
- `listProviders()` returns `codesandbox`.
- Default provider remains `gcs`.

### Step 13: Middleware and Route Access

Current issue:
- `src/server.js` mounts all session routes with:

  ```js
  app.use('/api/v1/sessions', requireServerToken, setGoogleCredentials, sessionRoutes);
  ```

- `setGoogleCredentials` returns `500` when `GOOGLE_APPLICATION_DEFAULT_CREDENTIALS` is missing.
- That means CodeSandbox-only environments cannot call provider discovery, create CodeSandbox sessions, or run CodeSandbox commands unless Google is also configured.

Required change:
- Keep `requireServerToken` on all session routes.
- Move Google credential initialization out of global session middleware and into GCS-only flows.
- Preferred implementation: remove `setGoogleCredentials` from `server.js` route mounting and call a provider-aware credential initializer inside `routes/sessions.js` only when:
  - requested provider is `gcs` for create, or
  - persisted session provider is `gcs` for refresh/command/terminate.
- Preserve `x-google-credentials` support for GCS.
- Do not require Google credentials for:
  - `GET /api/v1/sessions/providers/supported`
  - `GET /api/v1/sessions`
  - CodeSandbox create/refresh/command/terminate
  - future CodeSandbox credentials listing, if added.

Route behavior notes:
- `GET /api/v1/sessions/google-credentials` still requires Google/S3 configuration because its purpose is Google credential discovery.
- If a future CodeSandbox credential discovery endpoint is added, it should use CodeSandbox credential env vars and must not depend on Google env vars.

### Step 14: Error Handling

Update or extend:

```text
src/services/errors/provider-errors.js
```

Needed provider-safe error codes:
- `CODESANDBOX_CREDENTIALS_MISSING`
- `CODESANDBOX_CREDENTIALS_INVALID`
- `CODESANDBOX_TOKEN_MISSING`
- `CODESANDBOX_TOKEN_IN_USE`
- `CODESANDBOX_CREDENTIALS_PATH_INVALID`
- `CODESANDBOX_CREATE_FAILED`
- `CODESANDBOX_NOT_FOUND`
- `CODESANDBOX_COMMAND_FAILED`
- `CODESANDBOX_DELETE_FAILED`

Expected mapping:

| Scenario | Status |
|---|---:|
| Missing credential reference | `500` |
| Missing credential file | `503` |
| Malformed credential JSON | `500` |
| Credential JSON missing `token` | `500` |
| Credential path escapes allowed directory | `400` |
| Active session already exists for token | `200` with existing session data |
| Create failed | `502` |
| Remote sandbox not found | `404` |
| Command failed | `502` |
| Delete failed | Route best-effort behavior plus warning |

Never include API keys, raw credential values, or full SDK request internals in API responses.

### Step 15: Documentation Updates

Update:

```text
README.md
ai/project-overview.md
```

Document:
- `codesandbox` provider.
- CodeSandbox credential JSON format.
- Default credential env var.
- Request header for credential selection.
- Optional provider defaults.
- One CodeSandbox sandbox/session per token behavior.
- CodeSandbox is account/plan/usage-limit dependent.
- Commands use provider SDK, not SSH.
- Termination deletes the sandbox in the initial implementation.

### Step 16: Tests

Unit test targets:
- Provider factory registration.
- Missing credential reference validation.
- Missing credential file handling.
- Malformed JSON handling.
- Missing `token` field handling.
- Token fingerprint calculation without exposing token.
- One sandbox/session per token reuse behavior.
- Filesystem credential path traversal rejection.
- Request options and env defaults mapping.
- SDK constructor receives the token string, not `{ apiKey: token }`.
- Session mapper with partial SDK data.
- Command execution calls resume/connect/run.
- Command execution disposes connected clients when supported.
- Termination calls delete.
- Provider-aware middleware behavior: CodeSandbox routes do not require Google credentials; GCS still supports `x-google-credentials`.

Integration test targets with mocked SDK:
- Create session with `provider: "codesandbox"`.
- Create session with `x-codesandbox-credentials`.
- Reuse duplicate session using the same token.
- Unique-index conflict after provider create triggers best-effort sandbox cleanup and returns the existing session.
- List supported providers includes `codesandbox`.
- Get session refreshes CodeSandbox metadata.
- Get session does not wake/resume CodeSandbox when no non-waking status lookup is available.
- Run command returns normalized output.
- Delete session invokes provider cleanup.
- GCS behavior remains unchanged.
- `pwd` remains registered and unimplemented.

Test harness note:
- The repo currently has no automated test framework configured.
- Either add a small test runner as part of implementation, or treat the checked-in `.http` collection plus focused provider unit tests as the initial validation path.

Manual smoke test:

```bash
curl -X POST http://localhost:3000/api/v1/sessions \
  -H "Content-Type: application/json" \
  -H "x-server-token: $SERVER_TOKEN" \
  -H "x-codesandbox-credentials: codesandbox/account-a.json" \
  -d '{"provider":"codesandbox","title":"lab-smoke-test"}'
```

```bash
curl -X POST http://localhost:3000/api/v1/sessions/<SESSION_ID>/command \
  -H "Content-Type: application/json" \
  -H "x-server-token: $SERVER_TOKEN" \
  -d '{"command":"pwd && node --version"}'
```

```bash
curl -X DELETE http://localhost:3000/api/v1/sessions/<SESSION_ID> \
  -H "x-server-token: $SERVER_TOKEN"
```

## 3. Environment Variables

Required:

```env
CODESANDBOX_DEFAULT_CREDENTIALS=codesandbox/account-a.json
```

Credential file content:

```json
{
  "token": "xxxxx"
}
```

Optional:

```env
CODESANDBOX_CREDENTIALS_DIR=/mnt/s3/codesandbox
CODESANDBOX_DEFAULT_PRIVACY=public-hosts
CODESANDBOX_DEFAULT_VM_TIER=Nano
CODESANDBOX_HIBERNATION_TIMEOUT_SECONDS=86400
CODESANDBOX_AUTOMATIC_WAKEUP=false
```

Local smoke-test fallback only:

```env
CSB_API_KEY=...
CODESANDBOX_API_KEY=...
```

Runtime credential selection:

```http
X-CodeSandbox-Credentials: codesandbox/account-a.json
```

Column naming note:
- The plan uses camelCase names for readability.
- Implementation must account for PostgreSQL/`pg` lowercasing unquoted identifiers, as existing GCS code already does with `providersessionid` and `envname`.

## 4. Implementation Order

1. Install `@codesandbox/sdk`.
2. Add SDK client helper.
3. Add CodeSandbox credentials loader.
4. Add token fingerprint helper.
5. Add one sandbox/session per token enforcement.
6. Add `credentialRef` and `credentialFingerprint` session columns plus sandbox/session-per-token unique index.
7. Refactor global Google credential middleware into provider-aware route handling.
8. Update session route creation to pass `x-codesandbox-credentials` into provider context and persist credential fields.
9. Add session mapper.
10. Add provider implementation.
11. Register provider in provider factory.
12. Add provider-specific errors.
13. Add/update tests or test harness.
14. Update README and project overview.
15. Run automated checks if a test harness exists.
16. Run manual smoke test with a real CodeSandbox credential JSON file when available.

## 5. Verified Smoke Test

The local script `scripts/test-codesandbox-api.sh` successfully validated the official SDK flow with a real token from `.env`.

Observed sanitized result:

```json
{
  "ok": true,
  "sandbox": {
    "id": "6y6p73",
    "title": "api-token-smoke-test",
    "cluster": "fc-us-4",
    "bootupType": "FORK",
    "isUpToDate": true
  },
  "commandOutput": "codesandbox-api-ok\r\n/project/workspace\r\n",
  "deleted": true
}
```

Implementation consequences:
- Use `new CodeSandbox(token)`.
- Use `sandbox.connect()` before command execution.
- Treat command output as the stable response field.
- Dispose connected clients when possible.
- Delete works for ephemeral session termination.
- Production provider should load `token` from the selected credential JSON file instead of requiring the token directly in process env.

## 6. Open Questions

1. Should termination delete CodeSandbox sandboxes permanently, or should clients be able to choose hibernate instead?
2. Should the API expose CodeSandbox preview hosts in the normalized session response?
3. Should CodeSandbox credential files be listed through a new discovery endpoint similar to Google credentials?
