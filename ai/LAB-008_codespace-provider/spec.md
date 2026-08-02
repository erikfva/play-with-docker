# LAB-008: GitHub Codespaces Provider Integration

**Issue Type**: New Feature  
**Priority**: Medium  
**Component**: Provider System  
**Labels**: provider, github-codespaces, integration  
**Epic**: Multi-Provider VM Orchestration  

---

## Summary

Add GitHub Codespaces as a new provider to the play-with-docker orchestrator, enabling users to provision and manage cloud-hosted development environments with full Docker support through GitHub's infrastructure.

---

## Background

The orchestrator currently supports Google Cloud Shell (`gcs`) and CodeSandbox (`codesandbox`) as VM session providers. GitHub Codespaces offers a widely-used, mature cloud development environment platform with native Docker support and tight GitHub integration. Adding Codespaces as a provider will expand the orchestrator's capabilities and provide users with an additional option for temporary VM sessions.

---

## Business Value

- **Expanded Provider Options**: Give users choice in VM providers based on their preferences and existing GitHub integration
- **Native Docker Support**: Codespaces provides built-in Docker via devcontainer features without requiring proxy configurations
- **GitHub Ecosystem Integration**: Leverage existing GitHub authentication and repository infrastructure
- **Developer Familiarity**: Many developers already use Codespaces, reducing learning curve
- **Cost Flexibility**: Per-minute billing model provides cost-effective option for short-lived sessions

---

## Functional Requirements

### FR-1: Provider Registration
**As a** system administrator  
**I want** GitHub Codespaces registered as a supported provider  
**So that** users can select it when creating sessions

**Acceptance Criteria**:
- Provider identifier `codespaces` is registered in the provider factory
- Provider appears in the `GET /api/v1/sessions/providers/supported` endpoint response
- Provider follows the same interface contract as existing providers (`gcs`, `codesandbox`)

---

### FR-2: Authentication and Credential Management
**As a** API user  
**I want** to authenticate with GitHub Codespaces using Personal Access Tokens  
**So that** I can create and manage codespace sessions

**Acceptance Criteria**:
- System accepts GitHub Personal Access Tokens (PAT) with `codespace` scope
- Credentials stored in S3 bucket under `codespaces/` folder or local mount equivalent
- Credential file format supports both JSON (`{"token": "ghp_xxx"}`) and plain text (`ghp_xxx`)
- **Note:** The existing `listAvailableCredentials` helper and the CodeSandbox credentials loader both filter/parse `.json` files only. Supporting `.txt` credential files requires: (1) updating `credentials-lister.js` to include `.txt` in the file filter, and (2) the Codespaces credentials loader to detect plain-text files and read the token directly rather than parsing JSON.
- Request accepts credentials via `x-codespaces-credentials` header or `credentialRef` body parameter
- Credential references are resolved to token bytes through the same storage resolver used by existing providers, active across all three storage modes (S3 object, s3fs mount, local filesystem), mirroring how the existing providers resolve a ref
- System validates token before session creation by calling GitHub API
- Credential presence is validated before any GitHub API call; missing credentials fail immediately with `CODESPACES_NO_CREDENTIAL` (no fallback token is used)
- Invalid or expired tokens return clear error messages (401/403)
- Credential fingerprinting implemented using SHA-256 hash of token

---

### FR-3: Credential Discovery
**As a** API user  
**I want** to list available GitHub Codespaces credentials  
**So that** I can select the appropriate credential for session creation

**Acceptance Criteria**:
- New endpoint `GET /api/v1/sessions/codespaces-credentials` returns available credentials
- Response includes credential reference paths and metadata (excluding actual tokens)
- Endpoint requires server token authorization
- Lists credentials from active storage mode (S3, s3fs mount, or local)

---

### FR-4: Session Creation
**As a** API user  
**I want** to create a new GitHub Codespaces session  
**So that** I can provision a cloud VM for temporary use

