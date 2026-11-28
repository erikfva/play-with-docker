# LAB-014: Dedicated RPC endpoint (`POST /api/v1/rpc/:action`) to check and create GitHub Codespaces

**Issue Type**: Story  
**Priority**: High  
**Component**: Codespaces Provider, Codespaces RPC API, Credential Registry  
**Labels**: codespaces, provider, rpc, credentials, gh-cli  
**Epic**: Multi-Provider VM Orchestration

## User Story

**As an** API client with a registered GitHub Codespaces credential (for example, `etecnologysys1alwaysdata`)  
**I want** a dedicated action-based RPC endpoint (`POST /api/v1/rpc/:action`, starting with `ensure`) separate from `POST /api/v1/sessions` that accepts the target provider in the request body, fetches its registered GitHub token from the database, checks GitHub via `gh` CLI whether a Codespace exists for that account, and creates one (`vm-manager235-1/test` by default) if none exists
**So that** `POST /api/v1/sessions` can remain focused on starting/adopting existing Codespaces VMs and provisioning Docker/PaaS environments, while fresh accounts can be provisioned on demand and future Codespaces RPC actions share a consistent endpoint pattern.

## Background

The orchestrator manages remote VMs behind `BaseProvider` (`src/services/providers/base-provider.js`), `provider-factory.js`, `/api/v1/sessions` (`src/routes/sessions.js`), and `/api/v1/vps` (`src/routes/vps.js`). In the current implementation:

- **`POST /api/v1/sessions` is reserved for session startup & PaaS provisioning**: For `provider: "codespaces"`, `CodespacesProvider.createSession()` (`src/services/providers/codespaces-provider.js`) adopts an existing Codespace (`codespaces[0]`), wakes it if `STOPPED`, runs `initializeSession`, creates a `sessions` row, and starts keep-alive. If the account has zero Codespaces, `POST /api/v1/sessions` fails with `409` (`"No existing Codespaces VM found for this credential. Create one in the GitHub web UI first."`). This existing session/PaaS flow must **not** be altered.
- **Action-subpath convention**: Existing routers already use action sub-routes with plain HTTP+JSON responses and `mapErrorToHttp` (`src/utils/http-helpers.js`), such as `POST /api/v1/sessions/terminate-all` and `POST /api/v1/vps/status/refresh`. The shared RPC path is `POST /api/v1/rpc/:action`; the flat body identifies the provider (currently `codespaces`).
- **Credential registry (`vps` table)**: `src/db/db.js` stores registered credentials in `vps` (keyed by `(provider, name)`, e.g. `('codespaces', 'etecnologysys1alwaysdata')`, plus `credentialcontent` and `credentialfingerprint`). `src/services/db-credentials-loader.js` (`loadCredentialByRef('codespaces', name)`) resolves DB credentials into `{ token, credentialRef, credentialFingerprint }`.
- **VPS status & availability**: `CodespacesProvider.getCredentialStatus(loaded)` (used by `src/services/vps-status-service.js` and `GET /api/v1/vps/available-credential`) stores `details.codespaces` (VM IDs, states, machine info) in `vps.status` and reports `UNAVAILABLE` when `codespaceCount === 0` (which prevents `POST /api/v1/sessions` from selecting an empty account).
- **CLI execution**: `src/services/providers/codespaces/cli-executor.js` executes `gh codespace ssh -c <name> -- <command>` via `execFile`, passing `GH_TOKEN` in the child process `env` without mutating `process.env`.
- **REST client & read cache**: `src/services/providers/codespaces/client.js` wraps GitHub REST API calls (`validateToken`, `listCodespaces`, `getCodespace` with 30s TTL `read-cache.js` and `{ nocache: true }`, `startCodespace`, `stopCodespace`, `deleteCodespace`).

Here, **RPC** means an allowlisted, action-routed API endpoint (`POST /api/v1/rpc/:action`, with `:action = ensure` and `provider = codespaces` in LAB-014) backed by typed provider methods on `CodespacesProvider`. It does **not** mean exposing a general-purpose local shell or arbitrary `gh` command runner.

## Example Flow

