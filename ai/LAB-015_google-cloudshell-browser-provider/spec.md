# LAB-015: Google Cloud Shell Browser-Session Provider

**Issue Type**: New Feature
**Priority**: High
**Component**: Provider System
**Labels**: provider, google-cloudshell, browser-session, integration
**Epic**: Multi-Provider VM Orchestration

---

## Summary

Add a new `gcsbrowser` provider to the play-with-docker orchestrator that provisions and
manages Google Cloud Shell VMs authenticated with a **saved browser session** (a Playwright
`storageState` file), instead of a Google service-account key. The provider drives the
private Cloud Shell web-app RPC surface and the SSH-over-websocket relay that were validated
in `ai/LAB-14_google-cloudshell/research.md`, and reuses the working `ssh` transport proven by
`scripts/cloudshell/cloudshell.py`.

---

## Background

The orchestrator currently supports `gcs` (service-account key), `codesandbox`, and
`codespaces`. The existing `gcs` provider authenticates with a Google service-account key
JSON through `googleapis` and reaches the VM over **direct SSH** (`gcs-service.js` +
`ssh-service.js`). That model is incompatible with a browser-session credential:

- `GoogleAuth` cannot consume a Playwright `storageState` (cookie JSON), and Cloud Shell's
  public REST API does not accept browser cookies.
- The VM **only** accepts SSH through the `wss://…/_cloudshell/tcp/22` relay, using a
  `CloudShellAuthorization` cookie + a short-lived `_cloudshellAccessToken` + the **account
  name** as the SSH username — none of which the legacy GCS SSH path uses.

`ai/LAB-14_google-cloudshell/research.md` proved the full alternative flow end-to-end
(create/warm via `setupsession`, authorize the relay via `/cloudshell/jwt` →
`/_cloudshell/login`, run commands via `ssh` through the relay as `etecnologysys@…`), and
`scripts/cloudshell/cloudshell.py` packaged it. This feature ports that proven client into a
first-class provider so the orchestrator — and its frontend — can use browser-session Cloud
Shell VMs the same way they use Codespaces.

---

## Business Value

- **Zero service-account setup**: users who already have a Google login can bring a saved
  browser session; no SA key, no project IAM, no `gcloud`.
- **Real, persistent `$HOME` VMs**: Cloud Shell provides 5 GB persistent storage and a full
  Linux VM with Docker — a strong complement to the ephemeral sandbox providers.
- **Provider parity**: the same `POST /sessions` / `command` / keep-alive / terminate
  contract as `codespaces`, so the frontend and VPS credential machinery work unchanged.
- **Reuses proven code**: the LAB-14 relay/SSH recipe is already validated; the risk is
  mostly mechanical porting, not protocol discovery.

---

## Functional Requirements

### FR-1: Provider Registration
**As a** system administrator
**I want** a new `gcsbrowser` provider registered in the orchestrator
**So that** users can select it when creating sessions

**Acceptance Criteria**:
- Provider identifier `gcsbrowser` is registered in `provider-factory.js`
- Provider appears in `GET /api/v1/sessions/providers/supported`
- Provider implements the full `BaseProvider` interface (`createSession`, `refreshSession`,
  `executeCommand`, `terminateSession`, `isSessionActive`, `executeKeepAlive`,
  `getKeepAliveConfig`, `getCredentialStatus`)

---

### FR-2: Credential Loading and Fingerprinting
**As a** API user
**I want** to authenticate with a saved Google browser session
**So that** I can create and manage Cloud Shell sessions

**Acceptance Criteria**:
- Credential is a Playwright `storageState` JSON file (`{"cookies": […], "origins": […]}`)
  with at least one auth cookie (e.g. `SID` / `__Secure-1PSID`)
- Credentials stored in the `vps` table under `provider = 'gcsbrowser'` (DB-first), and
  loadable from all three legacy storage modes (S3 object, s3fs mount, local) via the
  existing `vps`/`seed-credentials.js` machinery
- **Credential minimization**: the persisted credential is a **reduced** storageState
  containing only the cookies the Cloud Shell flow actually sends — the `.google.com`
  cookies (17) and the `accounts.google.com` cookies (6), and **no `origins`**. The raw
  capture (49 cookies across 8 domains + `origins`) is never stored. This is verified
  end-to-end (LAB-015 plan §5) and keeps YouTube/regional/account-page session data out
  of the database