**Acceptance Criteria**:
- `POST /api/v1/sessions` with `{"provider": "codespaces"}` creates a Codespaces session
- System uses a default template repository for codespace provisioning
- Default template repository includes Docker support via devcontainer configuration
- Session creation accepts optional parameters:
  - `machine`: Machine type (default: `basicLinux32gb`). Valid values: `basicLinux32gb`, `standardLinux32gb`, `standardLinux`, `premiumLinux`, `largePremiumLinux`, `xLargePremiumLinux`
  - `geo`: Geographic region (`UsEast`, `UsWest`, `EuropeWest`, `SoutheastAsia`)
  - Invalid `machine` or `geo` values are rejected with `400` before any GitHub API call; valid enums are listed in the Configuration section and validated against it
  - `idleTimeoutMinutes`: Idle timeout configuration (default: 30)
  - `displayName`: User-friendly session name
  - `keepAlive`: Per-session keep-alive override (boolean). Precedence: per-session `keepAlive` → `CODESPACES_KEEP_ALIVE_ENABLED` env var → provider default (`true`)
  - `idleTimeoutMinutes` interacts with keep-alive: the effective keep-alive interval for a session is derived as `min(configured keep-alive interval, per-session idleTimeoutMinutes - 10)` so keep-alive fires before the idle timeout regardless of custom values (see FR-8)
- System enforces one active session per credential fingerprint (token uniqueness)
- Attempting to create a session when an active session (`RUNNING`, `STARTING`, `PENDING`, `STOPPING`) already exists for the token returns `409 CODESPACES_ALREADY_ACTIVE`
- Attempting to create a session when a `STOPPED` session exists for the token: the stopped codespace is deleted via GitHub API first, the local DB row is removed, then a fresh session is created normally
- Response includes `{ id, provider, providerSessionId, status }`. Full details (SSH command, web IDE URL, metadata) are available via `GET /api/v1/sessions/:id`. The top-level `webHost` is `null` for this provider — see `webHost` Semantics.
- Session stored in PostgreSQL `sessions` table with `provider='codespaces'`

---

### FR-5: Session State Management
**As a** system  
**I want** to accurately track and report codespace session states  
**So that** users and keep-alive services can respond appropriately

**Acceptance Criteria**:
- System maps GitHub Codespaces states to orchestrator status values (complete 17-state map):
  - `Available`, `Awaiting`, `Exporting` → `RUNNING`
  - `Starting` → `STARTING`
  - `ShuttingDown` → `STOPPING`
  - `Shutdown`, `Archived`, `Unavailable`, `Moved` → `STOPPED`
  - `Created`, `Provisioning`, `Queued`, `Unknown`, `Updating`, `Rebuilding` → `PENDING`
  - `Failed` → `FAILED`
  - `Deleted` → `TERMINATED`
- Unmapped or unknown future states default to `PENDING` and are logged to detect GitHub API changes
- `GET /api/v1/sessions/:id` refreshes state from GitHub API on every request (no caching in v1)
- **Note:** A 30-second TTL state cache is a future optimization. In v1, every refresh hits the GitHub API directly. With the default keep-alive interval of 20 minutes and typical polling patterns, the 5,000 req/hr rate limit is not expected to be a concern at low session counts. Rate limit handling (429 backoff) remains required for reliability.
- Session metadata includes GitHub-specific fields (`state`, `web_url`, `machine`, `idle_timeout_minutes`)
- System handles transient states appropriately during state transitions

---

### FR-6: Command Execution
**As a** API user  
**I want** to execute remote commands in a Codespaces session  
**So that** I can interact with the VM environment

**Acceptance Criteria**:
- `POST /api/v1/sessions/:id/command` executes commands in Codespaces VM
- System uses GitHub CLI (`gh codespace ssh`) for command execution
- Command execution automatically starts stopped codespaces before execution; boot time is excluded from the command timeout (separate 90-second boot timeout, then 30-second command timeout). Auto-start logic is encapsulated inside `executeCommand` — no new `startSession` method is added to `BaseProvider`.
- Auto-start scoping: automatic start applies only to `STOPPED` sessions. `FAILED` and `TERMINATED` sessions reject command execution with a clear error and are never auto-started
- Response includes `output` (combined stdout/stderr) consistent with the existing command response contract across all providers
- Command execution timeout is configurable (default: 30 seconds for warm codespaces)
- Failed commands return appropriate error messages without crashing the session
- Docker commands work out-of-the-box without additional configuration

---

### FR-7: Session Termination
**As a** API user  
**I want** to gracefully terminate a Codespaces session  
**So that** I can clean up resources when no longer needed