1. Client calls `POST /api/v1/rpc/ensure` with `x-codespaces-credentials: etecnologysys1alwaysdata` and `{ "provider": "codespaces", "machine": "basicLinux32gb" }` (or includes `credentialRef` in the JSON body instead of the header).
2. The RPC router validates `:action` (`"ensure"`) against an explicit action allowlist, then delegates to `CodespacesProvider.ensureCodespace(...)`.
3. The provider looks up `provider = 'codespaces'` and `name = 'etecnologysys1alwaysdata'` in the `vps` table via `loadCredentialByRef('codespaces', 'etecnologysys1alwaysdata')` to obtain the GitHub token and `credentialFingerprint`.
4. Using `execFile('gh', ...)` with per-spawn `GH_TOKEN`, the provider checks GitHub (e.g. `gh codespace list --json name,state,displayName,machineName,lastUsedAt`) to verify whether any Codespace already exists on that GitHub account.
5. If a Codespace already exists (`list.length > 0`), the RPC does **not** create a duplicate: it confirms/returns the existing Codespace metadata (`created: false`, HTTP `200`).
6. If **no** Codespace exists (`list.length === 0`), the provider runs `gh codespace create --repo vm-manager235-1/test ...` (using request `repository` if supplied, otherwise `CODESPACES_DEFAULT_REPOSITORY` defaulting to `vm-manager235-1/test`, with `retries: 0` and per-spawn `GH_TOKEN`), then polls `githubClient.getCodespace(..., { nocache: true })` every 3 seconds for up to 60 seconds. It returns as soon as the new Codespace is active (`RUNNING`), reaches a terminal state, or the readiness wait expires; after expiry it returns the latest confirmed state (which may still be `PENDING`/`STARTING`). The VPS status cache is invalidated immediately after creation.
7. The RPC does **not** create a `sessions` row; the caller can now invoke `POST /api/v1/sessions` (`provider: "codespaces"`) with `etecnologysys1alwaysdata` to adopt/start the Codespace and provision Docker/PaaS workloads as usual.

## Scope

- Add a dedicated action-routed endpoint `POST /api/v1/rpc/:action` (mounted with `requireServerToken` in `src/server.js`) separate from `POST /api/v1/sessions`.
- Implement an explicit `:action` allowlist dispatcher in the RPC router and deliver the `ensure` action in LAB-014 (`POST /api/v1/rpc/ensure`). Require `provider: "codespaces"` in the body; reject missing or unsupported providers with `400 CODESPACES_INVALID_PROVIDER`.
- Keep `POST /api/v1/sessions` and `CodespacesProvider.createSession()` **unchanged** for existing Codespace startup and Docker/PaaS provisioning.
- Resolve the GitHub token strictly from the `vps` database table by registered credential name (`loadCredentialByRef('codespaces', credentialRef)`—no silent fallback to file, S3, or `process.env.GH_TOKEN`).
- Use `gh` CLI (`execFile` with per-spawn `GH_TOKEN`) to check GitHub for existing Codespaces on the account; return existing Codespace info if present, and invoke `gh codespace create` only when none exists.
- Validate repository (`owner/repo`, defaulting to `CODESPACES_DEFAULT_REPOSITORY` = `vm-manager235-1/test`), machine, and region/location inputs before execution and map them explicitly to verified `gh codespace create` flags.
- Clean up an orphaned newly created Codespace via `deleteCodespace` if post-create confirmation fails.
- Keep provider-specific CLI execution, output parsing, and GitHub confirmation under `src/services/providers/codespaces/`.

## Out of Scope

- Implementing additional RPC actions beyond `ensure` in LAB-014 (e.g., `list`, `start`, `stop`, `delete` are future actions that will plug into the same `:action` allowlist).
- Changing `POST /api/v1/sessions` behavior for `codespaces` (or changing `gcs`, `codesandbox`, or `pwd`).
- Creating or modifying rows in the `sessions` table from the RPC endpoint (session lifecycle remains owned by `/api/v1/sessions`).
- General-purpose execution of arbitrary local `gh` commands, raw CLI flags, or a generic shell dispatcher.
- Deleting Codespaces on normal session termination (`terminateSession` remains stop semantics).
- Automatic credential selection inside the RPC (callers identify the registered VPS credential explicitly by `credentialRef` or `x-codespaces-credentials`).
- Browser-based creation, interactive `gh auth`, or PostgreSQL schema migrations.

