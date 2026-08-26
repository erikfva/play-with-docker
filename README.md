# play-with-docker

This is a **multi-provider VPS orchestrator** that exposes a unified API to manage temporary virtual development environments.

> **Note:** The `pwd` (Play with Docker) provider is a demo stub only. The Play with Docker service ([labs.play-with-docker.com](https://labs.play-with-docker.com)) has been deprecated and is no longer available as of March 2026. The `pwd` provider will not be implemented and exists solely as a template reference for adding new providers.

## Requirements

- Docker + Docker Compose
- S3-compatible bucket credentials (for `s3fs` mount mode and/or S3 API credential loading)

### Provider token permissions

Each provider requires a credential file with the appropriate scopes. The credential status endpoint (`GET /sessions/{provider}/credentials/status`) validates tokens and reads upstream availability, so tokens must have enough permission to support both session management and status checks.

#### GitHub Codespaces (classic PAT)

| Scope | Required | Purpose |
|-------|----------|---------|
| `user` | Yes | Token validation (`GET /user`), billing/usage summary (`GET /users/{username}/settings/billing/usage/summary`). Without `user`, `plan` is `null` and billing usage is unavailable. |
| `codespace` | Yes | Create, list, and manage codespaces (`GET /user/codespaces`, SSH access). |
| `repo` | Optional | Broad repository access if codespace SSH or repo mounting is needed. |

> **Note:** The billing usage summary endpoint is **public preview** and requires the `user` scope on a classic PAT (or "User permissions → Plan → Read" on a fine-grained token). Without it, compute/storage usage returns `null` with a limitation.

#### CodeSandbox

The credential file contains a `token` field with a CodeSandbox API key (`csb_v1_...`). No configurable scopes — the token itself determines API access. Required capabilities:

- `GET /meta/info` — token validity, rate-limit headroom, and team ID (automatically included for all tokens).

Credit balance is not exposed by the CodeSandbox SDK or API. When `CODESANDBOX_CREDITS_SCRAPER_ENABLED=1`, the orchestrator scrapes the CodeSandbox dashboard via Playwright with a GitHub `storageState` session.

#### Google Cloud Shell

A service account JSON key with Cloud Shell API access. The orchestrator uses `googleapis` (`cloudshell.v1`) and requires:

- `cloudshell.environments.get` — read environment state without starting it.
- `cloudshell.environments.start` — start environments (session creation only; status checks avoid calling this).

No additional scopes are needed for credential status checks beyond what the service account already has.

## Quick Start

1. Copy env file:
```bash
cp .env.example .env
```

2. Edit `.env` values.

3. Run:
```bash
docker compose up --build
```

4. Health check:
```bash
curl http://localhost:3000/health
```

## Credential Modes

The app supports two modes controlled by `S3FS_ENABLED`.

Provider credentials are stored under provider-specific folders in the S3 bucket
or local mount:
- Google Cloud Shell (`gcs`): `gcloud/`
- CodeSandbox (`codesandbox`): `codesandbox/`
- GitHub Codespaces (`codespaces`): `codespaces/`

### Mode A: `s3fs` enabled (`S3FS_ENABLED=1`)

- Entrypoint mounts `S3_BUCKET` to `S3_MOUNT_DIR` using `s3fs`.
- Request credential references should point to files inside the mounted credential folders.

### Mode B: `s3fs` disabled (`S3FS_ENABLED=0`)

- No FUSE mount is attempted.
- Per-request credential references are downloaded from S3 using the SDK and written to temp files in `/tmp`.
- GCS credential references can be:
  - `s3://bucket/gcloud/key.json`, or
  - `gcloud/key.json` (uses `S3_BUCKET`)

Startup logs show active mode:
- `Credential mode: s3fs ...`
- `Credential mode: s3-api ...`

### Local development override (`NODE_ENV=local`)

When `NODE_ENV=local`, the app reads provider credential files from the local folder configured by `S3_MOUNT_DIR` instead of downloading them from S3.

In this mode, request credential references can be:
- `gcloud/key.json` under `S3_MOUNT_DIR`
- `s3://bucket/gcloud/key.json`, which resolves to `S3_MOUNT_DIR/gcloud/key.json`

Startup logs show:
- `Credential mode: local ...`

## Environment Variables

Core:
- `PORT`
- `SERVER_TOKEN`

Google credentials:
- `GOOGLE_APPLICATION_CREDENTIALS_FILE` (compose-only host bind source for `s3fs` mode)
- `GOOGLE_APPLICATION_CREDENTIALS` is deprecated for provider selection. New GCS create requests must send `x-google-credentials` or body `credentialRef`/`googleCredentialRef`.

CodeSandbox credentials:
- New CodeSandbox create requests must send `x-codesandbox-credentials` or body `credentialRef`.

Codespaces credentials:
- New Codespaces create requests must send `x-codespaces-credentials` or body `credentialRef`.
- The credential file must contain a GitHub Personal Access Token with the `codespace` scope.
- Accepted formats (any of the following, stored under `codespaces/`):
  - JSON with a `token` field, e.g. `{"token":"ghp_..."}`
  - Plain text containing only the token, e.g. `ghp_...`
- GitHub REST API versioning uses header `X-GitHub-Api-Version: 2026-03-10`.

Codespaces provider options:
- `CODESPACES_DEFAULT_REPOSITORY_ID` (required for create)
- `CODESPACES_DEFAULT_MACHINE` (default `basicLinux32gb`)
- `CODESPACES_DEFAULT_GEO` (default `UsEast`)
- `CODESPACES_DEFAULT_IDLE_TIMEOUT_MINUTES` (default `30`)
- `CODESPACES_DEFAULT_RETENTION_PERIOD_MINUTES` (default `1440`)
- `CODESPACES_KEEP_ALIVE_ENABLED` (default `true`)
- `CODESPACES_KEEP_ALIVE_INTERVAL_MINUTES` (default `20`)

S3:
- `S3FS_ENABLED` (`1` or `0`)
- `S3_BUCKET`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_SESSION_TOKEN` (optional)
- `S3_REGION` (optional)
- `S3_ENDPOINT` (optional for S3-compatible providers)
- `S3_MOUNT_DIR` (`s3fs` mode)
- `S3FS_EXTRA_OPTS` (`s3fs` mode)

## API

All `/api/v1/sessions/*` endpoints require:
- Header `x-server-token: <SERVER_TOKEN>` or `Authorization: Bearer <SERVER_TOKEN>`

Examples:

Create session:
```bash
curl -X POST http://localhost:3000/api/v1/sessions \
  -H "Content-Type: application/json" \
  -H "x-server-token: $SERVER_TOKEN" \
  -H "x-google-credentials: gcloud/key.json" \
  -d '{"provider":"gcs"}'
```

Create CodeSandbox session:
```bash
curl -X POST http://localhost:3000/api/v1/sessions \
  -H "Content-Type: application/json" \
  -H "x-server-token: $SERVER_TOKEN" \
  -H "x-codesandbox-credentials: codesandbox/account.json" \
  -d '{"provider":"codesandbox"}'
```

Create GitHub Codespaces session:
```bash
curl -X POST http://localhost:3000/api/v1/sessions \
  -H "Content-Type: application/json" \
  -H "x-server-token: $SERVER_TOKEN" \
  -H "x-codespaces-credentials: codespaces/token.json" \
  -d '{"provider":"codespaces"}'
```

The GitHub PAT must have the `codespace` scope. Create one at
https://github.com/settings/tokens (fine-grained tokens need
`Codespaces: read/write`). The token is never stored or logged; only a
`sha256` fingerprint is persisted in the DB.

List available Codespaces credentials:
```bash
curl http://localhost:3000/api/v1/sessions/codespaces-credentials \
  -H "x-server-token: $SERVER_TOKEN"
```

Run command in a Codespaces session:
```bash
curl -X POST http://localhost:3000/api/v1/sessions/<SESSION_ID>/command \
  -H "Content-Type: application/json" \
  -H "x-server-token: $SERVER_TOKEN" \
  -H "x-codespaces-credentials: codespaces/token.json" \
  -d '{"command":"docker ps"}'
```

List supported providers:
```bash
curl http://localhost:3000/api/v1/sessions/providers/supported \
  -H "x-server-token: $SERVER_TOKEN"
```

List available Google credentials:
```bash
curl http://localhost:3000/api/v1/sessions/google-credentials \
  -H "x-server-token: $SERVER_TOKEN"
```

Run command in session:
```bash
curl -X POST http://localhost:3000/api/v1/sessions/<SESSION_ID>/command \
  -H "Content-Type: application/json" \
  -H "x-server-token: $SERVER_TOKEN" \
  -d '{"command":"echo hello"}'
```

## Render Notes

Render does not provide privileged container features required for FUSE mounting (`/dev/fuse`, `SYS_ADMIN`), so `s3fs` mode is not suitable there.

Use:
- `S3FS_ENABLED=0`
- S3 API credential loading mode
- No FUSE mount expectations