**Acceptance Criteria**:
- `DELETE /api/v1/sessions/:id` terminates the codespace
- **Per-provider branching:** the termination flow branches on provider **in the route handler**, not inside `terminateSession`. For `codespaces`, after `provider.terminateSession(row)` succeeds, the route runs `UPDATE sessions SET status = 'TERMINATED' WHERE id = row.id` instead of `DELETE FROM sessions WHERE id = row.id`. For all other providers, existing hard-delete + 200 behavior is unchanged. Existing tests are unaffected.
- System calls GitHub API DELETE endpoint for codespace removal
- Termination is asynchronous on GitHub's side (GitHub DELETE returns 202); the orchestrator returns 200 once GitHub confirms removal, consistent with the existing route contract
- **Ordering:** for `codespaces`, the GitHub codespace MUST be deleted via API before the PostgreSQL row is removed; the local row is only cleared after GitHub confirms removal (a 404 on a prior deletion is treated as already-deleted and safe to clear)
- Session status updated to `TERMINATED` in local database
- Stopped sessions (`STOPPED`) are distinct from terminated sessions: they are preserved in the database across server restarts and remain restorable
- Terminated sessions removed from active session list
- Keep-alive timers canceled upon termination; keep-alive stats are cleared from memory regardless of whether the DB row is hard-deleted or transitioned to `TERMINATED`

---

### FR-8: Keep-Alive Mechanism
**As a** system  
**I want** to automatically keep active Codespaces sessions alive  
**So that** they don't shut down due to idle timeout

**Acceptance Criteria**:
- Keep-alive enabled by default for Codespaces provider
- Precedence rules (highest to lowest): per-session `metadata.keepAlive` override → `CODESPACES_KEEP_ALIVE_ENABLED` env var → provider default (`enabled`). The env var sets the *default* only when a request provides no per-session value; it is NOT a hard admin lock — an explicit per-session `keepAlive` always wins
- Keep-alive interval set to 20 minutes (10 minutes before 30-minute default timeout)
- Effective keep-alive interval per session = `min(configured interval, session idleTimeoutMinutes - 10)`, so a custom short idle timeout never lets the codespace idle-shutdown before the next keep-alive fires
- Keep-alive executes a lightweight command via GitHub CLI
- Keep-alive wake operations use a boot-aware timeout (up to 90 seconds)
- Failed keep-alive attempts (3 consecutive failures) mark session as `FAILED`
- Keep-alive timers restored on server restart for surviving database sessions
- Keep-alive can be disabled via configuration environment variable
- Keep-alive skips sessions in non-active states (`STOPPED`, `STOPPING`, `TERMINATED`, `FAILED`)
- **`runOnStart` behavior:** keep-alive does NOT fire immediately on session creation or recovery (`runOnStart: false`). The first keep-alive fires after the configured interval. This avoids a redundant wake on a freshly-created `RUNNING` session and prevents all recovered sessions from firing simultaneously on restart.
- **Startup recovery behavior for `STOPPED` sessions:** the recovery service checks `sessionRow.status` before calling `isSessionActive`. Sessions with `status = 'STOPPED'` are preserved unconditionally — the row is kept, keep-alive is skipped, and `isSessionActive` is never called for them. Only sessions in non-terminal active states (`RUNNING`, `STARTING`, `PENDING`, `STOPPING`) proceed to the `isSessionActive` check. If `isSessionActive` returns `false` for those, the session is stale and must be cleaned up (GitHub API delete first, then DB row removal per delete-ordering rules).
- When keep-alive startup-recovery determines a session is stale and must be cleaned up, it MUST first terminate/delete the corresponding GitHub Codespace via the API (if it still exists) before deleting the PostgreSQL row, to avoid orphaned remote resources (see Data Model: Delete ordering)

---

### FR-9: Session Listing and Filtering
**As a** API user  
**I want** to list and filter Codespaces sessions  
**So that** I can manage multiple sessions effectively

**Acceptance Criteria**:
- `GET /api/v1/sessions` includes Codespaces sessions alongside other providers
- Query parameter `?provider=codespaces` filters to only Codespaces sessions. **Note:** the current route only supports `?status=` filtering; `?provider=` requires adding a filter clause to the `GET /sessions` route handler.
- Query parameter `?status=RUNNING` filters to active Codespaces sessions
- Response includes provider-specific metadata for each session