## Functional Requirements

### FR-1: Action-routed RPC endpoint (`POST /api/v1/rpc/:action`)

- Mount a new router in `src/server.js` behind `requireServerToken` (`app.use('/api/v1/rpc', requireServerToken, codespacesRpcRoutes)`), exposing `POST /:action` (`POST /api/v1/rpc/:action`).
- Require the JSON body field `provider: "codespaces"`. Missing or unsupported provider values return `400 CODESPACES_INVALID_PROVIDER` before credential resolution.
- `POST /api/v1/sessions` remains completely untouched and continues to serve existing Codespace adoption, startup, and Docker/PaaS provisioning.
- Resolve `:action` strictly through an explicit allowlist map (`ACTIONS = { ensure: ... }`). Any unknown `:action` fails immediately with `400 CODESPACES_UNSUPPORTED_ACTION` (including `details: { action, supportedActions: ['ensure'] }`), without loading credentials or spawning `gh`.
- Extract the credential reference via `x-codespaces-credentials` header or `req.body.credentialRef` (consistent with `getCodespacesCredentialRef(req)` in `src/routes/sessions.js`). Missing reference returns `401 CODESPACES_NO_CREDENTIAL`.
- Resolve `getProvider(req.body.provider)` via `src/services/provider-factory.js` after validating it is `codespaces`, then invoke the action handler (`provider.ensureCodespace(options)` for `ensure`), never spawning `gh` directly in the route.
- All errors flow through `mapErrorToHttp` (`src/utils/http-helpers.js`) using `ProviderError` codes and HTTP statuses.

### FR-2: Resolve the registered Codespaces token from the database

- The `ensure` RPC resolves `credentialRef` (such as `"etecnologysys1alwaysdata"`) strictly against the `vps` table (`provider = 'codespaces'`, `name = credentialRef`) via `loadCredentialByRef('codespaces', credentialRef)` in `src/services/db-credentials-loader.js`.
- Missing DB registrations return `404 VPS_NOT_FOUND`; malformed stored content returns `400 CODESPACES_NO_CREDENTIAL` / `400 VPS_CONTENT_INVALID`. The RPC **must not** fall back to filesystem, S3, or `process.env.GH_TOKEN` / `process.env.GITHUB_TOKEN`.
- The resolved token is held only in memory for the request, is never returned in API responses, persisted to `sessions`, or written to logs.
- Every `gh` child process invocation passes `GH_TOKEN: token` in per-spawn `env`, strips inherited `GITHUB_TOKEN` / `GH_ENTERPRISE_TOKEN` if present, and never mutates `process.env`.

### FR-3: Check GitHub via `gh` first, then create via `gh codespace create` if none exists (`ensure`)

- **Check whether a Codespace exists in the GitHub account using `gh`**:
  1. Using the DB token in per-spawn `GH_TOKEN`, execute `gh codespace list --json name,state,displayName,machineName,lastUsedAt` (exact fields verified against the installed `gh` version) via `execFile` to inspect the GitHub account.
  2. If one or more Codespaces already exist (`list.length > 0`), fetch/confirm the target Codespace (`githubClient.getCodespace(token, list[0].name, { nocache: true })`) and return it immediately with `created: false` (HTTP `200 OK`)—do **not** run `gh codespace create`.
  3. Only when `gh` confirms **no** Codespace exists in the GitHub account (`list.length === 0`), invoke `gh codespace create` with `-R` / `--repo <repository>`.
  4. Auth, scope, suspension, billing, rate-limit, timeout, or CLI-missing errors during the `gh` check step must surface as structured `ProviderError` responses and **never** fall through to `gh codespace create`.