- New provider is added to `SUPPORTED_PROVIDERS` in `vps-credential-utils.js`; validation
  requires valid JSON + `cookies` array, and rejects with `GCSBROWSER_CREDENTIALS_INVALID`
  (400) otherwise
- Fingerprint = `sha256:` of the **canonicalized JSON string** (`JSON.stringify(parsed)`)
  of the **minimized** cookie set
- Request accepts credentials via `x-gcsbrowser-credentials` header or body `credentialRef`
- Missing credential fails immediately with `GCSBROWSER_NO_CREDENTIAL` (400) — no fallback
  token, no env-var fallback
- Credential resolution never sets a global `GOOGLE_APPLICATION_CREDENTIALS` (unlike legacy
  GCS): the storageState is written to a private temp file and used only by this provider

---

### FR-3: Credential Discovery
**As a** API user
**I want** to list available `gcsbrowser` credentials
**So that** I can select the right one for session creation

**Acceptance Criteria**:
- New endpoint `GET /api/v1/sessions/gcsbrowser-credentials` returns available credentials
- Response shape identical to the existing `google-credentials` / `codesandbox-credentials`
  endpoints (uses `listAvailableCredentials('gcsbrowser')`)
- Endpoint requires server-token authorization

---

### FR-4: Session Creation (Start / Warm the VM)
**As a** API user
**I want** to create a `gcsbrowser` session
**So that** I get a working Cloud Shell VM

**Acceptance Criteria**:
- `POST /api/v1/sessions` with `{"provider": "gcsbrowser"}` creates a session
- The provider:
  1. Fetches the XSRF token (`GET /newtoken?authuser=0`, redirect followed) — §5.1a of LAB-14
  2. Validates eligibility (`GET /cloudshell/ca` → `200` + `[]`)
  3. Reads the environment (`GET /cloudshell/environments/get`)
  4. Calls `POST /cloudshell/setupsession` with the ephemeral SSH public key (base64 of the
     SSH wire blob) — starts a STOPPED environment, refreshes an existing one
  5. Polls `environments/get` until `state == 3` (RUNNING), up to a 90s boot timeout
- The SSH key is **generated once per credential** (persistent in `.state`-style storage,
  0600) and the public key is registered with `setupsession`; the private key is stored in
  the session row's `privateKey` column so later commands reuse it instead of re-registering
- The ephemeral `_cloudshellAccessToken` is stored in `metadata` as a **throwaway cache**,
  refreshed lazily on every operation (never treated as durable)
- Response is the minimal `{ id, provider, providerSessionId, status }` contract; full
  details via `GET /api/v1/sessions/:id`
- `providerSessionId` = the environment's `host` (e.g. `cs-…cloudshell.dev`)
- Session stored in `sessions` with `provider = 'gcsbrowser'`
- One active session per credential fingerprint, enforced by a unique partial index (see
  Data Model)

---

### FR-5: Session State Management
**As a** system
**I want** to accurately track Cloud Shell environment state
**So that** users and keep-alive can respond appropriately

**Acceptance Criteria**:
- `refreshSession` calls `environments/get` and maps:
  - `state 3` (RUNNING) → `RUNNING`
  - `state 2` (STARTING/PENDING) → `STARTING`
  - `state 1` (STOPPED) → `STOPPED`
- `GET /api/v1/sessions/:id` refreshes state on every request
- `STOPPED` rows are preserved across restarts (keep-alive recovery skips them, matching
  Codespaces semantics)
- Session metadata includes provider-specific fields:
  `envName`, `stateName`, `vmIp`, `host`, `sshUser` (the account name), `editorUrl`,
  `accessToken` (throwaway), `webHost` = `editorUrl`

---

### FR-6: Command Execution (via relay)
**As a** API user
**I want** to run commands in the Cloud Shell VM
**So that** I can work inside it

**Acceptance Criteria**:
- `POST /api/v1/sessions/:id/command` executes commands in the VM
- Transport: local TCP bridge → WebSocket (`wss://970-<host>/_cloudshell/tcp/22`) → VM's
  SSH (port 22), via `ssh` with a `ProxyCommand` shim — same architecture as
  `scripts/cloudshell/cloudshell.py`
- SSH username is the **account name** from `environments/get` (field 4) — never
  `cloudshelluser` (LAB-14 §8: `cloudshelluser` gets `Permission denied`)
- Requires `CloudShellAuthorization` from `/_cloudshell/login` (LAB-14 §6.2a); the relay
  returns `503` without it
