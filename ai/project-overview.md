# Project Overview: Multi-Provider Virtual Environment Orchestrator

## 1. Objective

This project exposes a unified API to manage temporary virtual development environments through provider adapters.

- Current production provider: **Google Cloud Shell (`gcs`)**
- Additional provider scaffold: **Play with Docker (`pwd`)** (registered but not implemented)

The codebase uses a provider factory pattern so provider-specific behavior is encapsulated behind a common interface.

## 2. Core Technology Stack

- **Backend:** Node.js, Express.js
- **Database:** PostgreSQL (`pg`)
- **Cloud Integration:** Google Cloud Shell API (`googleapis`)
- **Remote Command Execution:** SSH (`ssh2`)
- **Credentials Loader:** AWS S3 SDK (`@aws-sdk/client-s3`) for optional S3-based credential fetch
- **Containerization:** Docker, Docker Compose

## 3. Current Project Status

Implemented and working in API code:
- Create provider-backed sessions (default provider: `gcs`)
- Persist sessions in PostgreSQL
- Refresh and retrieve session state
- Execute shell commands in active GCS sessions over SSH
- Terminate individual sessions or all sessions
- Provider-aware keep-alive for GCS sessions
- Server-token authentication for all `/api/v1/sessions/*` routes

Not implemented yet:
- Full `pwd` provider lifecycle (`createSession`, `refreshSession`, `executeCommand`, `terminateSession`)
- Swagger/OpenAPI docs endpoint in current server

## 4. Setup and Configuration

### Required Environment Variables

Core:
```bash
PORT=3000
SERVER_TOKEN=your_token
DATABASE_URL=postgres://postgres:postgres@localhost:5432/play_with_docker
```

Google credentials:
```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/or/s3/reference/to/credentials.json
```

Optional S3 credential loading mode (`S3FS_ENABLED=0`):
```bash
S3FS_ENABLED=0
S3_BUCKET=your-bucket
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_SESSION_TOKEN=... # optional
S3_REGION=us-east-1   # optional
S3_ENDPOINT=...       # optional, for S3-compatible providers
```

### Running the Application

From the project root:

```bash
docker compose up --build
```

Health check:

```bash
curl http://localhost:3000/health
```

## 5. API Endpoints (Current)

All `/api/v1/sessions/*` endpoints require one of:
- `x-server-token: <SERVER_TOKEN>`
- `Authorization: Bearer <SERVER_TOKEN>`

Key endpoints:
- `POST /api/v1/sessions` (create session, optional `provider` in body)
- `GET /api/v1/sessions/providers/supported` (list registered providers)
- `GET /api/v1/sessions` (list sessions, optional `?status=...`)
- `GET /api/v1/sessions/:id` (get and refresh a session)
- `POST /api/v1/sessions/:id/command` (execute command)
- `DELETE /api/v1/sessions/:id` (terminate one session)
- `POST /api/v1/sessions/terminate-all` (terminate all tracked sessions)
- `GET /health` (health check, no token required)

## 6. Database

Storage is PostgreSQL. The `sessions` table includes:
- `id` (primary key)
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

At startup, the app ensures required columns exist (lightweight migration behavior).

## 7. Risks and Constraints

- **Provider completeness:** `pwd` is registered but intentionally not implemented yet.
- **External dependency risk:** GCS functionality depends on Google Cloud Shell API behavior and permissions.
- **Session lifecycle complexity:** Keep-alive and resume behavior can fail due to API/network/auth changes.
- **Security considerations:** Session metadata and SSH key material are stored in the database; DB access must be tightly controlled.
- **Operational requirement:** PostgreSQL availability is mandatory for API startup.
