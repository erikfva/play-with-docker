# Research: GitHub Codespaces Provider Integration

**Date**: August 2, 2026  
**Objective**: Research and document how to add GitHub Codespaces as a new provider to the play-with-docker orchestrator

---

## 1. Overview

GitHub Codespaces provides cloud-hosted development environments powered by Visual Studio Code. Unlike the existing providers (Google Cloud Shell and CodeSandbox), Codespaces is deeply integrated with GitHub repositories and offers full Linux VMs with Docker support.

### Key Characteristics
- **Hosting**: GitHub-managed infrastructure
- **Access**: REST API + GitHub CLI (`gh`)
- **VM Type**: Full Linux containers with customizable machine types
- **Networking**: Web-based IDE, SSH access, and port forwarding
- **Lifecycle**: Create, start, stop, delete operations
- **Timeout**: Configurable idle timeout (default: 30 minutes)
- **Billing**: Per-minute billing model

---

## 2. GitHub Codespaces API

### 2.1 Authentication

**Token Requirements**:
- **Personal Access Token (classic)**: Requires `codespace` scope
- **Fine-grained PAT**: Requires "Codespaces" repository permissions (read/write)
- **GitHub App**: User access tokens with Codespaces permissions

**Token Format**:
```json
{
  "token": "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "type": "personal_access_token"
}
```

### 2.2 Core API Endpoints

**Base URL**: `https://api.github.com`

| Endpoint | Method | Purpose | Status Codes |
|----------|--------|---------|--------------|
| `/user/codespaces` | POST | Create codespace | 201, 202, 401, 403, 404, 503 |
| `/user/codespaces` | GET | List codespaces | 200, 304, 401, 403, 404, 500 |
| `/user/codespaces/{codespace_name}` | GET | Get codespace details | 200, 304, 401, 403, 404, 500 |
| `/user/codespaces/{codespace_name}` | PATCH | Update codespace | 200, 401, 403, 404 |
| `/user/codespaces/{codespace_name}` | DELETE | Delete codespace | 202, 304, 401, 403, 404, 500 |
| `/user/codespaces/{codespace_name}/start` | POST | Start codespace | 200, 304, 400, 401, 402, 403, 404, 409, 500 |
| `/user/codespaces/{codespace_name}/stop` | POST | Stop codespace | 200, 401, 403, 404, 500 |
| `/repos/{owner}/{repo}/codespaces` | POST | Create repo codespace | 201, 202, 401, 403, 404, 503 |

### 2.3 Response Schema

**Codespace Object**:
```json
{
  "id": 1,
  "name": "monalisa-octocat-hello-world-g4wpq6h95q",
  "environment_id": "26a7c758-7299-4a73-b978-5a92a7ae98a0",
  "owner": { "login": "octocat", "id": 1 },
  "billable_owner": { "login": "octocat", "id": 1 },
  "repository": {
    "id": 1296269,
    "name": "Hello-World",
    "full_name": "octocat/Hello-World"
  },
  "machine": {
    "name": "standardLinux",
    "display_name": "4 cores, 16 GB RAM, 64 GB storage",
    "operating_system": "linux",
    "storage_in_bytes": 68719476736,
    "memory_in_bytes": 17179869184,
    "cpus": 4
  },
  "created_at": "2021-10-14T00:53:30-06:00",
  "updated_at": "2021-10-14T00:53:32-06:00",
  "last_used_at": "2021-10-14T00:53:30-06:00",
  "state": "Available",
  "url": "https://api.github.com/user/codespaces/...",
  "web_url": "https://monalisa-octocat-hello-world-g4wpq6h95q.github.dev",
  "machines_url": "https://api.github.com/user/codespaces/.../machines",
  "start_url": "https://api.github.com/user/codespaces/.../start",
  "stop_url": "https://api.github.com/user/codespaces/.../stop",
  "idle_timeout_minutes": 60,
  "retention_period_minutes": 43200,
  "location": "WestUs2",
  "git_status": {
    "ahead": 0,
    "behind": 0,
    "has_unpushed_changes": false,
    "has_uncommitted_changes": false,
    "ref": "main"
  }
}
```

