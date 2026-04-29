# Project Overview: Cloud Shell Session Orchestrator

## 1. Objective

This project is a Node.js API that creates and manages temporary remote development sessions behind a provider abstraction.

- Implemented provider: `gcs` (Google Cloud Shell)
- Registered but not implemented: `pwd` (Play with Docker) — demo stub only; the Play with Docker service was deprecated as of March 2026 and will not be implemented. Exists as a template reference for new providers.

The API persists session records locally, refreshes provider state on demand, executes remote shell commands over SSH for active Google Cloud Shell sessions, and runs provider-aware keep-alive recovery after restarts.

## 2. Current Architecture

Main flow:

1. `src/server.js` initializes Google credentials, connects to PostgreSQL, restores keep-alive timers for persisted sessions, and starts Express.
2. `src/routes/sessions.js` exposes the session API under `/api/v1/sessions`.
3. `src/services/provider-factory.js` resolves provider implementations.
4. `src/services/providers/gcs-provider.js` handles Google Cloud Shell lifecycle and SSH command execution.
5. `src/services/keep-alive-service.js` manages periodic keep-alive timers for providers that require them.
6. `src/db/db.js` stores session records in PostgreSQL and performs lightweight schema bootstrapping.

## 3. Technology Stack

- Backend: Node.js, Express 5, `body-parser`
- Database: PostgreSQL via `pg`
- Cloud API: Google Cloud Shell API via `googleapis`
- Remote command execution: `ssh2` plus local `ssh-keygen`
- Optional credential loading: AWS S3 SDK (`@aws-sdk/client-s3`)
- Container runtime: Docker, Docker Compose

Notes:

- `sqlite3` is present in `package.json`, but the active database implementation is PostgreSQL.
- The container image installs `s3fs` and FUSE support for credential-mount mode.

## 4. Implemented Behavior

Implemented in current code:

- Create sessions through a provider interface. Default provider is `gcs`.
- List supported providers with `GET /api/v1/sessions/providers/supported`.
- List persisted sessions, optionally filtered by `status`.
- Refresh a session on `GET /api/v1/sessions/:id` using the provider before returning data.
- Execute shell commands in running GCS sessions over SSH.
- Terminate one session or all tracked sessions.
- Start provider-aware keep-alive after session creation.
- Recover keep-alive timers on startup and delete stale inactive GCS sessions from the database.
- Return structured provider errors for unsupported providers, unimplemented providers, and non-ready sessions.
- Automatic SSH key generation and management for sessions that don't have keys yet.
- Database updates during keep-alive operations (when SSH keys are generated).
- Graceful session termination via SSH poweroff command.

Not implemented:

- `pwd` provider lifecycle methods (`createSession`, `refreshSession`, `executeCommand`, `terminateSession`) — demo stub only, Play with Docker service deprecated as of March 2026
- Automated API docs or Swagger endpoint
- Test suite automation beyond the checked-in `tests/api-tests.http` request collection

## 5. API Surface

Protected routes require one of:

- `x-server-token: <SERVER_TOKEN>`
- `Authorization: Bearer <SERVER_TOKEN>`

Routes:

- `POST /api/v1/sessions`
- `GET /api/v1/sessions/providers/supported`
- `GET /api/v1/sessions`
- `GET /api/v1/sessions/:id`
- `POST /api/v1/sessions/:id/command`
- `DELETE /api/v1/sessions/:id`
- `POST /api/v1/sessions/terminate-all`
- `GET /api/v1/sessions/google-credentials`
- `GET /health` (no token required)

Behavior details:

- `POST /api/v1/sessions` defaults to provider `gcs` when no provider is supplied.
- `POST /api/v1/sessions/:id/command` returns `409` when the provider session is not ready.
- Session refresh and provider termination are best-effort in some paths; the API may still return session data or delete the local record when a provider cleanup step fails.
- Keep-alive mechanism sends SSH commands every 15 minutes to prevent GCS session timeout (20 minutes).

## 6. Data Model

The `sessions` table is created at startup if missing and incrementally extended if columns are absent.

Columns currently managed by the app:

- `id`
- `provider`
- `providerSessionId`
- `envName`
- `sshCommand`
- `webHost`
- `privateKey`
- `publicKey`
- `status`
- `metadata`
- `createdAt`

Usage notes:

- `metadata` is stored as JSON text.
- SSH key material is persisted in the database once generated for a session (during first command execution or keep-alive).
- Older rows are normalized on startup so `provider` defaults to `gcs` and `providerSessionId` is backfilled from `envName`.

## 7. Credentials and Environment

Core variables:

```bash
PORT=3000
SERVER_TOKEN=your_token
DATABASE_URL_CONN=postgres://postgres:postgres@localhost:5432/play_with_docker
```

Google credential flow in current code:

- The request middleware expects `GOOGLE_APPLICATION_DEFAULT_CREDENTIALS` to point to a usable credentials file.
- For each request, that value is copied into `GOOGLE_APPLICATION_CREDENTIALS`.
- A request can override credentials with header `x-google-credentials`.

Optional S3-backed credential mode:

```bash
S3FS_ENABLED=0
S3_BUCKET=your-bucket
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_SESSION_TOKEN=...   # optional
S3_REGION=us-east-1     # optional
S3_ENDPOINT=...         # optional
```

Behavior:

- When `S3FS_ENABLED=0`, startup can download the Google credentials file from object storage into `/tmp`.
- When `S3FS_ENABLED=1` and `S3_BUCKET` is set, the container entrypoint attempts an `s3fs` mount before starting the API.
- In Compose, `GOOGLE_APPLICATION_CREDENTIALS` is required in the container environment; the runtime middleware still relies on `GOOGLE_APPLICATION_DEFAULT_CREDENTIALS` being populated.

## 8. Deployment Notes

Typical local/container startup:

```bash
docker compose up --build
```

Health check:

```bash
curl http://localhost:3000/health
```

Container/runtime details:

- Image base: `node:20-bullseye-slim`
- Installs build tools, OpenSSH client, `fuse`, and `s3fs`
- Compose enables `/dev/fuse`, `SYS_ADMIN`, and `apparmor:unconfined` for mount mode

## 9. Keep-Alive Mechanism

The system implements provider-aware keep-alive to maintain active sessions:

- **GCS Provider**: Sends SSH keep-alive commands every 15 minutes (before the 20-minute timeout)
- Automatically generates SSH keys for sessions that don't have them yet
- Updates database with newly generated SSH keys during keep-alive operations
- Handles suspended sessions by attempting to resume them
- Skips keep-alive for non-running sessions until they become active
- Recovers keep-alive timers on startup from persisted sessions
- Cleans up stale GCS sessions that are no longer active remotely
- Providers can disable keep-alive (like PWD provider) if not needed

## 10. Current Risks and Gaps

- `pwd` appears as a supported provider in discovery but every operation returns `501 Not Implemented` — this is intentional; the Play with Docker service was deprecated as of March 2026, so `pwd` is a demo stub and template reference only.
- Credential handling is easy to misconfigure because startup, Compose, and request middleware use both `GOOGLE_APPLICATION_CREDENTIALS` and `GOOGLE_APPLICATION_DEFAULT_CREDENTIALS`.
- The API persists private SSH keys in PostgreSQL, so database access is security-sensitive.
- GCS shutdown and refresh paths are best-effort; local records can diverge from remote state temporarily.
- There is no automated test coverage in the repo for the current provider and keep-alive behavior.