# LAB-014 Implementation Plan: Codespaces RPC Endpoint

## Goal

Implement the dedicated action-routed RPC endpoint `POST /api/v1/codespaces/rpc/:action` (with `:action = ensure` in LAB-014) that checks GitHub via `gh` CLI for existing Codespaces under a registered database VPS credential (e.g., `etecnologysys1alwaysdata`) and creates one (`vm-manager235-1/test` by default) if none exists.

Leave `POST /api/v1/sessions` completely untouched to handle existing Codespace startup/adoption and Docker/PaaS container provisioning.

## Existing Code to Reuse

- `src/services/provider-factory.js`: Resolves the `CodespacesProvider` instance; the RPC route delegates to provider methods without invoking the CLI directly.
- `src/services/db-credentials-loader.js`: `loadCredentialByRef('codespaces', name)` queries the `vps` table by `(provider, name)`, validates stored JSON token data, and returns `{ token, credentialRef, credentialFingerprint }`.
- `src/services/providers/codespaces/cli-executor.js`: Child process execution via `execFile('gh', ...)` with per-spawn `GH_TOKEN` environment, bounded timeouts, token redaction, and `classifyGhStderrError`.
- `src/services/providers/codespaces/client.js`: REST helpers `getCodespace(..., { nocache: true })`, `deleteCodespace`, and read-cache invalidation `invalidateCodespace`.
- `src/services/providers/codespaces/session-mapper.js`: `mapState` to normalize GitHub state strings to orchestrator VM states.
- `src/services/providers/codespaces-provider.js`: Parameter validators `validateMachine` and `validateGeo`, token redaction helpers, and provider error structures.
- `src/services/providers/codespaces/credentials-loader.js`: Already incorporates DB-first resolution via `loadCredentialByRef('codespaces', ref)`, allowing subsequent `POST /api/v1/sessions` calls to adopt the created Codespace.
- `src/utils/http-helpers.js`: `mapErrorToHttp` for serializing `ProviderError` instances into standard HTTP responses.
- `src/middleware/require-server-token.js`: Protects the new RPC route mounting in `src/server.js`.
- `src/services/status-cache.js`: Credential status cache (`cacheKey('codespaces', credentialFingerprint)`); will be augmented with `invalidateCache(key)`.

## Design Decisions & Architecture Alignment

1. **Dedicated RPC Endpoint with URL Action Routing (`POST /api/v1/codespaces/rpc/:action`)**:
   - Matches the project convention (e.g., `/sessions/terminate-all`, `/vps/status/refresh`).
   - Action `:action` is validated against an explicit allowlist (`ACTIONS = { ensure: ... }`).
   - Unsupported actions fail immediately with `400 CODESPACES_UNSUPPORTED_ACTION`.
   - Leaves request bodies flat and clean, with explicit routing in HTTP access logs.

2. **Mandatory `gh` CLI Check and Creation**:
   - As explicitly required by the user, the account is checked for existing Codespaces using `gh codespace list --json name,state,displayName,machineName,lastUsedAt`.
   - If an existing Codespace is found, return `created: false` (HTTP 200) without running `gh codespace create`.
   - If no Codespace exists, execute `gh codespace create` with repository defaulting to `vm-manager235-1/test` (or `process.env.CODESPACES_DEFAULT_REPOSITORY`) and zero retries (`retries: 0`).
   - Verify/confirm the created Codespace via REST `getCodespace({ nocache: true })`.
   - If confirmation fails unrecoverably, clean up the orphan via `deleteCodespace`.

3. **DB-Authoritative Credential Lookup**:
   - The RPC endpoint resolves credentials strictly from the database `vps` table via `loadCredentialByRef('codespaces', credentialRef)`.
   - No fallback to filesystem, S3, or `process.env.GH_TOKEN` in the RPC path.
   - Tokens are passed only to child process `env.GH_TOKEN` (removing conflicting `GITHUB_TOKEN` / `GH_ENTERPRISE_TOKEN`) and never exposed in responses or logs.

4. **Complete Preservation of `POST /api/v1/sessions`**:
   - `src/routes/sessions.js` and `CodespacesProvider.createSession()` remain completely unchanged.
   - RPC does not create or modify rows in the `sessions` table.
   - Once a Codespace is ensured, callers can use `POST /api/v1/sessions` with `etecnologysys1alwaysdata` to adopt the VM and provision Docker/PaaS containers.

## Work Plan

### Step 1: Update Status Cache (`src/services/status-cache.js`)
- Add `invalidateCache(key)`:
  ```js
  function invalidateCache(key) {
    cache.delete(key);
  }
  ```
- Export `invalidateCache` alongside existing cache functions.