**State Values**:
- `Unknown` - Initial state
- `Created` - Provisioned but not started
- `Queued` - Waiting to start
- `Provisioning` - Being created
- `Available` - Running and accessible
- `Awaiting` - Waiting for user action
- `Unavailable` - Temporarily unavailable
- `Deleted` - Removed
- `Moved` - Migrated to different host
- `Shutdown` - Stopped
- `Archived` - Long-term stopped
- `Starting` - Boot in progress
- `ShuttingDown` - Stopping in progress
- `Failed` - Error state
- `Exporting` - Being exported
- `Updating` - Configuration change
- `Rebuilding` - Container rebuild

---

## 3. Command Execution Options

### 3.1 GitHub CLI (`gh codespace ssh`)

**Approach**: Execute via GitHub CLI installed on orchestrator host

**Pros**:
- Official GitHub tool
- Handles authentication automatically
- Built-in SSH connection management
- Simple command interface

**Cons**:
- Requires `gh` CLI installation in container
- External process dependency
- Harder to capture structured output

**Example**:
```bash
gh codespace ssh -c <codespace-name> -- <command>
```

**Implementation Pattern**:
```javascript
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

async function executeCommand(codespaceName, command, token) {
  // ⚠️ SECURITY: Never mutate the global process.env.GH_TOKEN.
  // Two concurrent requests for different tokens would race and
  // execute with the wrong credential (cross-session leakage).
  // Pass GH_TOKEN per-spawn via the isolated `env` option instead.
  const { stdout, stderr } = await execAsync(
    `gh codespace ssh -c ${codespaceName} -- ${command}`,
    {
      env: {
        ...process.env,
        GH_TOKEN: token  // Isolated per execution
      }
    }
  );
  return { stdout, stderr };
}
```

> **Cold-start note**: `gh codespace ssh` on a stopped codespace waits for it to boot (30-60s). Separate the boot wait from the command timeout — e.g. a 90-second boot timeout followed by the command timeout (default 30s). Do not run a single 30s timeout over both, or commands to stopped codespaces will always time out.

### 3.2 Direct SSH Access

**Approach**: Use native SSH after retrieving connection details via API

**Process**:
1. Call API to get SSH connection info
2. Use Node.js `ssh2` library (already used for GCS)
3. Execute commands over SSH channel

**Pros**:
- Leverages existing `ssh-service.js` infrastructure
- No external CLI dependencies
- Better error handling and output control
- Consistent with GCS provider pattern

**Cons**:
- More complex setup
- Need to handle SSH key exchange
- GitHub manages SSH certificates differently

**SSH Connection Info Retrieval**:
```bash
gh codespace ssh --config <codespace-name>
```

**Output**:
```
Host cs-<name>
  User codespace
  HostName <hostname>
  Port 22
```

### 3.3 GitHub API + Web Terminal (Not Viable)

GitHub does not expose a direct API endpoint for command execution like CodeSandbox's SDK. Commands must be executed via SSH or CLI.

### 3.4 Recommended Approach: GitHub CLI (`gh`)

**Rationale**:
- Simplest to implement
- Most reliable (official tooling)
- Handles SSH complexity internally
- Authentication via token is straightforward
- Similar to how we'd use `gcloud` for GCS

---

## 4. Machine Types and Configuration

### 4.1 Available Machine Types

| Machine Name | Display Name | CPUs | RAM | Storage | Operating System |
|--------------|--------------|------|-----|---------|------------------|
| `basicLinux32gb` | 2 cores, 8 GB RAM, 32 GB storage | 2 | 8 GB | 32 GB | linux |
| `standardLinux` | 4 cores, 16 GB RAM, 64 GB storage | 4 | 16 GB | 64 GB | linux |
| `standardLinux32gb` | 4 cores, 16 GB RAM, 32 GB storage | 4 | 16 GB | 32 GB | linux |
| `premiumLinux` | 8 cores, 32 GB RAM, 64 GB storage | 8 | 32 GB | 64 GB | linux |
| `largeLinux` | 8 cores, 32 GB RAM, 128 GB storage | 8 | 32 GB | 128 GB | linux |
| `largePremiumLinux` | 16 cores, 64 GB RAM, 128 GB storage | 16 | 64 GB | 128 GB | linux |

### 4.2 Creation Parameters