- **Auto-wake**: if the environment is `STOPPED`, `executeCommand` first calls
  `setupsession` (warm) + polls to RUNNING, then runs the command (matching Codespaces
  auto-start semantics); `FAILED`/`TERMINATED` sessions reject commands
- Response includes `output` (combined stdout/stderr); remote exit status is surfaced
- Commands that fail don't crash the session
- Docker works out-of-the-box (Docker is present in the Cloud Shell VM)

---

### FR-7: Session Termination
**As a** API user
**I want** to terminate a `gcsbrowser` session
**So that** I stop billing/quota usage

**Acceptance Criteria**:
- `DELETE /api/v1/sessions/:id` terminates the session
- Provider calls `POST /cloudshell/devshell/abandon` (§11 of LAB-14 — **the documented but
  untested teardown**), then the route hard-deletes the DB row (same as `gcs`)
- `abandon` failure is best-effort: log a warning, still remove the local row (Cloud Shell
  idles out on its own)
- Keep-alive timers are stopped before termination (existing route behavior)

---

### FR-8: Keep-Alive
**As a** system
**I want** to keep a running Cloud Shell VM alive
**So that** it doesn't idle-suspend mid-work

**Acceptance Criteria**:
- Keep-alive enabled by default; interval 10 minutes (pre-empts the ~20-minute free-tier
  inactivity suspend)
- Strategy `relay-command`: run a harmless `echo keep-alive` via the same relay + SSH
  transport
- `runOnStart: false` — never fires immediately on creation or recovery
- Effective interval = `min(configured, session idleTimeoutMinutes − 10)`, floored at 1
  (mirrors Codespaces derivation; default idle 20 min)
- Per-session `metadata.keepAlive.enabled` override → `GCSBROWSER_KEEP_ALIVE_ENABLED` env
  var → default `true` (precedence like Codespaces)
- 3 consecutive failures → `FAILED` (existing keep-alive service)
- Keep-alive skips `STOPPED`, `STOPPING`, `TERMINATED`, `FAILED` (existing skip behavior)

---

### FR-9: Session Listing and Filtering
**As a** API user
**I want** to list and filter `gcsbrowser` sessions
**So that** I can manage them

**Acceptance Criteria**:
- `GET /api/v1/sessions` includes `gcsbrowser` sessions
- `?provider=gcsbrowser` filters (the `?provider=` filter added for Codespaces applies)

---

### FR-10: Bulk Termination
**As a** API user
**I want** to terminate all active sessions
**So that** I can clean up quickly

**Acceptance Criteria**:
- `POST /api/v1/sessions/terminate-all` includes `gcsbrowser` sessions
- Credentials loaded from stored `credentialRef` on each row (no header required), matching
  Codespaces behavior
- Hard-delete rows after `abandon` succeeds

---

### FR-11: VPS Available-Credential Integration
**As a** API user
**I want** `GET /api/v1/vps/available-credential?provider=gcsbrowser` to work
**So that** the frontend can pick a usable browser-session credential

**Acceptance Criteria**:
- `gcsbrowser` added to the `vps` registry-aware selection strategy (`first-available`),
  with the same exclusion rules as GCS/Codesandbox (status unusable, or backing a
  non-terminal session)
- `getCredentialStatus` validates by calling `environments/get` and reports
  `AVAILABLE`/`EXPIRED`/`INVALID`/`UNAVAILABLE` via the standard VPS status flow

---

## Non-Functional Requirements

### NFR-1: Performance
- Session creation (warm) completes within 15 seconds; cold start within 90 seconds
- Command execution on a running VM completes within 10 seconds for simple commands
- State refresh completes within 3 seconds
- Keep-alive operations complete within 10 seconds for warm sessions; up to 90s when waking

### NFR-2: Reliability
- Short-lived access tokens (`_cloudshellAccessToken`, `CloudShellAuthorization`) are
  **refreshed lazily on every operation**; a `503` on the relay triggers re-auth
  (`relay_login`) and retry, never a hard failure
- Transient `environments/get` / `setupsession` errors don't permanently break the session
- `STOPPED` environments are never treated as failures — they're restorable via wake

### NFR-3: Scalability
- Support concurrent management of multiple `gcsbrowser` sessions (one per credential
  fingerprint)
- No global mutable env vars; per-request temp files cleaned up