### Step 2: Implement CLI Helpers in `src/services/providers/codespaces/cli-executor.js`
- Add `listCodespacesViaCli(token, options = {})`:
  - Executes `gh codespace list --json name,state,displayName,machineName,lastUsedAt`.
  - Sets per-spawn `env: { ...process.env, GH_TOKEN: token }` (stripping any ambient `GITHUB_TOKEN` or `GH_ENTERPRISE_TOKEN`).
  - Uses bounded timeout (`CHECK_TIMEOUT_MS = 30_000`).
  - Parses JSON stdout; handles empty output (`[]`).
  - Maps spawn `ENOENT` to `CODESPACES_CLI_NOT_INSTALLED` and classifies stderr with `classifyGhStderrError`.
- Add `createCodespaceViaCli(options, token)`:
  - Arguments: `-R <repo>`, optional `--machine <machine>`, optional `--location <cliLocation>`, optional `--branch <branch>`, optional `--display-name <name>`.
  - Sets `retries: 0` (creation is billable and must NEVER retry automatically).
  - Uses bounded timeout (`CREATE_TIMEOUT_MS = 120_000`).
  - Parses created Codespace name from stdout or stderr (`gh codespace create` outputs the created name).
  - Maps timeouts to `CODESPACES_CREATE_TIMEOUT` (HTTP 504) and classifies stderr.
- Map REST geo values to CLI location values (`UsEast` -> `EastUs`, `UsWest` -> `WestUs2`, `EuropeWest` -> `WestEurope`, `SoutheastAsia` -> `SouthEastAsia`).

### Step 3: Implement `CodespacesProvider.ensureCodespace` in `src/services/providers/codespaces-provider.js`
- Validate inputs:
  - Validate `repository` (must be `owner/repo` pattern if provided, defaulting to `process.env.CODESPACES_DEFAULT_REPOSITORY || 'vm-manager235-1/test'`).
  - Validate `machine` with existing `this.validateMachine(machine)` if provided.
  - Validate `geo` with existing `this.validateGeo(geo)` if provided.
- Load DB credential strictly:
  - Call `loadCredentialByRef('codespaces', credentialRef)`.
  - Do not use fallback to filesystem or environment.
- Check GitHub account via `gh`:
  - Call `listCodespacesViaCli(token)`.
  - If `list.length > 0`:
    - Confirm existing Codespace via `getCodespace(token, list[0].name, { nocache: true })`.
    - Return `{ created: false, providerSessionId: list[0].name, codespace: formatResult(...) }` (HTTP 200).
- If `list.length === 0`:
  - Call `createCodespaceViaCli({ repo, machine, location, branch, displayName }, token)`.
  - Immediately invalidate the Codespace read cache and VPS status cache entry.
  - Poll `getCodespace(token, createdName, { nocache: true })` every 3 seconds for up to 60 seconds. Return early if the mapped status is `RUNNING` or terminal (`FAILED`, `STOPPED`, `TERMINATED`).
  - If the 60-second readiness window expires, return the latest successfully confirmed state, even if it remains `PENDING`/`STARTING` (HTTP 201).
  - If post-create confirmation fails unrecoverably, attempt orphan cleanup via `deleteCodespace(token, createdName)` and log redacted warning if deletion fails.

### Step 4: Add RPC Route `src/routes/codespaces-rpc.js`
- Create Express router with `POST /rpc/:action`.
- Define explicit action map:
  ```js
  const ACTIONS = {
    ensure: handleEnsureAction
  };
  ```
- Reject unsupported action with `400 CODESPACES_UNSUPPORTED_ACTION` before credential lookup.
- Extract `credentialRef`:
  - Check `req.headers['x-codespaces-credentials']` or `req.body?.credentialRef`.
  - Return `401 CODESPACES_NO_CREDENTIAL` if missing.
- Resolve provider: `getProvider('codespaces')`.
- Call `provider.ensureCodespace({ ...(req.body || {}), credentialRef })`.
- Return HTTP 201 if `result.created === true`, else HTTP 200, formatted with:
  ```json
  {
    "action": "ensure",
    "provider": "codespaces",
    "credentialRef": credentialRef,
    ...result
  }
  ```
- Wrap with standard `try/catch` and `mapErrorToHttp(err, res)`.

### Step 5: Mount Router in `src/server.js`
- Import `codespacesRpcRoutes` from `./routes/codespaces-rpc`.
- Mount route behind `requireServerToken`:
  ```js
  app.use('/api/v1/codespaces', requireServerToken, codespacesRpcRoutes);
  ```
- Verify `POST /api/v1/sessions` and `POST /api/v1/vps` routes remain unchanged.