- **No-shell argument vector**: Invoke `execFile('gh', args, { timeout, env })` with discrete arguments—never `exec` or shell string interpolation.
- **No automatic retries on create**: Unlike `executeInCodespace` (which retries `gh codespace ssh` up to 3 times), `gh codespace create` **must execute with zero retries (`retries: 0`)** so a timeout or ambiguous exit never provisions duplicate billable Codespaces.
- **Validated parameters & defaults**:
  - `repository` (`owner/repo` format, required by `gh codespace create`): if provided in the request, validate format upfront (`400 CODESPACES_INVALID_REPOSITORY`). When creating a new Codespace and `repository` is omitted, default to `process.env.CODESPACES_DEFAULT_REPOSITORY || 'vm-manager235-1/test'`. Fail with `500 CODESPACES_REPOSITORY_NOT_CONFIGURED` if an empty override leaves no repository configured.
  - `machine`: validated upfront by existing `validateMachine()` against `VALID_MACHINES` (`400 CODESPACES_INVALID_MACHINE`), defaulting to `process.env.CODESPACES_DEFAULT_MACHINE` when creating.
  - `geo`: validated upfront by existing `validateGeo()` against `VALID_GEOS` (`400 CODESPACES_INVALID_GEO`), defaulting to `process.env.CODESPACES_DEFAULT_GEO` when creating, and explicitly translated to the `gh codespace create --location` value required by GitHub CLI.
  - Optional `branch`, `displayName`, `idleTimeoutMinutes`, `retentionPeriodMinutes` (if forwarded to `gh codespace create`) must be validated as typed values and mapped to fixed CLI flags verified against the container's `gh` version.
- **Bounded timeout & redacted error translation**:
  - Apply explicit bounded timeouts (short check timeout for `gh codespace list` and `CODESPACES_CREATE_TIMEOUT_MS` for `gh codespace create`, distinct from `COMMAND_TIMEOUT_MS`).
  - Map spawn `ENOENT` to `500 CODESPACES_CLI_NOT_INSTALLED`, timeouts to `504 CODESPACES_CREATE_TIMEOUT` (or `CODESPACES_START_TIMEOUT`), and `stderr` diagnostics through a shared/extended classifier covering suspended accounts (`403 CODESPACES_ACCOUNT_SUSPENDED`), billing/quota issues (`402 CODESPACES_BILLING_ERROR`), invalid token (`401 CODESPACES_TOKEN_INVALID`), insufficient scope (`403 CODESPACES_TOKEN_INSUFFICIENT_SCOPE`), rate limits (`429 CODESPACES_RATE_LIMIT_EXCEEDED`), invalid parameters (`400`), and generic failures (`502 CODESPACES_CREATION_FAILED`).
  - Pass all `stderr` / `error.message` text through token redaction (`redactTokensFromMessage`) before attaching to errors or logs.
- **Deterministic confirmation & orphan cleanup**:
  - Extract the created Codespace name (VM ID) from `gh codespace create` output (reject empty/unparseable output rather than guessing).
  - Invalidate any cached entry (`invalidateCodespace`) and confirm the resource via `githubClient.getCodespace(token, name, { nocache: true })`.
  - If `gh codespace create` succeeded and returned a Codespace name, but post-create confirmation fails with a non-transient/unrecoverable error or internal error, attempt `githubClient.deleteCodespace(token, name)` cleanup and log a redacted warning if cleanup fails.

### FR-4: VPS status cache synchronization & session compatibility

- Because `POST /api/v1/sessions` still adopts existing Codespaces on the account (and `CodespacesProvider.getCredentialStatus()` reports `UNAVAILABLE` when `codespaceCount === 0`), creating a new Codespace via `POST /api/v1/rpc/ensure` makes that VPS credential usable for subsequent `POST /api/v1/sessions` calls.
- After `ensure` creates a new Codespace (`created: true`), clear the `status-cache.js` entry for `('codespaces', credentialFingerprint)` so `GET /api/v1/vps` and `GET /api/v1/vps/available-credential?provider=codespaces` reflect the new Codespace VM ID and `AVAILABLE` status promptly after refresh instead of serving stale `UNAVAILABLE` cache entries.
- After creation, poll live GitHub state every 3 seconds for up to 60 seconds. Return immediately when the VM becomes active (`RUNNING`) or reaches a terminal state; if the wait expires, return the most recently confirmed state, which may still be `PENDING` or `STARTING`.
- The RPC does not modify existing `sessions` rows or block on active sessions—if a Codespace already exists on GitHub (whether backing a session or idle), `ensure` simply detects it via `gh` and returns `created: false` without creating another VM.

