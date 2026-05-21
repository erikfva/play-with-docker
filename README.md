# play-with-docker

This is a **multi-provider VPS orchestrator** that exposes a unified API to manage temporary virtual development environments.

> **Note:** The `pwd` (Play with Docker) provider is a demo stub only. The Play with Docker service ([labs.play-with-docker.com](https://labs.play-with-docker.com)) has been deprecated and is no longer available as of March 2026. The `pwd` provider will not be implemented and exists solely as a template reference for adding new providers.

## Requirements

- Docker + Docker Compose
- S3-compatible bucket credentials (for `s3fs` mount mode and/or S3 API credential loading)
- Google service account JSON for Cloud Shell API access

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

### Mode A: `s3fs` enabled (`S3FS_ENABLED=1`)

- Entrypoint mounts `S3_BUCKET` to `S3_MOUNT_DIR` using `s3fs`.
- `GOOGLE_APPLICATION_CREDENTIALS` should be a filesystem path inside the container.

### Mode B: `s3fs` disabled (`S3FS_ENABLED=0`)

- No FUSE mount is attempted.
- At startup, app downloads credentials from S3 using SDK and writes a temp file in `/tmp`.
- `GOOGLE_APPLICATION_CREDENTIALS` is interpreted as:
  - `s3://bucket/gcloud/key.json`, or
  - `gcloud/key.json` (uses `S3_BUCKET`)

Startup logs show active mode:
- `Credential mode: s3fs ...`
- `Credential mode: s3-api ...`

### Local development override (`NODE_ENV=local`)

When `NODE_ENV=local`, the app reads Google credential files from the local folder configured by `S3_MOUNT_DIR` instead of downloading them from S3.

In this mode, `GOOGLE_APPLICATION_CREDENTIALS` can be:
- `gcloud/key.json` under `S3_MOUNT_DIR`
- `s3://bucket/gcloud/key.json`, which resolves to `S3_MOUNT_DIR/gcloud/key.json`

Startup logs show:
- `Credential mode: local ...`

## Environment Variables

Core:
- `PORT`
- `SERVER_TOKEN`

Google credentials:
- `GOOGLE_APPLICATION_CREDENTIALS` (container path or S3 object reference depending on mode)
- `GOOGLE_APPLICATION_CREDENTIALS_FILE` (compose-only host bind source for `s3fs` mode)

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
  -d '{"provider":"gcs"}'
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