---

### FR-10: Bulk Termination
**As a** API user  
**I want** to terminate all active sessions  
**So that** I can quickly clean up resources

**Acceptance Criteria**:
- `POST /api/v1/sessions/terminate-all` includes Codespaces sessions in termination
- All active Codespaces sessions terminated via GitHub API
- Per-provider branching: for `codespaces` sessions the route runs `UPDATE sessions SET status = 'TERMINATED' WHERE id = row.id` (not hard-delete) after `provider.terminateSession` succeeds; the GitHub delete runs first inside `terminateSession`. Other providers keep their existing hard-delete + 200 behavior.
- Credentials are loaded from the stored `credentialRef` on each session row — not from request headers. No credential header is required on the `terminate-all` request.
- Response reports successful and failed terminations

---

## Non-Functional Requirements

### NFR-1: Performance
- Session creation completes within 60 seconds (GitHub API dependent)
- Command execution responds within 5 seconds for simple commands on warm codespaces
- Cold-start command execution completes within 90 seconds (boot time excluded from command timeout)
- State refresh operations complete within 3 seconds
- No state caching in v1; rate limit headroom is sufficient at low session counts
- Keep-alive operations complete within 10 seconds for warm sessions; up to 90 seconds when waking a stopped codespace (boot-aware timeout)

### NFR-2: Reliability
- System handles GitHub API rate limits gracefully with exponential backoff
- Retry logic is implemented in the GitHub API client wrapper (`codespaces/client.js`), limited to `GET` requests and explicit 429 responses only. `POST` and `DELETE` requests are not retried automatically to avoid duplicate side effects.
- Backoff sequence: 1s → 2s → 4s (3 attempts total before surfacing `CODESPACES_RATE_LIMIT_EXCEEDED`)
- Transient network errors don't permanently break session state
- Token expiration detected and reported with clear error messages

### NFR-3: Scalability
- Support concurrent management of 50+ Codespaces sessions per orchestrator instance
- Keep-alive mechanism scales without performance degradation
- Database queries optimized for credential fingerprint lookups

### NFR-4: Security
- Personal Access Tokens never logged or exposed in API responses
- Token isolation via per-spawn environment variables: credentials are passed per `gh` invocation, never via shared/global `process.env.GH_TOKEN` mutation
- No fallback credentials: operations fail immediately with `CODESPACES_NO_CREDENTIAL` if the per-session token is unavailable
- Credential files stored with restricted permissions
- GitHub API communication uses HTTPS exclusively
- Token validation performed before any destructive operations

### NFR-5: Maintainability
- Code follows existing provider architecture patterns
- Provider implementation isolated in dedicated module
- Configuration driven by environment variables
- Comprehensive error logging for debugging

### NFR-6: Compatibility
- GitHub CLI (`gh`) version 2.40.0 or higher required
- Compatible with GitHub API version 2026-03-10
- Works with all credential modes (S3, s3fs, local)
- Supports both x86_64 and arm64 architectures for container deployment

---

## Technical Constraints

### TC-1: Repository Dependency
GitHub Codespaces requires a GitHub repository context for creation. The system must maintain a default template repository or allow users to specify repositories.

### TC-2: GitHub CLI Dependency
Command execution requires GitHub CLI (`gh`) installed in the orchestrator container. This adds a system-level dependency that must be managed in the Docker image.

### TC-3: Token Uniqueness
GitHub Codespaces will enforce one active session per credential token via database constraint, consistent with CodeSandbox provider behavior.

### TC-4: Rate Limiting
GitHub API enforces rate limits (5,000 requests/hour for authenticated users). In v1, no state cache is implemented; each `GET /api/v1/sessions/:id` call hits the GitHub API directly. The system must implement exponential backoff on 429 responses. A state cache (30-second TTL) is deferred to a future iteration.

### TC-5: Cost Implications
GitHub Codespaces incurs per-minute compute costs. Users must be aware of billing implications, though this is outside the orchestrator's direct control.

---

## API Specification

### Create Codespaces Session

**Endpoint**: `POST /api/v1/sessions`

**Headers**:
```
x-server-token: <SERVER_TOKEN>
x-codespaces-credentials: codespaces/token.json
Content-Type: application/json
```

