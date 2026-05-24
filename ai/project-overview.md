# Project Overview: Cloud Shell Session Orchestrator

## 1. Objective

This project is a Node.js API that creates and manages temporary remote Virtual Machine (VM) sessions behind a provider abstraction layer.

> [!IMPORTANT]
> The core objective of this orchestrator is **not merely to create isolated development sandboxes, but to provide and manage fully functional, remote Virtual Machine (VM) sessions**. These VM sessions give users access to secure, ephemeral, compute-equipped environments that support terminal control, remote shell command execution, and service runtime hosting.

### Supported Providers:
- **`gcs` (Google Cloud Shell)**: Provision remote Google Cloud Shell instances, authorize access, inject SSH keys, and execute VM commands.
- **`codesandbox` (CodeSandbox)**: Provision CodeSandbox microVM sessions, automatically configure secure Docker socket proxies, and execute remote commands inside the VM.
- **`pwd` (Play with Docker)**: Registered but not implemented. Placed as a demo stub and template reference. The Play with Docker service was deprecated as of March 2026 and will not be implemented.

The orchestrator manages session records locally, refreshes remote state on demand, executes remote shell commands over SSH or SDK interfaces, and restores active keep-alive schedules following service restarts.

---

## 2. Current Architecture

```mermaid
flowchart TD
    Client[Client REST API] --> Server[src/server.js]
    Server --> Router[src/routes/sessions.js]
    Router --> Factory[src/services/provider-factory.js]
    Factory --> GCS[src/services/providers/gcs-provider.js]
    Factory --> CSB[src/services/providers/codesandbox-provider.js]
    Factory --> PWD[src/services/providers/pwd-provider.js]

    GCS --> GCSService[src/services/gcs-service.js]
    GCS --> SSHService[src/services/ssh-service.js]

    CSB --> CSBClient[src/services/providers/codesandbox/client.js]
    CSB --> CSBCreds[src/services/providers/codesandbox/credentials-loader.js]
    CSB --> CSBMapper[src/services/providers/codesandbox/session-mapper.js]

    Server --> KeepAlive[src/services/keep-alive-service.js]
    KeepAlive --> GCS
    KeepAlive --> CSB

    Server --> DB[(src/db/db.js)]
```

### File Hierarchy and Responsibility:

1. **`src/server.js`**: Server initializer. Bootstraps the PostgreSQL database connection, restores active keep-alive timers for surviving database sessions, and launches the Express server.
2. **`src/routes/sessions.js`**: Exposes REST endpoints under `/api/v1/sessions` and handles credential verification requirements.
3. **`src/services/provider-factory.js`**: Resolves requested provider identifiers into their active implementations (`gcs`, `codesandbox`, `pwd`).
4. **`src/services/providers/`**:
   - **`base-provider.js`**: Abstract class defining lifecycle hooks (`createSession`, `refreshSession`, `executeCommand`, `terminateSession`, `isSessionActive`, `executeKeepAlive`).
   - **`gcs-provider.js`**: Controls Google Cloud Shell lifecycles and handles system keygen and public key injection.
   - **`codesandbox-provider.js`**: Manages CodeSandbox microVMs. Bootstraps secure UNIX-to-TCP Docker socket proxies using `socat` inside the container.
   - **`pwd-provider.js`**: Passive demo stub/template. Throws `ProviderNotImplementedError` on execution.
5. **`src/services/providers/codesandbox/`**:
   - **`client.js`**: Manages and caches authenticated singleton `@codesandbox/sdk` client instances using SHA-256 hashed token cache keys.
   - **`credentials-loader.js`**: Handles CodeSandbox API token extraction from S3 buckets or local mounts, validating file formats, and generating token fingerprints.
   - **`session-mapper.js`**: Normalizes raw CodeSandbox sandbox responses into the uniform application session schema.
6. **`src/services/keep-alive-service.js`**: Executes scheduled ping strategies. Restores active schedules on server startup, cleans up stale sessions, and marks failed sessions as `FAILED` upon reaching a 3-consecutive-failure limit.
7. **`src/services/google-credentials-loader.js` / `src/services/credentials-lister.js`**: Manages downloading, parsing, and caching cloud credential files from filesystem directories or S3 buckets.
8. **`src/services/ssh-service.js`**: Utility wrapping OpenSSH command-line `ssh-keygen` and the standard `ssh2` library for executing secure commands.
9. **`src/db/db.js`**: Configures PostgreSQL connection pools, initializes schemas, executes incremental migrations (column additions), and enforces active CodeSandbox token constraints.