```json
{
  "repository_id": 1296269,
  "ref": "main",
  "machine": "standardLinux",
  "location": "WestUs2",
  "geo": "UsWest",
  "idle_timeout_minutes": 30,
  "retention_period_minutes": 43200,
  "display_name": "My Development Environment",
  "devcontainer_path": ".devcontainer/devcontainer.json"
}
```

**Geographic Regions**:
- `EuropeWest`
- `SoutheastAsia`
- `UsEast`
- `UsWest`

---

## 5. Lifecycle Management

### 5.1 State Transitions

```
Created → Starting → Available → ShuttingDown → Shutdown
                ↓
              Failed
```

### 5.2 Lifecycle Operations

**Create**:
```bash
POST /user/codespaces
{
  "repository_id": <repo_id>,
  "ref": "main",
  "machine": "standardLinux"
}
```

**Start** (if stopped):
```bash
POST /user/codespaces/{codespace_name}/start
```

**Stop** (graceful):
```bash
POST /user/codespaces/{codespace_name}/stop
```

**Delete**:
```bash
DELETE /user/codespaces/{codespace_name}
```

### 5.3 Refresh/Get State

```bash
GET /user/codespaces/{codespace_name}
```

Returns current state, URLs, and metadata.

---

## 6. Integration Architecture

### 6.1 Provider Implementation Structure

```
src/services/providers/codespaces-provider.js
src/services/providers/codespaces/
  ├── client.js              # GitHub API client wrapper
  ├── credentials-loader.js  # Token loading from S3/filesystem
  ├── session-mapper.js      # Map GitHub response to session schema
  └── cli-executor.js        # GitHub CLI command execution wrapper
```

### 6.2 Base Provider Interface Mapping

| Method | GitHub API/CLI | Notes |
|--------|---------------|-------|
| `createSession()` | `POST /user/codespaces` | Requires repository_id |
| `refreshSession()` | `GET /user/codespaces/{name}` | Returns current state |
| `executeCommand()` | `gh codespace ssh -c <name> -- <cmd>` | Via GitHub CLI |
| `terminateSession()` | `DELETE /user/codespaces/{name}` | Async deletion (202) |
| `isSessionActive()` | Check `state` field | `Available` = active |
| `executeKeepAlive()` | `gh codespace ssh -c <name> -- date` | Simple ping command |

### 6.3 Session Schema Mapping

| Orchestrator Field | GitHub Codespaces Field | Transformation |
|--------------------|------------------------|----------------|
| `id` | Generated UUID | Not GitHub's numeric `id` |
| `provider` | `'codespaces'` | Static |
| `providerSessionId` | `name` | Unique codespace name |
| `envName` | `name` or `display_name` | User-friendly name |
| `sshCommand` | `gh codespace ssh -c <name>` | CLI command |
| `webHost` | `web_url` | Direct mapping |
| `status` | `state` | Map states to orchestrator statuses |
| `credentialRef` | Token filename/path | S3 key or local path |
| `credentialFingerprint` | SHA-256(token) | For uniqueness tracking |

**State Mapping** (complete 17-state map):
```javascript
const STATE_MAP = {
  // Running states
  'Available': 'RUNNING',
  'Awaiting': 'RUNNING',      // user action required but accessible
  'Exporting': 'RUNNING',     // still accessible during export

  // Starting states
  'Starting': 'STARTING',
  'Created': 'PENDING',
  'Provisioning': 'PENDING',
  'Queued': 'PENDING',
  'Unknown': 'PENDING',       // initial/indeterminate state
  'Updating': 'PENDING',      // configuration change in progress
  'Rebuilding': 'PENDING',    // container rebuild in progress

  // Stopping states
  'ShuttingDown': 'STOPPING',

  // Stopped states (preserved, restorable)
  'Shutdown': 'STOPPED',
  'Archived': 'STOPPED',      // long-term hibernation
  'Unavailable': 'STOPPED',   // temporary unavailability
  'Moved': 'STOPPED',         // host migration

  // Terminal states
  'Failed': 'FAILED',
  'Deleted': 'TERMINATED'
};

// Unknown future states default to PENDING and should be logged
// to detect GitHub API changes.
function mapState(state) {
  return STATE_MAP[state] || 'PENDING';
}
```

---

## 7. Credential Management

### 7.1 Credential Format