## Acceptance Criteria

1. `POST /api/v1/rpc/:action` requires server token auth (`requireServerToken`) and validates `:action` against an explicit allowlist (`ensure` in LAB-014); unsupported actions fail with `400 CODESPACES_UNSUPPORTED_ACTION` without loading credentials or spawning `gh`.
2. `POST /api/v1/rpc/ensure` requires body `provider: "codespaces"`; missing or unsupported provider values return `400 CODESPACES_INVALID_PROVIDER` before credential lookup.
3. `POST /api/v1/rpc/ensure` accepts `x-codespaces-credentials` or body `credentialRef` (e.g. `etecnologysys1alwaysdata`), returning `401 CODESPACES_NO_CREDENTIAL` if missing and `404 VPS_NOT_FOUND` if not in the `vps` table.
4. Token lookup uses DB-only resolution (`loadCredentialByRef('codespaces', credentialRef)`) with no fallback to files, S3, or `process.env.GH_TOKEN`.
5. The provider invokes `gh` via `execFile` with per-spawn `GH_TOKEN` (stripping `GITHUB_TOKEN`/`GH_ENTERPRISE_TOKEN`, never mutating `process.env`) to check whether any Codespace exists in the GitHub account.
6. When `gh` confirms **no** Codespace exists in the account, `ensure` invokes `gh codespace create --repo <repository>` (defaulting to `vm-manager235-1/test`, with `retries: 0`), confirms and polls the new Codespace, and returns `201 Created` with `action: "ensure"`, `created: true`, and the Codespace VM metadata.
7. When `gh` finds an existing Codespace in the account, `ensure` does **not** invoke `gh codespace create`, confirms the existing Codespace, and returns `200 OK` with `action: "ensure"`, `created: false`, and the existing Codespace metadata.
8. Auth, scope, rate-limit, timeout, or `ENOENT` errors during the `gh` check step surface as structured `ProviderError` responses and never fall through to `gh codespace create`.
9. Invalid `repository` / `machine` / `geo` inputs fail with `400` before spawning `gh`; missing `gh` binary (`ENOENT`), timeouts, billing/quota (`402`), token/scope/suspended (`401`/`403`), rate limits (`429`), and generic CLI failures map to stable `ProviderError` codes and HTTP statuses with tokens redacted from all messages/logs.
10. `gh codespace create` is never retried automatically on timeout or unknown exit.
11. `POST /api/v1/sessions` behavior for `codespaces` (adopt/wake/initialize/PaaS Docker provisioning) and `gcs`/`codesandbox` flows remain completely unchanged; after `POST /api/v1/rpc/ensure` creates a Codespace for `etecnologysys1alwaysdata`, calling `POST /api/v1/sessions` with `etecnologysys1alwaysdata` succeeds by adopting the newly provisioned Codespace.
12. Status cache for `('codespaces', credentialFingerprint)` is invalidated when `created: true` so VPS status reflects the new Codespace.
13. After creating a Codespace, the provider checks its state every 3 seconds for up to 60 seconds, returning once active or terminal; if the wait expires, the response contains the latest confirmed state and may report `PENDING` or `STARTING`.

## API Contract Proposal

### Endpoint

```http
POST /api/v1/rpc/:action
```

Supported `:action` in LAB-014: `ensure` (`POST /api/v1/rpc/ensure`).

```http
POST /api/v1/rpc/ensure
x-server-token: <SERVER_TOKEN>
x-codespaces-credentials: etecnologysys1alwaysdata
Content-Type: application/json
```

### Request Body (flat, action-specific)

```json
{
  "provider": "codespaces",
  "credentialRef": "etecnologysys1alwaysdata",
  "repository": "vm-manager235-1/test",
  "branch": "main",
  "machine": "basicLinux32gb",
  "geo": "UsWest",
  "idleTimeoutMinutes": 30,
  "displayName": "My Codespace"
}
```

For a newly created Codespace, the endpoint polls for up to 60 seconds (3-second intervals) for it to become active. If that window expires first, the `201 Created` response contains the latest confirmed state and may still report `Provisioning` / `PENDING`.

