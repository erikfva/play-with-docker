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
- Request accepts credentials via `x-codespaces-credentials` header or `credentialRef` body parameter
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
  - `machine`: Machine type (default: `standardLinux`)
  - `geo`: Geographic region (`UsEast`, `UsWest`, `EuropeWest`, `SoutheastAsia`)
  - `idleTimeoutMinutes`: Idle timeout configuration (default: 30)
  - `displayName`: User-friendly session name
  - `keepAlive`: Per-session keep-alive override (boolean). Precedence: per-session `keepAlive` → `CODESPACES_KEEP_ALIVE_ENABLED` env var → provider default (`true`)
- System enforces one active session per credential fingerprint (token uniqueness)
- Attempting to create duplicate session with same active token returns existing session
- Response includes session ID, web URL, SSH command, and connection details
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
- `GET /api/v1/sessions/:id` refreshes state from GitHub API only when the state cache TTL (default: 30 seconds) has expired
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
- Command execution automatically starts stopped codespaces before execution; boot time is excluded from the command timeout (separate 90-second boot timeout, then 30-second command timeout)
- Response includes stdout, stderr, and exit code
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
- System calls GitHub API DELETE endpoint for codespace removal
- Termination is asynchronous (202 Accepted response)
- Session status updated to `TERMINATED` in local database
- Stopped sessions (`STOPPED`) are distinct from terminated sessions: they are preserved in the database across server restarts and remain restorable
- Terminated sessions removed from active session list
- Keep-alive timers canceled upon termination

---

### FR-8: Keep-Alive Mechanism
**As a** system  
**I want** to automatically keep active Codespaces sessions alive  
**So that** they don't shut down due to idle timeout

**Acceptance Criteria**:
- Keep-alive enabled by default for Codespaces provider
- Precedence rules (highest to lowest): per-session `metadata.keepAlive` override → `CODESPACES_KEEP_ALIVE_ENABLED` env var (admin policy) → provider default (`enabled`)
- Keep-alive interval set to 20 minutes (10 minutes before 30-minute default timeout)
- Keep-alive executes a lightweight command via GitHub CLI
- Keep-alive wake operations use a boot-aware timeout (up to 90 seconds)
- Failed keep-alive attempts (3 consecutive failures) mark session as `FAILED`
- Keep-alive timers restored on server restart for surviving database sessions
- Keep-alive can be disabled via configuration environment variable
- Keep-alive skips sessions in non-active states (`STOPPED`, `TERMINATED`, `FAILED`)

---

### FR-9: Session Listing and Filtering
**As a** API user  
**I want** to list and filter Codespaces sessions  
**So that** I can manage multiple sessions effectively

**Acceptance Criteria**:
- `GET /api/v1/sessions` includes Codespaces sessions alongside other providers
- Query parameter `?provider=codespaces` filters to only Codespaces sessions
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
- Credentials required for proper GitHub API authentication during cleanup
- Response reports successful and failed terminations

---

## Non-Functional Requirements

### NFR-1: Performance
- Session creation completes within 60 seconds (GitHub API dependent)
- Command execution responds within 5 seconds for simple commands on warm codespaces
- Cold-start command execution completes within 90 seconds (boot time excluded from command timeout)
- State refresh operations complete within 3 seconds
- State caching (30-second TTL) reduces GitHub API calls by ~95% under normal polling
- Keep-alive operations complete within 10 seconds (up to 90 seconds when waking a stopped codespace)

