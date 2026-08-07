# Project Overview: Cloud Shell Session Orchestrator

## 1. Objective

This project is a Node.js API that creates and manages temporary remote Virtual Machine (VM) sessions behind a provider abstraction layer.

> [!IMPORTANT]
> The core objective of this orchestrator is **not merely to create isolated development sandboxes, but to provide and manage fully functional, remote Virtual Machine (VM) sessions**. These VM sessions give users access to secure, ephemeral, compute-equipped environments that support terminal control, remote shell command execution, and service runtime hosting.

### Supported Providers:
- **`gcs` (Google Cloud Shell)**: Provision remote Google Cloud Shell instances, authorize access, inject SSH keys, and execute VM commands.
- **`codesandbox` (CodeSandbox)**: Provision CodeSandbox microVM sessions, automatically configure secure Docker socket proxies, and execute remote commands inside the VM.
- **`codespaces` (GitHub Codespaces)**: Adopt existing GitHub Codespaces VMs for a token, run commands via the GitHub CLI, and stop them on termination. See [Codespaces Provider](#codespaces-provider-github-codespaces).
- **`pwd` (Play with Docker)**: Registered but not implemented. Placed as a demo stub and template reference. The Play with Docker service was deprecated as of March 2026 and will not be implemented.

The orchestrator manages session records locally, refreshes remote state on demand, executes remote shell commands over SSH, SDK, or GitHub CLI interfaces, and restores active keep-alive schedules following service restarts.

---

## 2. Current Architecture

```mermaid
flowchart TD
    Client[Client REST API] --> Server[src/server.js]
    Server --> Router[src/routes/sessions.js]
    Router --> Factory[src/services/provider-factory.js]
    Factory --> GCS[src/services/providers/gcs-provider.js]
    Factory --> CSB[src/services/providers/codesandbox-provider.js]
    Factory --> CSP[src/services/providers/codespaces-provider.js]
    Factory --> PWD[src/services/providers/pwd-provider.js]

    GCS --> GCSService[src/services/gcs-service.js]
    GCS --> SSHService[src/services/ssh-service.js]

    CSB --> CSBClient[src/services/providers/codesandbox/client.js]
    CSB --> CSBCreds[src/services/providers/codesandbox/credentials-loader.js]
    CSB --> CSBMapper[src/services/providers/codesandbox/session-mapper.js]

    CSP --> CSPClient[src/services/providers/codespaces/client.js]
    CSP --> CSPCreds[src/services/providers/codespaces/credentials-loader.js]
    CSP --> CSPMapper[src/services/providers/codespaces/session-mapper.js]
    CSP --> CSPCLI[src/services/providers/codespaces/cli-executor.js]
    CSP --> CSPCache[src/services/providers/codespaces/read-cache.js]

    Server --> KeepAlive[src/services/keep-alive-service.js]
    KeepAlive --> GCS
    KeepAlive --> CSB
    KeepAlive --> CSP

    Server --> DB[(src/db/db.js)]
```

### File Hierarchy and Responsibility:

1. **`src/server.js`**: Server initializer. Bootstraps the PostgreSQL database connection, restores active keep-alive timers for surviving database sessions, and launches the Express server.
2. **`src/routes/sessions.js`**: Exposes REST endpoints under `/api/v1/sessions` and handles credential verification requirements.
3. **`src/services/provider-factory.js`**: Resolves requested provider identifiers into their active implementations (`gcs`, `codesandbox`, `codespaces`, `pwd`).
4. **`src/services/providers/`**:
   - **`base-provider.js`**: Abstract class defining lifecycle hooks (`createSession`, `refreshSession`, `executeCommand`, `terminateSession`, `isSessionActive`, `executeKeepAlive`).
   - **`gcs-provider.js`**: Controls Google Cloud Shell lifecycles and handles system keygen and public key injection.
   - **`codesandbox-provider.js`**: Manages CodeSandbox microVMs. Bootstraps secure UNIX-to-TCP Docker socket proxies using `socat` inside the container.
   - **`codespaces-provider.js`**: Manages GitHub Codespaces VMs via the GitHub REST API and CLI. **Adopts** an existing codespace for the token (never creates one), optionally wakes stopped codespaces with boot polling, and runs a VM-cleanup initialization before the session is reported `RUNNING`. See [Codespaces Provider](#codespaces-provider-github-codespaces).
   - **`pwd-provider.js`**: Passive demo stub/template. Throws `ProviderNotImplementedError` on execution.
5. **`src/services/providers/codesandbox/`**:
   - **`client.js`**: Manages and caches authenticated singleton `@codesandbox/sdk` client instances using SHA-256 hashed token cache keys.
   - **`credentials-loader.js`**: Handles CodeSandbox API token extraction from S3 buckets or local mounts, validating file formats, and generating token fingerprints.
   - **`session-mapper.js`**: Normalizes raw CodeSandbox sandbox responses into the uniform application session schema.
6. **`src/services/providers/codespaces/`**:
   - **`client.js`**: Fetch-based GitHub REST API client (no SDK). Implements GET-only 429 retry with exponential backoff (`1s → 2s → 4s`), error translation to provider codes, and a 30-second TTL read cache (`read-cache.js`) with `nocache` opt-out for boot polling.
   - **`credentials-loader.js`**: Loads GitHub PATs from S3 objects, s3fs mounts, or the local filesystem. Supports both JSON (`{"token": "ghp_xxx"}`) and plain-text (`.txt`) credential files, computes SHA-256 fingerprints, and enforces path-escape validation.
   - **`session-mapper.js`**: Maps GitHub codespace objects to the session schema (full 17-state map) and computes hardware metadata (CPUs, memory, storage).
   - **`cli-executor.js`**: Wraps `gh codespace ssh -c <name> -- <command>`. Passes `GH_TOKEN` per `execFile` spawn (never mutates `process.env`). Enforces a 90-second boot timeout and 30-second command timeout.
   - **`read-cache.js`**: In-process TTL cache for `getCodespace` reads, keyed by token fingerprint + codespace name, to cut GitHub quota on idle polls. Errors are never cached; invalidated on writes.
7. **`src/services/keep-alive-service.js`**: Executes scheduled ping strategies. Restores active schedules on server startup, cleans up stale sessions, and marks failed sessions as `FAILED` upon reaching a 3-consecutive-failure limit. Preserves `STOPPED` session rows unconditionally on startup recovery (skips `isSessionActive` for them).
8. **`src/services/google-credentials-loader.js` / `src/services/credentials-lister.js`**: Manages downloading, parsing, and caching cloud credential files from filesystem directories or S3 buckets. `credentials-lister.js` filters `.json` and `.txt` files (Codespaces supports plain-text tokens).
9. **`src/services/ssh-service.js`**: Utility wrapping OpenSSH command-line `ssh-keygen` and the standard `ssh2` library for executing secure commands.
10. **`src/db/db.js`**: Configures PostgreSQL connection pools, initializes schemas, executes incremental migrations (column additions), and enforces active CodeSandbox and Codespaces token constraints.

---

## 3. Technology Stack

- **Runtime**: Node.js (v20 base image)
- **Framework**: Express 5, `body-parser`
- **Database**: PostgreSQL via `pg` (with automatic schema bootstrapping and diagnostic logging)
- **Google Cloud integration**: `googleapis` (Cloud Shell v1)
- **CodeSandbox integration**: `@codesandbox/sdk` (v2.4.2)
- **GitHub Codespaces integration**: GitHub REST API via built-in `fetch` (no SDK) + the `gh` CLI for SSH command execution
- **Object Storage**: `@aws-sdk/client-s3` (for request-scoped credential retrieval)
- **Remote Execution**: `ssh2` and local OpenSSH client tools
- **Containerization**: Docker, Docker Compose (configured with FUSE, `s3fs`, and administrative capabilities for mount modes)

> [!NOTE]
> The `sqlite3` dependency is present in `package.json` but is completely unused. The production database is entirely PostgreSQL.

---

## 4. Implemented Behavior

### Provider Lifecycles:
- **Google Cloud Shell (GCS)**:
  - Generates SSH keypairs dynamically for command execution if no keys exist.
  - Injects public keys into the Cloud Shell VM session via Google APIs.
  - Gracefully shuts down VM instances by sending a remote `sudo poweroff -f` command via SSH prior to session deletion.
- **CodeSandbox**:
  - **Token Uniqueness**: Enforces one active Virtual Machine session per API token. If a session is initiated with a token that already has a non-terminal VM session in the database, the orchestrator automatically resumes and reuses the existing VM session, avoiding duplicate provisioning.
  - **Docker Socket Proxy**: Automatically bootstraps `socat` inside CodeSandbox MicroVMs. It maps the UNIX socket `/var/run/docker.sock` to TCP port `2375` bound on the internal network. All subsequent commands executed on this session are pre-configured with the environment variable `DOCKER_HOST=tcp://<host-ip>:2375`, enabling seamless out-of-the-box Docker control.
  - **VM Tiers**: Maps request strings (`Nano`, `Micro`, `Small`, `Medium`, `Large`, `XLarge`, `Pico`) directly to SDK enum tiers.
- **GitHub Codespaces**:
  - **Adopt, don't create**: `createSession` never provisions a new codespace. It validates the token, lists the account's existing codespaces, and **adopts the first one** for the session. If the account has no codespaces, the request fails with `CODESPACES_ALREADY_ACTIVE` (409) and instructs the user to create one in the GitHub web UI first.
  - **Wake stopped codespaces on create**: If the adopted codespace is `STOPPED`, the provider starts it and polls (3s interval, 90s boot timeout) until `Available`.
  - **VM initialization on create**: After adoption, a cleanup script (`docker system prune -af`, `docker volume prune -f`, `docker builder prune -af`, temp-file cleanup) runs in the VM. Only if it succeeds is the session reported `RUNNING`; failures surface as `CODESPACES_START_FAILED`.
  - **Command execution**: Auto-starts stopped codespaces (90s boot timeout) before running commands, with the 30s command timeout applied after boot. Commands run via `gh codespace ssh -c <name> -- <command>` with per-spawn `GH_TOKEN` isolation.
  - **Termination = stop + cleanup**: `terminateSession` stops the codespace via API (not deletes) and fire-and-forgets a heavy cleanup script (`apt-get clean`, journal vacuum, home-dir reset) in the background. The route then marks the row `TERMINATED` (kept, not hard-deleted).
  - **Token uniqueness**: One non-terminal session per credential fingerprint via a unique partial index. `STOPPED` sessions are covered by the index.
  - **Keep-alive**: Enabled by default; interval = `min(configured, idleTimeoutMinutes − 10)`, defaulting to 20 minutes. Strategy `gh-cli-command`. `runOnStart: false` (never fires immediately).

### General Orchestration:
- **Discovery**: Exposes supported providers (`GET /api/v1/sessions/providers/supported`).
- **Keep-Alive**: Restores background intervals on restart, automatically skips inactive sessions, handles remote suspensions (resuming GCS environments), cleans stale sessions from the local database, and preserves `STOPPED` rows unconditionally across restarts.
- **Token Authorization**: Enforces strict backend access via token comparison.

---

## 5. API Surface

Protected routes require one of the following authorization mechanisms:
- `x-server-token: <SERVER_TOKEN>` header
- `Authorization: Bearer <SERVER_TOKEN>` header

### Route Specifications:

| Method | Route | Description | Headers / Body Parameters |
| :--- | :--- | :--- | :--- |
| **POST** | `/api/v1/sessions` | Create, adopt, or reuse a session. Defaults to `gcs`. | Header `x-google-credentials`, `x-codesandbox-credentials`, or `x-codespaces-credentials`. Optional body keys: `provider`, `credentialRef`, `title`, `vmTier`, `privacy`, `hibernationTimeoutSeconds`, `automaticWakeupConfig`, `machine`, `geo`, `idleTimeoutMinutes`, `displayName`, `keepAlive`. |
| **GET** | `/api/v1/sessions/providers/supported` | List active providers (filters out `pwd`). | None. |
| **GET** | `/api/v1/sessions` | List all persisted session records. | Optional query: `?status=RUNNING`, `?provider=codespaces`. |
| **GET** | `/api/v1/sessions/:id` | Fetch session. Refreshes state from provider. | Header credentials (for GCS refresh). |
| **POST** | `/api/v1/sessions/:id/command` | Run remote command. Resumes idle sandbox/codespace. | Body: `{ "command": "echo 'hello'" }`. |
| **DELETE** | `/api/v1/sessions/:id` | Terminate. Codespaces rows become `TERMINATED`; other providers hard-delete the row. | Header credentials (for GCS cleanup). |
| **POST** | `/api/v1/sessions/terminate-all` | Terminate all active sessions. Codespaces rows become `TERMINATED`; other providers hard-delete. | Header credentials (for GCS cleanups). |
| **GET** | `/api/v1/sessions/google-credentials` | List available credential files for GCS. | None. |
| **GET** | `/api/v1/sessions/codesandbox-credentials` | List available credentials for CodeSandbox. | None. |
| **GET** | `/api/v1/sessions/codespaces-credentials` | List available credentials for Codespaces. | None. |
| **GET** | `/health` | Server status check (no token required). | None. |

---

## 6. Data Model

The `sessions` table is automatically constructed on start. Active constraints are enforced via unique partial database indexes (CodeSandbox and Codespaces each get one).

### Columns in `sessions`:
- `id` (TEXT, Primary Key)
- `provider` (TEXT, default `'gcs'`)
- `providerSessionId` (TEXT, mapped to Google Environment name, CodeSandbox ID, or GitHub codespace name)
- `envName` (TEXT)
- `sshCommand` (TEXT, remote connection string; for Codespaces it is `gh codespace ssh -c <name>`)
- `webHost` (TEXT, HTTP URL; always `null` for Codespaces — the web IDE lives in `metadata.webIdeUrl`)
- `privateKey` / `publicKey` (TEXT, key material)
- `status` (TEXT, default `'PENDING'`)
- `credentialRef` (TEXT, filename, S3 key, or s3:// path)
- `credentialFingerprint` (TEXT, SHA-256 fingerprint used for token uniqueness)
- `metadata` (TEXT, serializable JSON properties)
- `createdAt` (TIMESTAMP WITH TIME ZONE)

### Active CodeSandbox Token Constraint Index:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_codesandbox_active_token
ON sessions (credentialFingerprint)
WHERE provider = 'codesandbox'
  AND credentialFingerprint IS NOT NULL
  AND COALESCE(status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED');
```

### Active Codespaces Token Constraint Index:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_codespaces_active_token
ON sessions (credentialFingerprint)
WHERE provider = 'codespaces'
  AND credentialFingerprint IS NOT NULL
  AND COALESCE(status, '') NOT IN ('TERMINATED', 'FAILED');
```

> [!NOTE]
> For `codespaces`, terminated sessions are **retained** in the database (`status = 'TERMINATED'`), unlike other providers whose terminal rows are hard-deleted. `STOPPED` sessions are also preserved across restarts (keep-alive recovery skips them). Schema bootstrap refuses to create the Codespaces index if duplicate non-terminal rows already exist for a fingerprint.

---

## 7. Credentials and Environment

### Core Variables:
```bash
PORT=3000
SERVER_TOKEN=your_security_token
DATABASE_URL_CONN=postgres://postgres:postgres@localhost:5432/play_with_docker
```

### Credential Resolution Flow (GCS, CodeSandbox & Codespaces):
Providers support three main modes for loading credential keys/tokens depending on environment configurations:
1. **Local Mode (`NODE_ENV=local`)**: Loads file credentials directly from the local directory defined by `S3_MOUNT_DIR`.
2. **S3FS Mount Mode (`S3FS_ENABLED=1`)**: Fetches credentials from S3 buckets automatically mounted to the path in `S3_MOUNT_DIR`.
3. **S3 Direct API Mode (`S3FS_ENABLED=0`)**: Securely downloads credential files directly to `/tmp` via AWS S3 SDK commands.

### CodeSandbox Customization:
Configure default properties for VM session provisioning:
```bash
CODESANDBOX_DEFAULT_TITLE="CodeSandbox Session"
CODESANDBOX_DEFAULT_PRIVACY="public-hosts" # options: public, private, public-hosts
CODESANDBOX_DEFAULT_VM_TIER="Nano"         # options: Pico, Nano, Micro, Small, Medium, Large, XLarge
CODESANDBOX_DOCKER_TEMPLATE_ID="hsd8ke"    # default Docker template ID for VM session
CODESANDBOX_HIBERNATION_TIMEOUT_SECONDS=86400 # defaults to 24 hours
CODESANDBOX_AUTOMATIC_WAKEUP=true          # wake VM session upon receiving HTTP requests
CODESANDBOX_KEEP_ALIVE_ENABLED=false       # enable background command pinging
CODESANDBOX_KEEP_ALIVE_INTERVAL_MINUTES=60  # keep-alive command command interval
```

### Codespaces Customization:
```bash
CODESPACES_KEEP_ALIVE_ENABLED=true            # keep-alive enabled by default
CODESPACES_KEEP_ALIVE_INTERVAL_MINUTES=20     # default interval (20 min before 30-min idle timeout)
CODESPACES_DEFAULT_IDLE_TIMEOUT_MINUTES=30    # session idle timeout used to derive the effective interval
CODESPACES_DEFAULT_REPOSITORY_ID=1296269      # template repo (not used by adopt flow — see notes)
CODESPACES_DEFAULT_MACHINE=basicLinux32gb     # default machine type
CODESPACES_DEFAULT_GEO=UsWest                 # default geo region
CODESPACES_DEFAULT_RETENTION_PERIOD_MINUTES=43200
```

> [!NOTE]
> Although the LAB-008 spec defined a "create" flow (template repository, machine/geo enums, `CODESPACES_DEFAULT_REPOSITORY_ID`), the **implemented** flow is adopt-don't-create: the provider ignores creation parameters and adopts the account's first existing codespace. `machine`/`geo` validation still exists, but no new codespace is ever provisioned.

---

## 8. Codespaces Provider (GitHub Codespaces)

Implemented in `src/services/providers/codespaces-provider.js` + `src/services/providers/codespaces/`. Specified in `ai/LAB-008_codespace-provider/spec.md` / `plan.md` — note the **documented divergences** below.

### Credentials
- GitHub PATs (classic tokens with `codespace` scope, or fine-grained tokens). Loaded from S3 objects, s3fs mounts, or the local filesystem via `codespaces/credentials-loader.js`.
- Supports both **JSON** (`{"token": "ghp_xxx"}`) and **plain-text** (`.txt`) credential files. `credentials-lister.js` filters `.json` and `.txt` for the `codespaces-credentials` endpoint.
- Fingerprint = `sha256:${sha256(token)}`, used for one-session-per-token enforcement.

### Session Lifecycle (as implemented)
1. **Create** — validates token, **adopts the first existing codespace** on the account. Never provisions a new codespace. If none exist → `CODESPACES_ALREADY_ACTIVE` (409).
2. **Wake** — a `STOPPED` adopted codespace is started and polled (3s, up to 90s) until `Available`.
3. **Initialize** — runs a docker/system cleanup in the VM; only on success is the session persisted and reported `RUNNING`.
4. **Commands** — `gh codespace ssh -c <name> -- <command>`, auto-starting stopped codespaces first (90s boot timeout, then 30s command timeout). Per-spawn `GH_TOKEN` env, never `process.env`.
5. **Refresh** — reads GitHub state (30s TTL cache, `nocache` for boot polling), maps via the 17-state map, updates the row.
6. **Keep-alive** — `gh-cli-command`, default 20 min, `min(configured, idleTimeout − 10)`, `runOnStart: false`.
7. **Terminate** — **stops** the codespace (not deletes), fire-and-forgets a background cleanup script, then the route marks the row `TERMINATED` (retained in DB).

### `webHost` semantics
Always `null` for Codespaces. The web IDE URL is exposed as `metadata.webIdeUrl` only. Consumers treating `webHost` as a shell target should fall back to `sshCommand`.

### Divergences from the LAB-008 spec (verify against the code, not the spec)
- **Adopt-don't-create**: the spec's `POST /user/codespaces` creation flow (template repo, `createCodespace`) is **not used**; `createSession` lists existing codespaces and adopts the first.
- **`machine`/`geo` validation exists** but has no effect since nothing is created.
- **Termination stops instead of deletes**: spec described GitHub DELETE + `TERMINATED` row; the implementation calls `POST /user/codespaces/{name}/stop` and only sets `TERMINATED` locally (GitHub's codespace itself may remain until its retention period).
- **In-memory read cache** (`read-cache.js`, 30s TTL) was a future item in the spec and is already shipped.
- **Session cleanup** (`initializeSession` on create; background `apt-get clean` / journal vacuum / home-dir reset on terminate) is beyond the spec.

---

## 9. Keep-Alive Mechanism

The orchestrator utilizes custom strategies based on provider capabilities:

### GCS Provider
- **Strategy**: `ssh-command`
- **Interval**: 10 minutes (pre-empts GCS 20-minute inactivity limit).
- **Execution**: Generates SSH keys, adds them to the environment control plane if missing, pings the Cloud Shell API to extend the 1-hour session limit, and executes a keep-alive SSH command to reset terminal idle timeouts.

### CodeSandbox Provider
- **Strategy**: `codesandbox-sdk-command`
- **Interval**: Defaults to 60 minutes (only active if `CODESANDBOX_KEEP_ALIVE_ENABLED=true`).
- **Execution**: Resumes the sandbox, connects to the container via SDK interfaces, and writes a date-timestamp to `/tmp/play-with-docker-keepalive`.
- **Note**: Keep-alive is **disabled** by default for CodeSandbox because CodeSandbox natively supports long, configurable hibernation timeouts (defaulting to 24 hours).

### Codespaces Provider
- **Strategy**: `gh-cli-command`
- **Interval**: 20 minutes by default. Effective interval = `min(configured, per-session idleTimeoutMinutes − 10)`, floored at 1.
- **Execution**: Runs `echo keep-alive` via `gh codespace ssh` (boot-aware 90s timeout for sleeping codespaces), then writes `status: 'RUNNING'` on success.
- **Skipping**: Deliberately skips `STOPPED`, `STOPPING`, `TERMINATED`, `FAILED` sessions — returns `success: true` so a deliberate skip never increments `consecutiveFailures`.
- **`runOnStart: false`**: never fires immediately on creation or recovery (avoids redundant wake + simultaneous restart firing).
- **Startup recovery**: `STOPPED` rows are preserved unconditionally (no `isSessionActive` call); stale active rows are cleaned by stopping/deleting the remote codespace before removing the local row.

---

## 10. Risks and Gaps

- **Database Credentials Persistence**: The database retains private SSH keys and credential references. Access to the PostgreSQL instance must be heavily restricted and monitored.
- **One Active Session Limitation**: The active token constraint indexes strictly enforce one active session per token (CodeSandbox and Codespaces). Attempting parallel provisioning requests under the same token will trigger validation/constraint errors (though the orchestrator attempts to safely recover by resuming the existing session).
- **Graceful Termination Contingency**: If an API shutdown fails during CodeSandbox deletion, the microVM might remain active until it hibernates. Clients should monitor returned termination statuses.
- **Codespaces stop-not-delete semantics**: `terminateSession` stops the codespace but does not delete it on GitHub — the remote codespace persists until its retention period and may still bill. This diverges from the LAB-008 "delete" intent and is a cost/cleanup consideration.
- **Codespaces adopt-don't-create**: Sessions are bound to a pre-existing codespace chosen by GitHub's ordering. The orchestrator never provisions a new codespace, so "create" depends on the user having at least one codespace on the account.
- **Credentials cache without TTL**: The Codespaces (and CodeSandbox) credential loaders cache resolved credentials for the process lifetime, so a rotated PAT stays cached until restart (noted as a TODO in `codespaces/credentials-loader.js`).
- **SQLite Residuals**: While `sqlite3` remains in `package.json`, the orchestrator relies entirely on PostgreSQL. The database connection logic throws fatal initialization exceptions if PG pools fail to start.