**Request Body**:
```json
{
  "provider": "codespaces",
  "machine": "basicLinux32gb",
  "geo": "UsWest",
  "idleTimeoutMinutes": 30,
  "displayName": "Development Environment",
  "keepAlive": true
}
```

**Response** (201 Created):
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "provider": "codespaces",
  "providerSessionId": "octocat-play-with-docker-abc123",
  "status": "RUNNING"
}
```

Full session details (including `sshCommand`, `metadata.webIdeUrl`, `webHost`) are available via `GET /api/v1/sessions/:id` after creation. The create response is intentionally minimal and consistent with all existing providers.

---

### Execute Command in Codespace

**Endpoint**: `POST /api/v1/sessions/:id/command`

**Headers**:
```
x-server-token: <SERVER_TOKEN>
Content-Type: application/json
```

**Request Body**:
```json
{
  "command": "docker run hello-world"
}
```

**Response** (200 OK):
```json
{
  "output": "Hello from Docker!\n..."
}
```

---

### List Codespaces Credentials

**Endpoint**: `GET /api/v1/sessions/codespaces-credentials`

**Headers**:
```
x-server-token: <SERVER_TOKEN>
```

**Response** (200 OK):
```json
{
  "credentials": [
    {
      "key": "codespaces/account-1.json",
      "displayName": "account-1.json"
    },
    {
      "key": "codespaces/token.json",
      "displayName": "token.json"
    }
  ],
  "mode": "s3-api",
  "default": ""
}
```

Response shape is identical to the existing `google-credentials` and `codesandbox-credentials` endpoints — uses `listAvailableCredentials('codespaces')` directly. No per-file reading or enrichment in v1.

---

### Get Codespaces Session

**Endpoint**: `GET /api/v1/sessions/:id`

**Headers**:
```
x-server-token: <SERVER_TOKEN>
```

**Response** (200 OK):
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "provider": "codespaces",
  "providerSessionId": "octocat-play-with-docker-abc123",
  "status": "RUNNING",
  "webHost": null,
  "createdAt": "2026-08-02T05:30:00Z",
  "metadata": {
    "githubState": "Available",
    "machine": "basicLinux32gb",
    "cpus": 2,
    "memoryGB": 8,
    "storageGB": 32,
    "idleTimeoutMinutes": 30,
    "location": "WestUs2",
    "webIdeUrl": "https://octocat-play-with-docker-abc123.github.dev",
    "keepAlive": {
      "enabled": true,
      "intervalMinutes": 20
    }
  }
}
```

The `GET /:id` response is the authoritative full-detail view referenced by FR-4 (create returns only `{ id, provider, providerSessionId, status }`).

---

### Delete Codespaces Session

**Endpoint**: `DELETE /api/v1/sessions/:id`

**Headers**:
```
x-server-token: <SERVER_TOKEN>
```

**Behavior** (per-provider branching): for `codespaces`, the route calls `provider.terminateSession(row)` which deletes the GitHub codespace via API (GitHub returns 202; a 404 means already-deleted and is treated as success). On success the route runs `UPDATE sessions SET status = 'TERMINATED' WHERE id = row.id` and returns:

**Response** (200 OK):
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "provider": "codespaces",
  "providerSessionId": "octocat-play-with-docker-abc123",
  "status": "TERMINATED"
}
```

Keep-alive timers for the session are canceled on termination.

---

### Bulk Termination

**Endpoint**: `POST /api/v1/sessions/terminate-all`

**Headers**:
```
x-server-token: <SERVER_TOKEN>
```

**Behavior**: terminates every active Codespaces session. Credentials are loaded from each row's stored `credentialRef` (no credential header required). For `codespaces` rows, after `provider.terminateSession(row)` succeeds the route runs `UPDATE sessions SET status = 'TERMINATED' WHERE id = row.id` (not hard-delete). Other providers keep existing hard-delete behavior.

**Response** (200 OK):
```json
{
  "terminated": [
    { "id": "550e8400-e29b-41d4-a716-446655440000", "provider": "codespaces", "status": "TERMINATED" }
  ],
  "failed": []
}
```

---

## Configuration

### Environment Variables

```bash
# Template Repository
CODESPACES_DEFAULT_REPOSITORY_ID=1296269