- `provider` is required and must be `codespaces` in LAB-014.
- `credentialRef` is optional in the body if `x-codespaces-credentials` header is provided.
- `repository` defaults to `CODESPACES_DEFAULT_REPOSITORY` (`vm-manager235-1/test`) if omitted.
- `machine` and `geo` default to `CODESPACES_DEFAULT_MACHINE` / `CODESPACES_DEFAULT_GEO`.
- Raw CLI flags are never accepted.

### Response (`201 Created` when newly created, `200 OK` when already existing)

```json
{
  "action": "ensure",
  "provider": "codespaces",
  "credentialRef": "etecnologysys1alwaysdata",
  "created": true,
  "providerSessionId": "octocat-test-abc123",
  "codespace": {
    "name": "octocat-test-abc123",
    "displayName": "My Codespace",
    "state": "Available",
    "status": "RUNNING",
    "machine": "basicLinux32gb",
    "location": "WestUs2",
    "webIdeUrl": "https://octocat-test-abc123.github.dev",
    "sshCommand": "gh codespace ssh -c octocat-test-abc123"
  }
}
```

### Unsupported Action Error (`400 Bad Request`)

```json
{
  "error": "Unsupported Codespaces RPC action: unknownAction",
  "code": "CODESPACES_UNSUPPORTED_ACTION",
  "details": {
    "action": "unknownAction",
    "supportedActions": ["ensure"]
  }
}
```

## Architecture Notes