**File Structure** (`codespaces/token.json`):
```json
{
  "token": "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "username": "octocat",
  "scopes": ["codespace"],
  "expires_at": "2027-12-31T23:59:59Z"
}
```

**Or Simple Text File** (`codespaces/token.txt`):
```
ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 7.2 Storage Locations

Following existing pattern:
- **S3 Mode**: `s3://bucket/codespaces/`
- **Local Mode**: `${S3_MOUNT_DIR}/codespaces/`
- **S3 API Mode**: Downloaded to `/tmp/codespaces-<hash>.json`

### 7.3 Token Validation

```javascript
async function validateToken(token) {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10'
    }
  });
  
  if (!response.ok) {
    throw new Error(`Invalid GitHub token: ${response.status}`);
  }
  
  return await response.json();
}
```

---

## 8. Keep-Alive Strategy

### 8.1 Idle Timeout Behavior

- **Default**: 30 minutes of inactivity
- **Configurable**: 5-240 minutes via `idle_timeout_minutes`
- **Auto-stop**: Codespace automatically stops after timeout
- **Resume**: Can be restarted via API/CLI

### 8.2 Keep-Alive Implementation

**Strategy**: `gh-cli-command`

**Interval**: 20 minutes (safer than 30-minute default)

**Command**:
```bash
gh codespace ssh -c <name> -- "echo 'keep-alive' > /tmp/orchestrator-keepalive"
```

**Configuration**:
```javascript
{
  strategy: 'gh-cli-command',
  interval: 20 * 60 * 1000, // 20 minutes in milliseconds
  command: "echo 'keep-alive' > /tmp/orchestrator-keepalive"
}
```

### 8.3 Keep-Alive Environment Variables

```bash
CODESPACES_DEFAULT_IDLE_TIMEOUT_MINUTES=30
CODESPACES_KEEP_ALIVE_ENABLED=true
CODESPACES_KEEP_ALIVE_INTERVAL_MINUTES=20
```

---

## 9. Implementation Considerations

### 9.1 Repository Requirement

**Challenge**: GitHub Codespaces requires a repository context.

**Options**:
1. **Require repository in request**: User provides `repository_id` or `owner/repo`
2. **Default template repository**: Orchestrator maintains a default repo (e.g., `play-with-docker/codespace-template`)
3. **On-the-fly repository creation**: Create temporary repo, then codespace (complex)

**Recommendation**: Option 2 - Use a template repository

**Template Repo Structure**:
```
play-with-docker-template/
├── .devcontainer/
│   └── devcontainer.json
├── README.md
└── .gitignore
```

**`.devcontainer/devcontainer.json`**:
```json
{
  "name": "Play with Docker",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/devcontainers/features/docker-in-docker:2": {}
  },
  "postCreateCommand": "docker --version"
}
```

### 9.2 Docker Access

**Built-in Docker Support**:
- Use `docker-in-docker` devcontainer feature
- Codespace provides Docker daemon automatically
- No need for `socat` proxy like CodeSandbox

**Environment Check**:
```bash
gh codespace ssh -c <name> -- "docker ps"
```

### 9.3 Token Uniqueness Constraint

Following CodeSandbox pattern, enforce one active codespace per GitHub token.

**Database Constraint**:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_codespaces_active_token
ON sessions (credentialFingerprint)
WHERE provider = 'codespaces'
  AND credentialFingerprint IS NOT NULL
  AND COALESCE(status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED');
```

### 9.4 Dependencies

**New NPM Package**:
- **None required** if using GitHub CLI via shell execution
- **Alternative**: `@octokit/rest` for pure API approach

**System Dependencies**:
- **GitHub CLI** (`gh`): Must be installed in Docker container
- Installation: `curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list && apt update && apt install gh -y`

---

## 10. API Request/Response Examples

### 10.1 Create Codespace

**Request**:
```bash
curl -L \
  -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer ghp_xxxxxxxxxxxx" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
  https://api.github.com/user/codespaces \
  -d '{
    "repository_id": 1296269,
    "ref": "main",
    "machine": "standardLinux",
    "idle_timeout_minutes": 30,
    "display_name": "Development Environment"
  }'
