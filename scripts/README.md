# scripts

Helper scripts for local development, credential seeding, and provider diagnostics.

| Script | Purpose |
|---|---|
| [`refresh-vps-status.js`](#refresh-vps-statusjs) | Refresh persisted VPS credential status via LAB-012 endpoints (bulk or single) |
| [`seed-credentials.js`](#seed-credentialsjs) | Bulk-import credential files from a local directory into `vps` |
| [`check-codespaces-create.sh`](#check-codespaces-createsh) | Validate a GitHub PAT and whether the account can adopt / create a Codespace |
| [`test-codesandbox-api.sh`](#test-codesandbox-apish) | Smoke-test a CodeSandbox API token with the official SDK |
| [`get-codesandbox-credits.js`](#get-codesandbox-creditsjs) | Fetch CodeSandbox workspace credits via browser webscraping (standalone) |
| [`refresh-codesandbox-credits.js`](#refresh-codesandbox-creditsjs) | Run the credits scraper once per codesandbox credential (batch) |
| [`codesandbox-auth.js`](#codesandbox-authjs) | Save a CodeSandbox Playwright storageState for reuse by the scraper |
| [`auth-browser.js`](#auth-browserjs) | Shared `playwright-core` wrapper (Chromium launcher + stealth + storageState) |

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

## get-codesandbox-credits.js

Fetch CodeSandbox workspace credit usage via browser webscraping — supports three modes: **GitHub OAuth / Google OAuth / CodeSandbox direct `storageState` (fastest, no re-OAuth)**. Scrapes `https://codesandbox.io/dashboard` (`Included credits` / `Credits used` / billing period). Defaults to JSON output, headful via `xvfb-run` on headless VPS. Ported from PR #9 — see `ai/LAB-009_provider-credential-status/plan-codesandbox.md`.

### GitHub / Google OAuth (browser — generates `codesandbox-web` session for reuse)

```bash
node scripts/get-codesandbox-credits.js --credentials /mnt/s3/github/vm-manager123/github.json
node scripts/get-codesandbox-credits.js --credentials /mnt/s3/github/vm-manager123/github.json --workspace ws_Sh4V5DwQDYJDBRgDKhm79X
node scripts/get-codesandbox-credits.js --google-credentials /mnt/s3/google/etecnologysys/google.json
node scripts/get-codesandbox-credits.js --google-credentials /mnt/s3/google/simca.scz/google.json --save-state /mnt/s3/codesandbox-web/simca.scz.json --json
```

### CodeSandbox direct mode (reuse saved session — fastest, no GitHub/Google re-OAuth)

```bash
node scripts/get-codesandbox-credits.js --codesandbox-credentials /mnt/s3/codesandbox-web/simcascz-svg.json --json
CODESANDBOX_AUTH_FILE=/mnt/s3/codesandbox-web/simca.scz.json node scripts/get-codesandbox-credits.js --json
```

### Saving a session for reuse (mirrors `github-auth.js --output`)

```bash
node scripts/get-codesandbox-credits.js --google-credentials /mnt/s3/google/simca.scz/google.json --save-state /mnt/s3/codesandbox-web/simca.scz.json --json
node scripts/codesandbox-auth.js --google-credentials /mnt/s3/google/simca.scz/google.json --output /mnt/s3/codesandbox-web/simca.scz.json
```

Saved files are Playwright `storageState` JSON (`{cookies, origins}`) stored in `credentials/codesandbox-web/` (mounted as `/mnt/s3/codesandbox-web` inside the container via `docker-compose.yml` `./credentials:/mnt/s3`). `--save-state` only writes on `ok:true`; on `ok:false` the script auto-retries once and warns instead of overwriting — if no file existed it saves a small failure state for debugging (delete before retry).

### Batch generation for all GitHub credentials

```bash
mkdir -p /mnt/s3/codesandbox-web
for d in /mnt/s3/github/*; do [ -d "$d" ] || continue; name=$(basename "$d"); [ -f "/mnt/s3/codesandbox-web/$name.json" ] && echo "SKIP $name" && continue; timeout 240 node scripts/codesandbox-auth.js --credentials "$d/github.json" --output "/mnt/s3/codesandbox-web/$name.json" || echo "FAILED $name"; done
ls -lh /mnt/s3/codesandbox-web
```

### Headless VPS / Cloudflare

On a server with no `$DISPLAY`, the script auto re-executes under `xvfb-run` (headed Chromium) to pass Cloudflare's `Just a moment` challenge. Requires `playwright-core` + Chromium (`npx playwright install chromium`) once per host — or run inside the `mcr.microsoft.com/playwright` image which already ships both. On a local host `xvfb-run` is required for headed mode (`apt-get install xvfb`).

### All options

| Flag | Description |
|---|---|
| `--credentials <path>` | Playwright `storageState` for GitHub (`$GITHUB_AUTH_FILE` also honored) |
| `--google-credentials <path>` | Playwright `storageState` for Google (`$GOOGLE_AUTH_FILE` also honored) |
| `--codesandbox-credentials <path>` | Playwright `storageState` for CodeSandbox directly (`$CODESANDBOX_AUTH_FILE` also honored) — created via `--save-state` / `codesandbox-auth.js --output` |
| `--save-state <path>` | Aliases `--save-codesandbox-state`, `--save-auth` — save CodeSandbox `storageState` for reuse |
| `--workspace <id>` | CodeSandbox workspace/team id (`ws_…`) |
| `--vps-id <id>` | VPS row to update — mandatory unless `--vps-name` given (`$CODESANDBOX_VPS_ID` also honored) |
| `--vps-name <name>` | VPS / credential name to update, e.g. `vm-manager232` — mandatory unless `--vps-id` given (`$CODESANDBOX_VPS_NAME` also honored; browser auth file basename counts too) |
| `--no-json` | Human-readable output (default is JSON) |
| `--headless` | Force headless, skip auto `xvfb-run` |
| `DEBUG=1` | Save `debug-codesandbox-credits.html` + screenshot on failure |

Browser credentials are required — without them the script exits with an error. A VPS target (`--vps-id` or `--vps-name`) is likewise mandatory unless `--no-update` is passed. Output example:

```json
{ "ok": true, "team": "ws_Sh4V5DwQDYJDBRgDKhm79X", "url": "https://codesandbox.io/t/usage?workspace=ws_Sh4V5DwQDYJDBRgDKhm79X", "billingPeriod": "8 August – 8 September 2026", "includedCredits": 400, "usedCredits": 403, "remainingCredits": 0, "freeCreditsUsed": 403, "sandboxes": { "used": 0, "limit": 5 } }
```

The scrape merges a `Credits (billing cycle)` quota via `PATCH /api/v1/vps/:id/status/billing` without touching `statusCheckedAt` (that column tracks provider credential checks, not scrapes).

---

## refresh-codesandbox-credits.js

Batch runner for `get-codesandbox-credits.js` — lists all `codesandbox` VPS rows, matches each to its browser session file `<vps-name>.json` (`$CODESANDBOX_WEB_CREDENTIALS_DIR`, `/mnt/s3/codesandbox-web`, or `credentials/codesandbox-web`), and spawns the scraper sequentially with `--vps-id`. Rows without a matching session file are skipped (reported, not failed). Fresh billing per `CODESANDBOX_SCRAPER_TTL` is skipped by the child itself.

```bash
node scripts/refresh-codesandbox-credits.js
node scripts/refresh-codesandbox-credits.js --name vm-manager232
node scripts/refresh-codesandbox-credits.js --id df0cb683-1396-4006-a74b-56d12292ae52
node scripts/refresh-codesandbox-credits.js --dry-run
node scripts/refresh-codesandbox-credits.js --timeout-minutes 15 --url http://localhost:3200
```

Options: `--url`, `--token`, `--id`, `--name <substr>`, `--timeout-minutes` (default 10), `--no-update` / `--headless` (passed through), `--dry-run`, `--help`. Exits `1` when any credential run fails.

---

## codesandbox-auth.js

Thin wrapper around `get-codesandbox-credits.js --save-state` with `github-auth.js`-style `--output`. Priority: `--codesandbox-credentials` > `--google-credentials` > `--credentials`. Honors `$CODESANDBOX_AUTH_FILE`/`$GOOGLE_AUTH_FILE`/`$GITHUB_AUTH_FILE`.

```bash
node scripts/codesandbox-auth.js --google-credentials /mnt/s3/google/simca.scz/google.json --output ./playwright/.auth/codesandbox.json
node scripts/codesandbox-auth.js --credentials /mnt/s3/github/vm-manager123/github.json --output ./playwright/.auth/codesandbox.json
node scripts/codesandbox-auth.js --codesandbox-credentials ./playwright/.auth/codesandbox.json --output ./playwright/.auth/codesandbox.json  # refresh
node scripts/codesandbox-auth.js --help  # full usage + examples (priority, env fallbacks)
```

Inside Docker:
```bash
docker exec play-with-docker-app-1 bash -c "timeout 180 node scripts/codesandbox-auth.js --google-credentials /mnt/s3/google/etecnologysys/google.json --output /tmp/etecnologysys.json && ls -lh /tmp/etecnologysys.json"
docker cp play-with-docker-app-1:/tmp/etecnologysys.json credentials/codesandbox-web/etecnologysys.json
```

---

## auth-browser.js

Shared `playwright-core` wrapper used by all browser-based scripts (`get-codesandbox-credits.js`, `codesandbox-auth.js`). Exports `launchBrowserWithStorageState`, `launchGitHubBrowser`, `ensureSignedIn`, `STEALTH_SCRIPT`, `closeBrowser`. Auto-discovers any installed Chromium binary regardless of Playwright revision, so `npx playwright install chromium` is only needed once.

Required by `get-codesandbox-credits.js` for both Cloudflare bypass and OAuth flows — see `scripts/auth-browser.js:1` for the full API.

---

## Environment

Common variables (see `scripts/.env.example`):

- `SERVER_TOKEN` — required by `refresh-vps-status.js` / `seed-credentials.js` (`x-server-token` header).
- `PWD_API_URL` — base URL for `refresh-vps-status.js` / `seed-credentials.js` (default `http://localhost:$PORT` → `http://localhost:3000`; `--url` flag wins).
- `PORT` — fallback for `PWD_API_URL` when it is not set (`http://localhost:$PORT`).
- `CSB_API_KEY` / `CODESANDBOX_API_KEY` — for `test-codesandbox-api.sh`.
- `GH_BIN` — `gh` binary path for `check-codespaces-create.sh`.
- `CODESPACES_DEFAULT_REPOSITORY_ID` — repo id probed by `check-codespaces-create.sh` when testing creation throttle.
- `ENV_FILE` — custom env file for `test-codesandbox-api.sh` (default `<repo>/.env`).
- `CODESANDBOX_WORKSPACE` / `GITHUB_AUTH_FILE` / `GOOGLE_AUTH_FILE` / `CODESANDBOX_AUTH_FILE` / `CODESANDBOX_SAVE_STATE` — honored by `get-codesandbox-credits.js` / `auth-browser.js`.
- `CODESANDBOX_VPS_ID` / `CODESANDBOX_VPS_NAME` — default VPS target for `get-codesandbox-credits.js` (`--vps-id` / `--vps-name` flags win; the browser auth file basename also counts as credential name).
- `CODESANDBOX_SCRAPER_TTL` (minutes, default `60`) — minimal billing freshness; the scraper skips the browser run while the stored Credits quota `fetchedAt + TTL` is still in the future (`0` = always scrape).
- `CODESANDBOX_WEB_CREDENTIALS_DIR` — session-file lookup dir for `refresh-codesandbox-credits.js` (default `/mnt/s3/codesandbox-web`, fallback `credentials/codesandbox-web`).
- `VPS_STATUS_TTL_MINUTES` — TTL for `refresh-vps-status.js` cache bypass (`--force` ignores it) — server env (root `.env.example`).