---

## 3. Technology Stack

- **Runtime**: Node.js (v20 base image)
- **Framework**: Express 5, `body-parser`
- **Database**: PostgreSQL via `pg` (with automatic schema bootstrapping and diagnostic logging)
- **Google Cloud integration**: `googleapis` (Cloud Shell v1)
- **CodeSandbox integration**: `@codesandbox/sdk` (v2.4.2)
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

### General Orchestration:
- **Discovery**: Exposes supported providers (`GET /api/v1/sessions/providers/supported`).
- **Keep-Alive**: Restores background intervals on restart, automatically skips inactive sessions, handles remote suspensions (resuming GCS environments), and cleans stale sessions from the local database.
- **Token Authorization**: Enforces strict backend access via token comparison.

---

## 5. API Surface

Protected routes require one of the following authorization mechanisms:
- `x-server-token: <SERVER_TOKEN>` header
- `Authorization: Bearer <SERVER_TOKEN>` header

### Route Specifications:

| Method | Route | Description | Headers / Body Parameters |
| :--- | :--- | :--- | :--- |
| **POST** | `/api/v1/sessions` | Create or reuse a session. Defaults to `gcs`. | Header `x-google-credentials` or `x-codesandbox-credentials`. Optional body keys: `provider`, `credentialRef`, `title`, `vmTier`, `privacy`, `hibernationTimeoutSeconds`, `automaticWakeupConfig`. |
| **GET** | `/api/v1/sessions/providers/supported` | List active providers (filters out `pwd`). | None. |
| **GET** | `/api/v1/sessions` | List all persisted session records. | Optional query: `?status=RUNNING`. |
| **GET** | `/api/v1/sessions/:id` | Fetch session. Refreshes state from provider. | Header credentials (for GCS refresh). |
| **POST** | `/api/v1/sessions/:id/command` | Run remote command. Resumes sandbox if idle. | Body: `{ "command": "echo 'hello'" }`. |
| **DELETE** | `/api/v1/sessions/:id` | Gracefully shut down and delete local record. | Header credentials (for GCS cleanup). |
| **POST** | `/api/v1/sessions/terminate-all` | Terminate all active sessions and clean DB. | Header credentials (for GCS cleanups). |
| **GET** | `/api/v1/sessions/google-credentials` | List available credential files for GCS. | None. |
| **GET** | `/api/v1/sessions/codesandbox-credentials` | List available credentials for CodeSandbox. | None. |
| **GET** | `/health` | Server status check (no token required). | None. |

---

## 6. Data Model

The `sessions` table is automatically constructed on start. Active CodeSandbox constraints are enforced via a unique partial database index.

### Columns in `sessions`:
- `id` (TEXT, Primary Key)
- `provider` (TEXT, default `'gcs'`)
- `providerSessionId` (TEXT, mapped to Google Environment name or CodeSandbox ID)
- `envName` (TEXT)
- `sshCommand` (TEXT, remote connection string)
- `webHost` (TEXT, HTTP URL)
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

---

## 7. Credentials and Environment

### Core Variables:
```bash
PORT=3000
SERVER_TOKEN=your_security_token
DATABASE_URL_CONN=postgres://postgres:postgres@localhost:5432/play_with_docker
```

### Credential Resolution Flow (GCS & CodeSandbox):
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

---

## 10. Risks and Gaps

- **Database Credentials Persistence**: The database retains private SSH keys and credential references. Access to the PostgreSQL instance must be heavily restricted and monitored.
- **One Active Session Limitation**: The active token constraint index strictly enforces one active CodeSandbox session per token. Attempting parallel provisioning requests under the same token will trigger validation/constraint errors (though the orchestrator attempts to safely recover by resuming the existing session).
- **Graceful Termination Contingency**: If an API shutdown fails during CodeSandbox deletion, the microVM might remain active until it hibernates. Clients should monitor returned termination statuses.
- **SQLite Residuals**: While `sqlite3` remains in `package.json`, the orchestrator relies entirely on PostgreSQL. The database connection logic throws fatal initialization exceptions if PG pools fail to start.