### NFR-4: Security
- Session cookies never logged or returned in API responses
- Private SSH key stored 0600 in session row / state storage
- Credential temp files written 0600 and cleaned up
- No global `GOOGLE_APPLICATION_CREDENTIALS` mutation (unlike legacy GCS)
- `accessToken` / `CloudShellAuthorization` redacted from logs (LAB-14 §10.3)
- All HTTP is HTTPS; websocket relay is `wss://`

### NFR-5: Maintainability
- Provider isolated in `src/services/providers/gcsbrowser-provider.js`
- Submodule structure mirrors Codespaces: `gcsbrowser/{web-client,relay,credentials-loader}.js`
- Configuration via env vars

### NFR-6: Compatibility
- Works with all credential storage modes (S3, s3fs, local)
- Node 20 + `ws` dependency (added) — no new system packages required (the Dockerfile
  already ships `python3` + `openssh-client`); `proxycmd` shim is Python stdlib

---

## Technical Constraints

### TC-1: No public REST API
Cloud Shell has no OAuth-usable public API; the provider must use the private RPC surface
(`shell.cloud.google.com/cloudshell/*`, `ssh.cloud.google.com/cloudshell/jwt`) with session
cookies. This surface is **undocumented and subject to change** — the provider must isolate
it in one client module and fail with clear, actionable error codes.

### TC-2: Relay-only SSH
The VM accepts SSH **only** via the `wss://` relay — direct SSH to the VM IP is refused.
Command execution requires the websocket bridge + `ProxyCommand` shim.

### TC-3: Short-lived session tokens
`_cloudshellAccessToken` and `CloudShellAuthorization` expire quickly. They are per-operation
state, never durable credentials.

### TC-4: Environment is per-account, singleton
Each Google account has one `default` environment. One active session per credential
fingerprint is the natural model; the unique partial index enforces it.

### TC-5: Cost / quota
Cloud Shell runs on a **50-hour weekly quota** and **12-hour session cap**. The provider
must expose these limits via `getCredentialStatus` (already in `gcs-provider.js` —
reuse) and document them.

---

## API Specification

### Create `gcsbrowser` Session

**Endpoint**: `POST /api/v1/sessions`

**Headers**:
```
x-server-token: <SERVER_TOKEN>
x-gcsbrowser-credentials: <credentialRef>
Content-Type: application/json
```

**Request Body**:
```json
{
  "provider": "gcsbrowser",
  "keepAlive": true,
  "idleTimeoutMinutes": 20
}
```

**Response** (201 Created):
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "provider": "gcsbrowser",
  "providerSessionId": "cs-666362651618-default.cs-us-west1-ijlt.cloudshell.dev",
  "status": "RUNNING"
}
```

### Execute Command in `gcsbrowser` Session

**Endpoint**: `POST /api/v1/sessions/:id/command`

**Headers**:
```
x-server-token: <SERVER_TOKEN>
Content-Type: application/json
```

**Request Body**:
```json
{ "command": "ls -la" }
```

**Response** (200 OK):
```json
{ "output": "total 18916\ndrwxr-x--- 9 etecnologysys etecnologysys ...\n" }
```

### List `gcsbrowser` Credentials

**Endpoint**: `GET /api/v1/sessions/gcsbrowser-credentials`

**Headers**:
```
x-server-token: <SERVER_TOKEN>
```

**Response** (200 OK): same shape as `google-credentials` / `codesandbox-credentials`.

### Get `gcsbrowser` Session

**Endpoint**: `GET /api/v1/sessions/:id`

**Response** (200 OK):
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "provider": "gcsbrowser",
  "providerSessionId": "cs-666362651618-default.cs-us-west1-ijlt.cloudshell.dev",
  "status": "RUNNING",
  "webHost": "https://970-cs-666362651618-default.cs-us-west1-ijlt.cloudshell.dev",
  "sshCommand": "ssh etecnologysys@cs-666362651618-default.cs-us-west1-ijlt.cloudshell.dev",
  "metadata": {
    "envName": "default",
    "stateName": "RUNNING",
    "vmIp": "34.168.245.26",
    "host": "cs-666362651618-default.cs-us-west1-ijlt.cloudshell.dev",
    "sshUser": "etecnologysys",
    "editorUrl": "https://970-cs-666362651618-default.cs-us-west1-ijlt.cloudshell.dev",
    "keepAlive": { "enabled": true, "intervalMinutes": 10 }
  }
}
```

### Delete `gcsbrowser` Session

