# scripts

Helper scripts for local development, credential seeding, and provider diagnostics.

| Script | Purpose |
|---|---|
| [`refresh-vps-status.js`](#refresh-vps-statusjs) | Refresh persisted VPS credential status via LAB-012 endpoints (bulk or single) |
| [`seed-credentials.js`](#seed-credentialsjs) | Bulk-import credential files from a local directory into `vps` |
| [`check-codespaces-create.sh`](#check-codespaces-createsh) | Validate a GitHub PAT and whether the account can adopt / create a Codespace |
| [`test-codesandbox-api.sh`](#test-codesandbox-apish) | Smoke-test a CodeSandbox API token with the official SDK |

All scripts load env via `dotenv` when `NODE_ENV !== production`: first the repo root `.env`, then `scripts/.env` if present (per-scripts overrides win). CLI flags `--url` / `--token` win over both. Template: `scripts/.env.example` (also documented in the root `.env.example`).
The base URL precedence for `refresh-vps-status.js` / `seed-credentials.js` is: `--url` flag → `$PWD_API_URL` env var → `http://localhost:$PORT` → `http://localhost:3000`.

---

## refresh-vps-status.js

Refreshes the **persisted** credential status of `vps` rows. Wraps the LAB-012 endpoints so you don't have to craft `curl` by hand.

Endpoints used:

- Bulk — `POST /api/v1/vps/status/refresh[?provider=&force=]` → `{ summary: { total, succeeded, failed }, results: [{ id, provider, status, statusCheckedAt, error }] }`
- Single — `POST /api/v1/vps/:id/status/refresh[?force=]` → full VPS object (same shape as `GET /vps/:id`, with `status` + `statusCheckedAt` + `sessionActive`)

The server persists `status` (full normalized entry with `quotas[]`/`details`) and `statusCheckedAt` in one `UPDATE`. Without `--force` the server may serve the DB-cached status when `statusCheckedAt` is within `VPS_STATUS_TTL_MINUTES` (default 5 min) — no provider API call is made.

### Requirements

- Server running and reachable (`--url`).
- `SERVER_TOKEN` set (via `.env` / env var / `--token`).
- Node 20+ (uses built-in `fetch`).

### Usage

```bash
# All VPS
node scripts/refresh-vps-status.js

# Filter by provider
node scripts/refresh-vps-status.js --provider codespaces
node scripts/refresh-vps-status.js --provider gcs --force
node scripts/refresh-vps-status.js --provider codesandbox

# Single VPS
node scripts/refresh-vps-status.js --id 9951be32-be3a-465a-ba9a-73edd0691c59
node scripts/refresh-vps-status.js --id <vpsId> --force

# Custom server / token
SERVER_TOKEN=xxx node scripts/refresh-vps-status.js --url http://localhost:3200
node scripts/refresh-vps-status.js --url http://localhost:3000 --token xxx --json | jq .

# Help
node scripts/refresh-vps-status.js --help
```

### Options

| Flag | Default | Description |
|---|---|---|
| `--url <url>` | `$PWD_API_URL` → `http://localhost:$PORT` → `http://localhost:3000` | API base URL (`--url` wins over env) |
| `--token <token>` | `$SERVER_TOKEN` | Server token (`x-server-token` header) |
| `--provider <name>` | — | Bulk filter: `gcs` \| `codesandbox` \| `codespaces` (ignored with `--id`) |
| `--id <vpsId>` | — | Single VPS id (switches to `POST /vps/:id/status/refresh`) |
| `--force` | off | Bypass TTL/status cache (`?force=true`, re-hits provider) |
| `--json` | off | Print raw JSON and exit (no table) |
| `--help`, `-h` | — | Show help |

### Output

Single mode prints the persisted VPS row:

```
  id              : 9951be32-…
  provider        : codespaces
  name            : vm-manager232
  credentialFile  : vm-manager232.json
  fingerprint     : sha256:…
  sessionActive   : false
  createdAt       : 2026-09-01T02:13:37.725Z
  updatedAt       : 2026-09-01T02:13:37.725Z
  statusCheckedAt : 2026-09-03T15:15:39.785Z
  status          : ✓ AVAILABLE  (checkedAt: 2026-09-03T15:15:39.810Z)
  plan            : free  adoptable=1  validated=true
  localActive     : 0
  quotas:
    - Codespaces compute (core-hours) — core-hours/month  usage=7.7  limit=120  remaining=112.3
    - Codespaces storage (GB-month) — GB-month/month  usage=—  limit=15  remaining=—
```

Bulk mode prints `Total / Succeeded (≠ UNKNOWN) / Failed (= UNKNOWN)` and a per-VPS line (`✓` AVAILABLE, `◐` LIMITED, `⛔` QUOTA_EXHAUSTED, `○` UNAVAILABLE, `✗` INVALID/EXPIRED, `?` UNKNOWN). When ≤ 10 results it also fetches `GET /vps/:id` for each to show `quotas[].name`.

With `--json`, the raw API response is printed (useful with `jq`).

### Exit codes

- `0` — success.
- `1` — HTTP error, invalid `--provider`, missing token, or network failure.

### Related

- Spec: `ai/LAB-012_vps-status/spec.md` (US-2 … US-4)
- Smoke tests: `tests/http/LAB-012-vps-status.http` (§48 single, §49 bulk)
- Env TTL: `VPS_STATUS_TTL_MINUTES` in `.env.example` (default 5)

---

## seed-credentials.js

Bulk-imports credential files from a local directory into `vps` via `POST /api/v1/vps`.

```bash
node scripts/seed-credentials.js [options]
node scripts/seed-credentials.js --base-dir ./credentials --url http://localhost:3000 --token xxx
npm run seed-credentials -- --base-dir ./credentials
```

| Flag | Default | Description |
|---|---|---|
| `--base-dir <path>` | `./credentials` | Directory to scan |
| `--url <url>` | `http://localhost:3000` | API base URL |
| `--token <token>` | `$SERVER_TOKEN` | Server token |

Expected layout:

```
<base-dir>/
  gcs/          or  gcloud/     → provider "gcs"
  codesandbox/                  → provider "codesandbox"
  codespaces/                   → provider "codespaces"
```

Only `.json` and `.txt` files are processed. `409 VPS_ALREADY_EXISTS` / `VPS_DUPLICATE_TOKEN` are treated as skipped (not failures).

---

## check-codespaces-create.sh

Validates a GitHub PAT and whether the account can **adopt** (or create) a Codespace. Mirrors the backend's adopt-don't-create flow (`listCodespaces` first).

```bash
./scripts/check-codespaces-create.sh <credential.json> [codespace-name]
GH_BIN=gh ./scripts/check-codespaces-create.sh credentials/codespaces/vm-manager232.json
```

- `<credential.json>` — JSON `{ "token": "ghp_…" }` or plain-text PAT.
- Requires `gh` on `PATH` (or `GH_BIN` env).
- Reports login, existing codespace count, first codespace name, and whether GitHub permits a new `POST /user/codespaces` (throttle is `429`).

---

## test-codesandbox-api.sh

Smoke-tests a CodeSandbox API token with the official `@codesandbox/sdk`: creates a sandbox, runs `echo codesandbox-api-ok && pwd` via the SDK, then deletes it.

```bash
./scripts/test-codesandbox-api.sh
KEEP_SANDBOX=1 SANDBOX_TITLE=my-test ./scripts/test-codesandbox-api.sh
ENV_FILE=/path/to/.env ./scripts/test-codesandbox-api.sh
```

Requires `.env` with `CSB_API_KEY` or `CODESANDBOX_API_KEY`. Uses a temp directory (`mktemp`) and cleans up on exit. Set `KEEP_SANDBOX=1` to keep the sandbox after the run.

---

## Environment

Common variables (see `scripts/.env.example` and the root `.env.example`):

- `SERVER_TOKEN` — required by `refresh-vps-status.js` / `seed-credentials.js` (`x-server-token` header).
- `PWD_API_URL` — base URL for `refresh-vps-status.js` / `seed-credentials.js` (default `http://localhost:$PORT` → `http://localhost:3000`; `--url` flag wins).
- `PORT` — fallback for `PWD_API_URL` when it is not set (`http://localhost:$PORT`).
- `VPS_STATUS_TTL_MINUTES` — TTL for `refresh-vps-status.js` cache bypass (`--force` ignores it). Server env (root `.env.example`).
- `CSB_API_KEY` / `CODESANDBOX_API_KEY` — for `test-codesandbox-api.sh`.
- `GH_BIN` — `gh` binary path for `check-codespaces-create.sh`.
- `CODESPACES_DEFAULT_REPOSITORY_ID` — repo id probed by `check-codespaces-create.sh` when testing creation throttle.
- `ENV_FILE` — custom env file for `test-codesandbox-api.sh` (default `<repo>/.env`).