### NFR-2: Reliability
- System handles GitHub API rate limits gracefully with exponential backoff
- Failed API calls retry up to 3 times before marking operation as failed
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
GitHub API enforces rate limits (5,000 requests/hour for authenticated users). The system must implement a state cache with a 30-second TTL as the primary mitigation, invalidate the cache on state-changing operations (start, stop, delete), and avoid excessive API calls.

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
  "machine": "standardLinux",
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
  "envName": "Development Environment",
  "sshCommand": "gh codespace ssh -c octocat-play-with-docker-abc123",
  "webHost": "https://octocat-play-with-docker-abc123.github.dev",
  "status": "RUNNING",
  "createdAt": "2026-08-02T05:30:00Z",
  "metadata": {
    "machine": "standardLinux",
    "cpus": 4,
    "memoryGB": 16,
    "storageGB": 64,
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
  "stdout": "Hello from Docker!\n...",
  "stderr": "",
  "exitCode": 0,
  "executedAt": "2026-08-02T05:35:00Z"
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
      "ref": "codespaces/account-1.json",
      "username": "octocat",
      "lastModified": "2026-08-01T10:00:00Z"
    },
    {
      "ref": "codespaces/token.txt",
      "username": null,
      "lastModified": "2026-07-30T14:30:00Z"
    }
  ]
}
```

---

## Configuration

### Environment Variables

```bash
# Template Repository
CODESPACES_DEFAULT_REPOSITORY_ID=1296269

# Defaults
CODESPACES_DEFAULT_MACHINE=standardLinux
CODESPACES_DEFAULT_GEO=UsWest
CODESPACES_DEFAULT_IDLE_TIMEOUT_MINUTES=30
CODESPACES_DEFAULT_RETENTION_PERIOD_MINUTES=43200

# Keep-Alive
CODESPACES_KEEP_ALIVE_ENABLED=true
CODESPACES_KEEP_ALIVE_INTERVAL_MINUTES=20

# State Cache
CODESPACES_STATE_CACHE_TTL_SECONDS=30
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
- `FAILED` / `TERMINATED` / `DELETED`: terminal states; removed from the active-session list
- Keep-alive recovery on startup must not delete `STOPPED` sessions (see FR-8: keep-alive skips non-active states)

**Credential Fingerprint Constraint**:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_codespaces_active_token
ON sessions (credentialFingerprint)
WHERE provider = 'codespaces'
  AND credentialFingerprint IS NOT NULL
  AND COALESCE(status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED');
```

**Metadata Field Usage**:
The existing `metadata` JSON field will store Codespaces-specific information:
```json
{
  "githubState": "Available",
  "machine": "standardLinux",
  "cpus": 4,
  "memoryGB": 16,
  "storageGB": 64,
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

**`webHost` Semantics**: For Codespaces, `webHost` maps to GitHub's `web_url`, which is the VS Code web IDE URL (`.github.dev`), not an SSH/shell host. The actual `webHost` (SSH-accessible endpoint) is `null` for this provider; connection is via `gh codespace ssh`. The web IDE URL is additionally exposed as `metadata.webIdeUrl` with a clearer name, and the UI should treat it as an IDE link, not an SSH target.

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
| `CODESPACES_ALREADY_ACTIVE` | 409 | Active session already exists for this token |
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
- Token uniqueness constraint enforcement
- Credential discovery endpoint returns valid data
- Concurrent command execution with different tokens must not leak credentials (per-spawn env isolation)
- Cold-start command execution (auto-start of stopped codespace) completes within the boot-aware timeout
- Rate limit exhaustion prevention via state cache (TTL respected, cache invalidated on state-changing operations)
- Stopped sessions preserved across simulated server restart (not deleted by keep-alive recovery)

### Error Handling Testing
- Invalid token returns 401 with clear message
- Expired token detected and reported
- Rate limit exceeded triggers backoff and retry
- Network failures handled gracefully
- Duplicate session creation returns existing session
- Missing per-session credential returns `CODESPACES_NO_CREDENTIAL` (no silent fallback)
- Codespace boot exceeding the boot timeout returns `CODESPACES_START_TIMEOUT`

### Performance Testing
- 50 concurrent sessions managed without degradation
- Keep-alive operations complete within timeout
- Command execution latency acceptable (<5 seconds on warm codespaces; <90 seconds on cold starts)
- State cache reduces GitHub API calls by ~95% under normal polling (rate limit stays within budget)

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
| Rate limiting impacting functionality | Medium | Implement caching, backoff strategies, request batching |
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
- [ ] State cache verified: rate limit stays within budget under normal polling (30-second TTL)
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