**Endpoint**: `DELETE /api/v1/sessions/:id`

**Response** (200 OK):
```json
{ "message": "Session … (gcsbrowser) terminated and removed from orchestrator." }
```

---

## Configuration

```bash
# Keep-Alive
GCSBROWSER_KEEP_ALIVE_ENABLED=true
GCSBROWSER_KEEP_ALIVE_INTERVAL_MINUTES=10
GCSBROWSER_DEFAULT_IDLE_TIMEOUT_MINUTES=20
GCSBROWSER_BOOT_TIMEOUT_SECONDS=90
GCSBROWSER_COMMAND_TIMEOUT_SECONDS=30
GCSBROWSER_RELAY_LOGIN_TIMEOUT_SECONDS=30
GCSBROWSER_STATE_DIR=/tmp/gcsbrowser-state   # private SSH key, temp cookies; 0700
```

---

## Data Model Changes

### Sessions Table

`provider = 'gcsbrowser'` is a new value. No schema change needed (metadata JSON column
already exists). `privateKey`/`publicKey` columns hold the persistent SSH keypair.

**Credential Fingerprint Constraint**:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_gcsbrowser_active_token
ON sessions (credentialFingerprint)
WHERE provider = 'gcsbrowser'
  AND credentialFingerprint IS NOT NULL
  AND COALESCE(status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED');
```

Note: `STOPPED` sessions are covered by the index (like Codespaces), so a STOPPED VM blocks
a second session on the same credential until it's woken or abandoned.

### vps Table

`provider = 'gcsbrowser'` added to `SUPPORTED_PROVIDERS` in `vps-credential-utils.js`.
`credentialcontent` holds the storageState JSON. Fingerprint = sha256 of canonicalized JSON.

---

## Error Handling

Standard error envelope `{ error, message, details }`, via `mapErrorToHttp`.

| Error Code | HTTP Status | Description |
|---|---|---|
| `GCSBROWSER_NO_CREDENTIAL` | 400 | No `x-gcsbrowser-credentials` / `credentialRef` |
| `GCSBROWSER_CREDENTIALS_INVALID` | 400 | storageState malformed / missing `cookies` |
| `GCSBROWSER_SESSION_EXPIRED` | 401 | Session cookies dead (validate → myaccount 302 / feed 401) |
| `GCSBROWSER_NOT_ELIGIBLE` | 403 | `/cloudshell/ca` denied |
| `GCSBROWSER_ALREADY_ACTIVE` | 409 | Non-terminal session exists for fingerprint |
| `GCSBROWSER_NOT_FOUND` | 404 | Environment absent |
| `GCSBROWSER_START_FAILED` | 500 | `setupsession` rejected (e.g. code 7: quota/limit/region) |
| `GCSBROWSER_START_TIMEOUT` | 504 | VM didn't reach RUNNING within boot timeout |
| `GCSBROWSER_RELAY_FAILED` | 502 | relay handshake failed (503 = missing auth cookie → re-auth) |
| `GCSBROWSER_COMMAND_TIMEOUT` | 504 | command exceeded timeout |
| `GCSBROWSER_SSH_FAILED` | 502 | ssh over relay failed (publickey → wrong user) |

---

## Dependencies

### System Dependencies
- `openssh-client` (already in Dockerfile)
- `python3` (already in Dockerfile) — for the `ProxyCommand` shim

### NPM Dependencies
- `ws` (new, pinned) — WebSocket client for the relay bridge. Alternative: hand-rolled
  RFC6455 (zero-dep) — decision recorded in the plan.

### Infrastructure
- Network egress to `shell.cloud.google.com`, `ssh.cloud.google.com`, and the
  `970-<host>.cloudshell.dev` relay host

---

## Testing Requirements

### Unit Testing
- Cookie store / redirect-following: cookie survives 302 chain (newtoken, ca)
- Fingerprint stability: same JSON → same sha256; whitespace-insensitive
- State mapping (1/2/3 → STOPPED/STARTING/RUNNING)
- `setupsession` body shape: `[null,null,[2,<blob>],["default"]]`
- Error-code mapping table

### Integration Testing
- End-to-end create → RUNNING with real credential (LAB-14 environment)
- `exec -- 'ls'` returns home-dir listing
- Auto-wake a STOPPED env, run a command
- `terminate-all` + `abandon`; verify `environments/get` returns state 1
- Keep-alive keeps VM alive across idle window
- Token refresh: let access token expire, confirm re-auth + retry works
- One-active-per-fingerprint (409 on second session)

### Error Handling Testing
- Expired cookies → `GCSBROWSER_SESSION_EXPIRED`
- Malformed storageState → 400
- `cloudshelluser` username → translated to clear SSH error
- `503` relay → auto re-auth and retry

### Performance Testing
- Warm create < 15s; command < 10s
- Keep-alive < 10s

---

## Documentation Requirements

- Update `project-overview.md` provider table (add `gcsbrowser`)
- Document how to capture a browser session (`ai-brain/google/google-auth.js`) and seed it
  into `vps` (`seed-credentials.js`)
- Document the relay-only SSH constraint and the account-name username requirement
- Note the 50h/week quota and 12h session cap in the provider's limits output

---

## Success Metrics

- [ ] `POST /sessions {provider:'gcsbrowser'}` returns RUNNING with a real credential
- [ ] `command` executes in the VM and returns output
- [ ] Keep-alive prevents idle suspend
- [ ] Termination + `abandon` verified (closes the LAB-14 §11 untested gap)
- [ ] One active session per fingerprint enforced
- [ ] No credential material leaks in logs/responses

---

## Out of Scope

- ❌ Modifying the existing `gcs` (service-account) provider — both coexist
- ❌ Creating a *new* Cloud Shell environment (Cloud Shell is singleton `default` per
  account) — only start/stop/adopt
- ❌ Interactive PTY sessions via the orchestrator API (use `shell` in
  `scripts/cloudshell` or the browser)
- ❌ Port forwarding through the relay
- ❌ Managing the 50h weekly quota (documented, not enforced)
- ❌ Non-default environments / ephemeral environments

---

## Assumptions

1. The user's browser session stays valid for the life of a session (cookies rotate; the
   provider re-validates on failure and reports `GCSBROWSER_SESSION_EXPIRED` clearly)
2. `shell.cloud.google.com` and the relay surface remain reachable and stable
3. One Cloud Shell environment per Google account (`default`)
4. The account has Cloud Shell eligibility (`/cloudshell/ca` → 200)
5. Docker is present in the Cloud Shell VM (verified in LAB-14)

---

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Cloud Shell web RPC surface changes | High | Isolate in one client module; clear error codes; LAB-14 doc is the contract reference |
| Session cookies expire mid-session | Medium | Detect via validate/403; surface `GCSBROWSER_SESSION_EXPIRED`; document re-auth |
| Access token expiry mid-command | Medium | Lazy refresh + `503`→re-auth retry |
| `abandon` teardown untested | Medium | This feature tests it (success metric); fallback = idle-out |
| 50h/week quota exhaustion | Medium | Expose limits; document; don't auto-enforce |
| Relay host binding to a stale zone | Low | Always read host/IP from `environments/get`, never cache zone |

---

## Acceptance Criteria

This feature is considered complete when:

- [ ] `gcsbrowser` provider registered and listed in `/providers/supported`
- [ ] `x-gcsbrowser-credentials` + `credentialRef` accepted; storageState validated
- [ ] Session creation returns RUNNING against a real credential
- [ ] `command` returns live output from the VM (Docker included)
- [ ] STOPPED env auto-wakes on command
- [ ] Keep-alive keeps the VM alive across an idle window
- [ ] `terminate-all` + `abandon` verified to stop the VM
- [ ] One-active-per-fingerprint enforced
- [ ] VPS status + `available-credential` support `gcsbrowser`
- [ ] Credentials list endpoint works
- [ ] Documentation updated (project-overview, README)
- [ ] No credential material in logs or API responses
- [ ] Code review completed

---

## References

- **Research Document**: `ai/LAB-14_google-cloudshell/research.md`
- **Prototype**: `scripts/cloudshell/cloudshell.py` (working client)
- **Provider reference**: `src/services/providers/codespaces-provider.js`,
  `codesandbox-provider.js`, `gcs-provider.js`
- **Base Provider Interface**: `src/services/providers/base-provider.js`
- **VPS credential machinery**: `src/services/vps-credential-utils.js`,
  `src/services/db-credentials-loader.js`, `scripts/seed-credentials.js`
- **Google Cloud Shell quota/limits**: https://cloud.google.com/shell/docs/quotas-limits

---

**Specification Version**: 1.0
**Last Updated**: 2026-10-24
**Author**: System Architect
**Reviewers**: TBD
**Approvers**: TBD