### Step 6: Test Suite
- **Route tests (`tests/routes/codespaces-rpc.test.js`)**:
  - Requires server token (`401` / `403` without auth).
  - Action allowlist: `POST /api/v1/codespaces/rpc/foobar` returns `400 CODESPACES_UNSUPPORTED_ACTION`.
  - Missing credential ref returns `401 CODESPACES_NO_CREDENTIAL`.
  - Missing DB credential returns `404 VPS_NOT_FOUND`.
  - Success when Codespace exists returns `200 OK` with `created: false`.
  - Success when Codespace is created returns `201 Created` with `created: true`.
- **Provider tests (`tests/services/providers/codespaces-provider-rpc.test.js`)**:
  - `ensureCodespace` validates repository, machine, and geo.
  - Queries `gh` list first; returns existing Codespace without running `create`.
  - Calls `gh codespace create` when list is empty, using `vm-manager235-1/test` default.
  - Clears `status-cache` on creation.
  - Handles `deleteCodespace` cleanup when confirmation fails after creation.
  - Redacts tokens from all error messages.
- **CLI executor tests (`tests/services/providers/codespaces/cli-executor.test.js`)**:
  - `listCodespacesViaCli` and `createCodespaceViaCli` pass sanitized environment.
  - Timeout and `ENOENT` error handling.
  - `retries: 0` on creation.
- **Session adoption compatibility test**:
  - Verifies that after a Codespace is ensured for `etecnologysys1alwaysdata`, `POST /api/v1/sessions` with `credentialRef: 'etecnologysys1alwaysdata'` adopts the newly created Codespace.

### Step 7: Documentation Updates
- Update `ai/project-overview.md` to document the `POST /api/v1/codespaces/rpc/:action` endpoint and `CODESPACES_DEFAULT_REPOSITORY`.
- Update `README.md` API reference section.
- Add `tests/http/LAB-014-codespaces-rpc.http` with REST Client requests for the `ensure` action and unsupported-action response, following the existing `tests/http/LAB-008-codespaces.http` format. The ensure request uses a registered Codespaces VPS credential and may create a billable Codespace when the account has none.

## Files to Modify and Create

| File | Change |
|---|---|
| `src/services/status-cache.js` | Add and export `invalidateCache(key)` |
| `src/services/providers/codespaces/cli-executor.js` | Add `listCodespacesViaCli`, `createCodespaceViaCli`, geo-to-location mapping, and `ENOENT` handling |
| `src/services/providers/codespaces-provider.js` | Add `ensureCodespace`, repository validation, orphan cleanup, and cache invalidation |
| `src/routes/codespaces-rpc.js` | **New file**: RPC router with `:action` allowlist dispatcher (`ensure`) |
| `src/server.js` | Mount `/api/v1/codespaces` behind `requireServerToken` |
| `tests/codespaces-rpc-route.test.js` | Route tests for auth, validation, allowlist, and 200/201 responses |
| `tests/codespaces-rpc-provider.test.js` | Provider unit tests for `ensureCodespace` flow |
| `tests/codespaces-rpc-cli-executor.test.js` | CLI executor and status-cache tests |
| `tests/http/LAB-014-codespaces-rpc.http` | Manual API requests for ensure and unsupported action, following the LAB-008 HTTP test format |
| `ai/project-overview.md` | Document new RPC endpoint and defaults |
| `README.md` | Document `POST /api/v1/codespaces/rpc/ensure` endpoint |

## Completion Criteria

- [x] Dedicated endpoint `POST /api/v1/codespaces/rpc/:action` implemented with action allowlist (`ensure`).
- [x] `POST /api/v1/sessions` remains completely intact and unaffected.
- [x] Credential resolution is DB-only (`loadCredentialByRef('codespaces', credentialRef)`).
- [x] `gh` CLI checks GitHub account first; returns existing Codespace info if found (`created: false`, 200).
- [x] `gh codespace create` called only when no Codespace exists, with default repository `vm-manager235-1/test` and `retries: 0` (`created: true`, 201).
- [x] Status cache for `('codespaces', credentialFingerprint)` invalidated when new Codespace created.
- [x] After creation, poll live Codespaces state every 3 seconds for up to 60 seconds; return when active/terminal or return the latest confirmed state after timeout.
- [x] Failed post-create confirmation triggers orphan cleanup via `deleteCodespace`.
- [x] Tokens redacted and never exposed in logs, errors, or responses.
- [x] All unit and integration tests passing.
- [x] Manual HTTP API requests added for `POST /api/v1/codespaces/rpc/ensure` (200/201) and unsupported action handling.
- [x] Documentation updated.