# Defaults
CODESPACES_DEFAULT_MACHINE=basicLinux32gb
CODESPACES_DEFAULT_GEO=UsWest
CODESPACES_DEFAULT_IDLE_TIMEOUT_MINUTES=30
CODESPACES_DEFAULT_RETENTION_PERIOD_MINUTES=43200

# Allowed enums (validated before GitHub API calls; invalid values -> 400)
# machine (GitHub values): basicLinux32gb (default), standardLinux32gb, standardLinux, premiumLinux, largePremiumLinux, xLargePremiumLinux
#   These are distinct GitHub machine types; no aliases or mapping is applied.
#   If omitted in the request, CODESPACES_DEFAULT_MACHINE is used.
# geo: UsEast, UsWest, EuropeWest, SoutheastAsia (default: CODESPACES_DEFAULT_GEO)

# Keep-Alive
CODESPACES_KEEP_ALIVE_ENABLED=true
CODESPACES_KEEP_ALIVE_INTERVAL_MINUTES=20
```

---

## Data Model Changes

### Sessions Table Schema Updates

**New Provider Value**:
```sql
-- Existing values: 'gcs', 'codesandbox', 'pwd'
-- Add: 'codespaces'
```

**Session Lifecycle & Persistence Rules**:
- `RUNNING` / `STARTING` / `STOPPING` / `PENDING`: active sessions, managed by keep-alive
- `STOPPED`: preserved in the database across server restarts; the codespace remains restorable via start
- `FAILED` / `TERMINATED`: terminal states; excluded from keep-alive and active operations. For the `codespaces` provider, `TERMINATED` rows are **retained in the database** (not hard-deleted); for all other providers, terminal rows are hard-deleted as before.
- Keep-alive recovery on startup must not delete `STOPPED` sessions (see FR-8: keep-alive skips non-active states)
- **Delete ordering (no orphans):** any path that removes a Codespaces session row from PostgreSQL **must first terminate/delete the underlying GitHub Codespace via the API**, and only then delete the local row. Never delete the PG row while the remote codespace still exists (dangling, potentially still-billing resource). This applies to `DELETE /api/v1/sessions/:id`, `POST /api/v1/sessions/terminate-all`, and the keep-alive startup-recovery cleanup path. If the remote codespace is already gone (GitHub returned 404 on DELETE), proceed with the local deletion.

**Credential Fingerprint Constraint**:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_codespaces_active_token
ON sessions (credentialFingerprint)
WHERE provider = 'codespaces'
  AND credentialFingerprint IS NOT NULL
  AND COALESCE(status, '') NOT IN ('TERMINATED', 'FAILED');
```

Note: `STOPPED` sessions are intentionally covered by this index. When `createSession` encounters an existing `STOPPED` session for the token, it deletes the stopped codespace via GitHub API, removes the local DB row, then proceeds to create a fresh session. `DELETED` is not a valid status for the `codespaces` provider; only `TERMINATED` is used for that terminal state.

**Metadata Field Usage**:
The existing `metadata` JSON field will store Codespaces-specific information:
```json
{
  "githubState": "Available",
  "machine": "basicLinux32gb",
  "cpus": 2,
  "memoryGB": 8,
  "storageGB": 32,
  "idleTimeoutMinutes": 30,
  "retentionPeriodMinutes": 43200,
  "location": "WestUs2",
  "lastUsedAt": "2026-08-02T05:35:00Z",
  "webIdeUrl": "https://octocat-play-with-docker-abc123.github.dev",
  "sshHost": null,
  "keepAlive": {
    "enabled": true,
    "intervalMinutes": 20
  }
}
```

**`webHost` Semantics**: For Codespaces, `webHost` is always `null`. This provider has no SSH-accessible shell host; connection is via `gh codespace ssh`. The VS Code web IDE URL (`.github.dev`) is exposed exclusively as `metadata.webIdeUrl` and must not be stored in `webHost`. Any consumer treating `webHost` as a shell target will find it null and should fall back to the `sshCommand` field.

---

## Error Handling

### Error Response Format