```

**Response** (201 Created):
```json
{
  "id": 1,
  "name": "octocat-play-with-docker-abc123",
  "state": "Available",
  "web_url": "https://octocat-play-with-docker-abc123.github.dev",
  "machine": {
    "name": "standardLinux",
    "cpus": 4,
    "memory_in_bytes": 17179869184
  },
  "created_at": "2026-08-02T05:00:00Z"
}
```

### 10.2 Execute Command

**Using GitHub CLI**:
```bash
export GH_TOKEN=ghp_xxxxxxxxxxxx
gh codespace ssh -c octocat-play-with-docker-abc123 -- "docker run hello-world"
```
> Note: `export` is fine for a one-off interactive shell. In the orchestrator's automation, pass the token per-spawn (`env: { ...process.env, GH_TOKEN: token }`) — never export it globally, to avoid cross-session credential races.

**Output**:
```
Hello from Docker!
...
```

### 10.3 Get Codespace Status

**Request**:
```bash
curl -L \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer ghp_xxxxxxxxxxxx" \
  https://api.github.com/user/codespaces/octocat-play-with-docker-abc123
```

**Response**:
```json
{
  "name": "octocat-play-with-docker-abc123",
  "state": "Available",
  "last_used_at": "2026-08-02T05:15:00Z",
  "idle_timeout_minutes": 30
}
```

### 10.4 Stop Codespace

**Request**:
```bash
curl -L \
  -X POST \
  -H "Authorization: Bearer ghp_xxxxxxxxxxxx" \
  https://api.github.com/user/codespaces/octocat-play-with-docker-abc123/stop
```

**Response** (200 OK):
```json
{
  "name": "octocat-play-with-docker-abc123",
  "state": "ShuttingDown"
}
```

### 10.5 Delete Codespace

**Request**:
```bash
curl -L \
  -X DELETE \
  -H "Authorization: Bearer ghp_xxxxxxxxxxxx" \
  https://api.github.com/user/codespaces/octocat-play-with-docker-abc123
```

**Response** (202 Accepted):
```
(Empty body)
```

---

## 11. Comparison with Existing Providers

| Feature | GCS | CodeSandbox | GitHub Codespaces |
|---------|-----|-------------|-------------------|
| **Authentication** | Service account JSON | API token JSON | Personal access token |
| **Create Method** | Google Cloud Shell API | CodeSandbox SDK | GitHub REST API |
| **Command Execution** | SSH (ssh2 library) | SDK exec method | GitHub CLI (`gh`) |
| **State Management** | API polling | SDK status check | REST API GET |
| **Keep-Alive** | SSH ping + API extend | SDK command write | GitHub CLI command |
| **Docker Support** | Pre-installed | Requires socat proxy | Devcontainer feature |
| **SSH Access** | Manual key injection | Not available | GitHub CLI managed |
| **Token Uniqueness** | No constraint | Enforced | Should enforce |
| **Default Timeout** | 20 min (terminal), 1 hr (session) | 24 hours | 30 minutes |

---

## 12. Risks and Limitations

### 12.1 Repository Dependency

**Risk**: Every codespace must be tied to a repository.

**Mitigation**: Maintain a default template repository. Optionally support user-provided repositories.

### 12.2 GitHub CLI Dependency

**Risk**: External CLI tool required; adds complexity to Docker image.

**Mitigation**: 
- Install `gh` during Docker build
- Verify installation in health checks
- Document system requirements

### 12.3 Rate Limiting

**Risk**: GitHub API has rate limits (5,000 requests/hour for authenticated users).

**Mitigation**:
- Cache codespace state locally
- Use conditional requests (ETags)
- Implement exponential backoff

**Rate Limit Headers**:
```
X-RateLimit-Limit: 5000
X-RateLimit-Remaining: 4999
X-RateLimit-Reset: 1372700873
```

### 12.4 Cost

**Risk**: GitHub Codespaces incurs per-minute compute costs.

**Mitigation**:
- Enforce aggressive idle timeouts
- Document billing implications
- Provide clear session lifecycle management

**Pricing** (as of 2026):
- 2-core: $0.18/hour
- 4-core: $0.36/hour
- 8-core: $0.72/hour

### 12.5 Token Expiration

**Risk**: Personal access tokens can expire.

**Mitigation**:
- Store expiration date in credential files
- Validate token before operations
- Return clear error messages on 401 responses

---

## 13. Implementation Roadmap

### Phase 1: Core Infrastructure
1. Install GitHub CLI in Docker container
2. Create `codespaces-provider.js` extending `base-provider.js`
3. Implement credential loading from S3/filesystem
4. Create GitHub API client wrapper

### Phase 2: Lifecycle Management
1. Implement `createSession()` with template repository
2. Implement `refreshSession()` for state polling
3. Implement `terminateSession()` with DELETE API
4. Map GitHub states to orchestrator statuses

### Phase 3: Command Execution
1. Create CLI executor wrapper for `gh codespace ssh`
2. Implement `executeCommand()` with error handling
3. Add output capture and logging

### Phase 4: Keep-Alive
1. Implement keep-alive scheduler
2. Configure default timeouts
3. Add keep-alive command execution via CLI

### Phase 5: Integration
1. Register provider in factory
2. Add credential listing endpoint
3. Update API documentation
4. Add environment variable configuration

### Phase 6: Testing
1. Unit tests for provider methods
2. Integration tests with real GitHub API
3. Token uniqueness constraint testing
4. Keep-alive mechanism validation

---

## 14. Configuration

### 14.1 Environment Variables

```bash
# GitHub Codespaces Configuration
CODESPACES_DEFAULT_REPOSITORY_ID=1296269
CODESPACES_DEFAULT_MACHINE=standardLinux
CODESPACES_DEFAULT_GEO=UsWest
CODESPACES_DEFAULT_IDLE_TIMEOUT_MINUTES=30
CODESPACES_DEFAULT_RETENTION_PERIOD_MINUTES=43200