- `src/server.js`: mount `app.use('/api/v1/rpc', requireServerToken, codespacesRpcRoutes)`, keeping `/api/v1/sessions` and `/api/v1/vps` untouched.
- `src/routes/codespaces-rpc.js` (new):
  - Define `POST /:action` on the router mounted at `/api/v1/rpc`, with an explicit `ACTIONS` dispatch table (`ensure` in LAB-014; future actions register here cleanly).
  - Validate `req.params.action` against `ACTIONS` (`400 CODESPACES_UNSUPPORTED_ACTION` if missing/unknown).
  - Require `body.provider === 'codespaces'`, then extract `credentialRef` (`x-codespaces-credentials` or `body.credentialRef`), resolve `getProvider(body.provider)`, invoke the matched action handler (`provider.ensureCodespace({ ...(req.body || {}), credentialRef })`, return `201` if `result.created` else `200` with `{ action, provider, credentialRef, ...result }`, and forward errors to `mapErrorToHttp`.
- `src/routes/sessions.js`: **no changes required**; `POST /api/v1/sessions` continues to adopt/start existing Codespaces and provision Docker/PaaS sessions.
- `src/services/providers/base-provider.js`: **no changes required** (`ensureCodespace` is a Codespaces-specific RPC method on `CodespacesProvider`).
- `src/services/providers/codespaces-provider.js`:
  - Leave `createSession()` and `getCredentialStatus()` intact for `/api/v1/sessions` compatibility.
  - Add `ensureCodespace(options)`: validate `repository`, `machine`, `geo`; resolve DB token via `loadCredentialByRef('codespaces', credentialRef)`; call `listCodespacesViaCli(token)`; if non-empty confirm via `githubClient.getCodespace` and return `{ created: false, ... }`; if empty call `createCodespaceViaCli(options, token)`, confirm via `githubClient.getCodespace(..., { nocache: true })`, invalidate `status-cache.js` entry if present, and return `{ created: true, ... }`.
- `src/services/providers/codespaces/cli-executor.js` (or `create-executor.js`): add `listCodespacesViaCli` (`gh codespace list --json ...`) and `createCodespaceViaCli` (`gh codespace create --repo ...`) using `execFile`, `retries: 0` on create, sanitized `GH_TOKEN` env, `ENOENT` handling, and token-redacted `stderr` classification.
- `src/services/db-credentials-loader.js` & `src/services/status-cache.js`: reuse `loadCredentialByRef('codespaces', name)` for DB-authoritative token lookup and invalidate status cache for `('codespaces', credentialFingerprint)` on creation.
- `src/services/providers/codespaces/client.js` & `session-mapper.js`: reuse `getCodespace` (`{ nocache: true }`), `deleteCodespace`, `invalidateCodespace`, and `mapState`.

## Risks and Decisions to Resolve During Implementation

- **Action naming & future extensibility**: Lock `ensure` as the canonical action name for "check if one exists on GitHub, create if missing" so future actions (`list`, `start`, `stop`, `delete`, etc.) fit cleanly under `POST /api/v1/rpc/:action` without ambiguity.
- **Default repository (`vm-manager235-1/test`) & `CODESPACES_DEFAULT_REPOSITORY_ID`**: `CODESPACES_DEFAULT_REPOSITORY_ID` (`1296269`) in `project-overview.md` is a numeric ID for the GitHub REST API, whereas `gh codespace create -R/--repo` requires an `owner/repo` slug. Configure `CODESPACES_DEFAULT_REPOSITORY` defaulting to `vm-manager235-1/test` and verify registered tokens have permission to create Codespaces on `vm-manager235-1/test`.
- **`gh` CLI version & flag/value differences**: `Dockerfile` installs the latest stable `gh` from `cli.github.com` (check `gh --version`). In particular:
  - Verify exact `gh codespace list --json` field names supported by the installed `gh` version.
  - `VALID_GEOS` uses REST API names (`UsEast`, `UsWest`, `EuropeWest`, `SoutheastAsia`), whereas `gh codespace create --location` uses Azure region names (e.g., `EastUs`, `WestUs2`, `WestEurope`, `SouthEastAsia`). Verify exact supported `--location` values and define the mapping table in `codespaces-provider.js`.
  - Verify whether `gh codespace create` in the installed CLI supports `--idle-timeout`, `--retention-period`, `--display-name`, and `--json` output, and whether it blocks until `Available` or returns immediately in `Provisioning`/`Starting`.
- **Quota & billing**: Creation consumes GitHub Codespaces storage/compute quota immediately; never auto-retry `gh codespace create` on timeout or non-transient errors.
- **Documentation updates**: Document `POST /api/v1/rpc/:action` (`ensure`) in `ai/project-overview.md` and `README.md` after implementation, noting that `POST /api/v1/sessions` continues to adopt/start existing Codespaces.

## Implementation Checklist

- [x] Mount `src/routes/codespaces-rpc.js` at `/api/v1/rpc` in `src/server.js` behind `requireServerToken`, exposing `POST /:action` with an explicit `ACTIONS` allowlist (`ensure`) and required body `provider: "codespaces"`.
- [x] Smoke-check Codespaces list/create behavior and output in the running environment. The reported successful ensure response confirms creation, name parsing, machine/location metadata, and the provisioning state that readiness polling now handles. The exact `gh --version` was not recorded.
- [x] Finalize request schema (`provider: "codespaces"`, `credentialRef`, `repository` defaulting to `vm-manager235-1/test`, `branch`, `machine`, `geo`, `idleTimeoutMinutes`, `displayName`) and `CODESPACES_DEFAULT_REPOSITORY=vm-manager235-1/test`.
- [x] Implement `listCodespacesViaCli` (`gh codespace list --json ...`) and `createCodespaceViaCli` (`gh codespace create --repo ...`) in `codespaces/cli-executor.js` with `execFile`, zero create retries, sanitized `GH_TOKEN` env, `ENOENT`/timeout handling, and token-redacted error mapping.
- [x] Implement `CodespacesProvider.ensureCodespace(options)` using DB-only lookup (`loadCredentialByRef('codespaces', credentialRef)`), `gh` existence check, `gh codespace create` when empty, immediate cache invalidation, and fresh REST polling every 3 seconds for up to 60 seconds after creation; return once active/terminal or with the latest state at timeout, and clean up on unrecoverable confirmation failure.
- [x] Keep `POST /api/v1/sessions` and `BaseProvider` untouched.
- [x] Add unit and route tests for action allowlisting, credential resolution, check-then-create vs existing-codespace behavior, defaults and validation, CLI errors and token isolation, cache invalidation, and orphan cleanup.
- [x] Add the manual HTTP API requests in `tests/http/LAB-014-codespaces-rpc.http` for ensure (200/201) and unsupported-action behavior.
- [x] Update `ai/project-overview.md` and `README.md` with `POST /api/v1/rpc/:action` (`ensure`) and `CODESPACES_DEFAULT_REPOSITORY=vm-manager235-1/test`.