All errors follow the standard orchestrator error format:

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable error description",
  "details": {
    "provider": "codespaces",
    "sessionId": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

### Codespaces-Specific Error Codes

| Error Code | HTTP Status | Description |
|------------|-------------|-------------|
| `CODESPACES_TOKEN_INVALID` | 401 | GitHub PAT is invalid or expired |
| `CODESPACES_TOKEN_INSUFFICIENT_SCOPE` | 403 | Token lacks `codespace` scope |
| `CODESPACES_RATE_LIMIT_EXCEEDED` | 429 | GitHub API rate limit reached |
| `CODESPACES_CREATION_FAILED` | 500 | Failed to create codespace via GitHub API |
| `CODESPACES_NOT_FOUND` | 404 | Codespace not found in GitHub |
| `CODESPACES_ALREADY_ACTIVE` | 409 | Active session (`RUNNING`, `STARTING`, `PENDING`, `STOPPING`) already exists for this token |
| `CODESPACES_START_FAILED` | 500 | Failed to start stopped codespace |
| `CODESPACES_COMMAND_TIMEOUT` | 504 | Command execution exceeded timeout |
| `CODESPACES_START_TIMEOUT` | 504 | Codespace boot exceeded the 90-second boot timeout |
| `CODESPACES_NO_CREDENTIAL` | 401 | No valid per-session credential available (no fallback token) |
| `CODESPACES_CLI_NOT_INSTALLED` | 500 | GitHub CLI not available in container |
| `CODESPACES_REPOSITORY_NOT_CONFIGURED` | 500 | Template repository not configured |

---

## Dependencies

### System Dependencies
- **GitHub CLI (`gh`)**: Version 2.40.0 or higher
- **curl**: For GitHub CLI installation
- **OpenSSH client**: Already present for GCS provider

### NPM Dependencies
- **No new packages required** (uses shell execution for GitHub CLI)
- **Optional Enhancement**: `@octokit/rest` for pure API approach (future consideration)

### Infrastructure Dependencies
- **Template Repository**: GitHub repository with devcontainer configuration
- **GitHub API Access**: Internet connectivity to `api.github.com`
- **Docker Image Updates**: Dockerfile modifications to install GitHub CLI

---

## Testing Requirements

### Unit Testing
- Provider factory correctly instantiates Codespaces provider
- Credential loading from all storage modes (S3, s3fs, local)
- State mapping from GitHub states to orchestrator statuses
- Session mapper transforms GitHub API responses correctly
- Token fingerprint generation produces consistent SHA-256 hashes

### Integration Testing
- End-to-end session creation with real GitHub API
- Command execution via GitHub CLI
- Session termination and cleanup
- Keep-alive mechanism prevents timeout
- Token uniqueness constraint enforcement:
  - Creating a session when an active session exists for the token returns `409 CODESPACES_ALREADY_ACTIVE`
  - Creating a session when a `STOPPED` session exists for the token: stopped codespace is deleted via GitHub API, local row is removed, fresh session is created
- Credential discovery endpoint returns valid data
- Concurrent command execution with different tokens must not leak credentials (per-spawn env isolation)
- Cold-start command execution (auto-start of stopped codespace) completes within the boot-aware timeout
- Rate limit exhaustion prevention via exponential backoff on 429 responses
- Stopped sessions preserved across simulated server restart: recovery skips `STOPPED` rows without calling `isSessionActive` and without deleting the DB row

### Error Handling Testing
- Invalid token returns 401 with clear message
- Expired token detected and reported
- Rate limit exceeded triggers backoff and retry
- Network failures handled gracefully
- Active duplicate session (same token, active status) returns `409 CODESPACES_ALREADY_ACTIVE`
- Missing per-session credential returns `CODESPACES_NO_CREDENTIAL` (no silent fallback)
- Codespace boot exceeding the boot timeout returns `CODESPACES_START_TIMEOUT`

### Performance Testing
- 50 concurrent sessions managed without degradation
- Keep-alive operations complete within timeout
- Command execution latency acceptable (<5 seconds on warm codespaces; <90 seconds on cold starts)

---

## Documentation Requirements

### User Documentation
- Add Codespaces provider to README.md supported providers list
- Document GitHub PAT creation and scope requirements
- Provide example API requests for Codespaces sessions
- Document credential file format and storage locations
- Explain token uniqueness constraint behavior

### Developer Documentation
- Architecture diagram including Codespaces provider flow
- Provider implementation guide following base-provider interface
- GitHub CLI command execution patterns
- State mapping reference table
- Keep-alive strategy explanation

### Operational Documentation
- Docker image build instructions including GitHub CLI installation
- Environment variable configuration guide
- Template repository setup and customization
- Troubleshooting guide for common GitHub API errors
- Rate limiting mitigation strategies

---

## Success Metrics

### Functional Metrics
- [ ] Codespaces provider successfully creates sessions
- [ ] Command execution works with Docker commands
- [ ] Keep-alive prevents idle timeout shutdowns
- [ ] Sessions terminate cleanly without orphaned resources
- [ ] Token uniqueness prevents duplicate sessions

### Performance Metrics
- Session creation time < 60 seconds (95th percentile)
- Command execution latency < 5 seconds (95th percentile)
- Keep-alive success rate > 99%
- API response time < 500ms for non-creation operations

### Reliability Metrics
- Zero credential leaks in logs or responses
- GitHub API error rate < 1%
- Session state accuracy > 99%
- Keep-alive recovery from transient failures

---

## Out of Scope

The following items are explicitly **not** included in this specification:

- ❌ Support for GitHub App authentication (only PATs in v1)
- ❌ User-provided repository support (only template repo in v1)
- ❌ Custom devcontainer configuration per request
- ❌ Port forwarding management via API
- ❌ Codespace prebuild support
- ❌ Organization-level Codespaces management
- ❌ VS Code extension integration
- ❌ JupyterLab opening via API
- ❌ Codespace export functionality
- ❌ Multi-repository devcontainer support
- ❌ Custom machine type definitions beyond GitHub defaults
- ❌ Billing/cost tracking integration

These features may be considered for future iterations.

---

## Assumptions

1. Users have access to GitHub accounts with Codespaces enabled
2. Users can create and manage GitHub Personal Access Tokens
3. Template repository exists and is publicly accessible
4. Docker image has sufficient permissions to install GitHub CLI
5. GitHub API maintains backward compatibility for v2026-03-10
6. Network connectivity to GitHub services is reliable
7. Users understand Codespaces incur compute costs
8. S3 bucket or local storage configured for credential storage

---

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| GitHub API changes breaking compatibility | High | Pin to specific API version, monitor deprecation notices |
| GitHub CLI installation failures | Medium | Pre-validate in CI/CD, include health checks |
| Rate limiting impacting functionality | Medium | Implement exponential backoff and retry strategies (v1); state cache deferred to future iteration |
| Template repository deletion | High | Use organization-owned repo, document backup procedures |
| Cost overruns from forgotten sessions | Low | Enforce aggressive timeouts, document billing implications |
| Token expiration mid-session | Medium | Validate token before operations, handle 401 gracefully |

---

## Acceptance Criteria

This feature is considered complete when:

- [ ] All functional requirements (FR-1 through FR-10) are implemented and tested
- [ ] All non-functional requirements (NFR-1 through NFR-6) are met
- [ ] GitHub Codespaces provider passes all unit and integration tests
- [ ] Documentation updated with Codespaces examples and configuration
- [ ] Template repository created and configured with Docker support
- [ ] Dockerfile updated to include GitHub CLI installation
- [ ] Environment variables documented and examples provided
- [ ] Keep-alive mechanism verified with 24+ hour test
- [ ] Token uniqueness constraint enforced in database
- [ ] API endpoints return correct responses for all success and error cases
- [ ] Provider appears in supported providers list
- [ ] Credential discovery endpoint functional
- [ ] Token isolation verified: concurrent command execution with different tokens does not leak credentials
- [ ] Stopped sessions verified preserved across server restart
- [ ] Code review completed and approved
- [ ] Feature deployed to staging environment and validated

---

## References

- **Research Document**: `ai/LAB-008_codespace-provider/research.md`
- **GitHub Codespaces REST API**: https://docs.github.com/en/rest/codespaces/codespaces
- **GitHub CLI Documentation**: https://cli.github.com/manual/gh_codespace_ssh
- **Base Provider Interface**: `src/services/providers/base-provider.js`
- **CodeSandbox Provider Reference**: `src/services/providers/codesandbox-provider.js`
- **Devcontainer Specification**: https://containers.dev/

---

**Specification Version**: 1.0  
**Last Updated**: 2026-08-02  
**Author**: System Architect  
**Reviewers**: TBD  
**Approvers**: TBD