# Keep-Alive Settings
CODESPACES_KEEP_ALIVE_ENABLED=true
CODESPACES_KEEP_ALIVE_INTERVAL_MINUTES=20
CODESPACES_KEEP_ALIVE_COMMAND="echo 'orchestrator-keepalive' > /tmp/keepalive"

# GitHub CLI Configuration
# ⚠️ Do NOT set GH_TOKEN as a fallback. All operations must use per-session
# credentials (loaded from the credentialRef) or fail immediately with a
# clear 401/403 error. A fallback token would silently attribute all sessions
# to one account, defeat token uniqueness, and leak one user's repo access to
# every orchestrator user.
```

### 14.2 Credential File Locations

- **S3 Bucket**: `s3://${S3_BUCKET}/codespaces/`
- **Local Mount**: `${S3_MOUNT_DIR}/codespaces/`
- **File Format**: `codespaces/account.json` or `codespaces/token.txt`

---

## 15. Open Questions

1. **Should we support user-provided repositories, or only use a template?**
   - **Recommendation**: Start with template only, add user repos in v2

2. **How should we handle devcontainer configuration customization?**
   - **Recommendation**: Use sensible defaults, allow override via request body

3. **Should we install GitHub CLI in base image or as runtime dependency?**
   - **Recommendation**: Install in Dockerfile for reliability

4. **Do we need to support GitHub App authentication alongside PATs?**
   - **Recommendation**: Start with PATs, add GitHub Apps if needed

5. **Should we cache codespace SSH config, or regenerate on each command?**
   - **Recommendation**: Cache for session duration, refresh on errors

---

## 16. References

- **GitHub Codespaces REST API**: https://docs.github.com/en/rest/codespaces/codespaces
- **GitHub CLI Manual**: https://cli.github.com/manual/gh_codespace_ssh
- **Codespaces Documentation**: https://docs.github.com/en/codespaces
- **Devcontainer Specification**: https://containers.dev/
- **GitHub API Rate Limits**: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- **Personal Access Tokens**: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens

---

## 17. Conclusion

Adding GitHub Codespaces as a provider is feasible and aligns well with the existing orchestrator architecture. The main challenges are:

1. **Repository requirement** - Solved by using a template repository
2. **GitHub CLI dependency** - Manageable via Docker image configuration
3. **Command execution** - Simplified by using `gh codespace ssh`

The implementation follows the same patterns as existing providers (GCS and CodeSandbox), with GitHub CLI serving a similar role to `gcloud` for GCS. The REST API provides comprehensive lifecycle management, and the token-based authentication is straightforward.

**Estimated Effort**: 3-5 days for full implementation and testing.

**Priority**: Medium - GitHub Codespaces is widely used and provides excellent Docker support out-of-the-box.
