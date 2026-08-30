# Scripts

Utility scripts for managing Codespace VMs, listing codespaces, and checking CodeSandbox credits.

## Shared Module

All browser-based scripts depend on `auth-browser.js`, which wraps `playwright-core` for launching Chromium with GitHub, Google, or CodeSandbox Playwright `storageState` files (`launchBrowserWithStorageState`, `launchGitHubBrowser`, `ensureSignedIn`). It auto-discovers any installed Chromium binary regardless of Playwright revision, so `npx playwright install chromium` is only needed once. Inside Docker, the host folder `./credentials` is mounted as `/mnt/s3` (`docker-compose.yml` `./credentials:/mnt/s3`), so host `credentials/codesandbox-web/*.json` appears as `/mnt/s3/codesandbox-web/*.json` in the container.

## Create A Codespace VM

```bash
# storageState created by ai-brain/github/github-auth.js --output
node scripts/codespace-vm.js \
  --credentials /mnt/s3/github/vm-manager123/github.json \
  --action create
# host path: credentials/github/vm-manager123/github.json
```

Create and stop the Codespace after it appears in the Codespaces list:

```bash
node scripts/codespace-vm.js \
  --credentials /mnt/s3/github/vm-manager123/github.json \
  --action create \
  --stop
```

Create without waiting for the Codespace to appear in `/codespaces`:

```bash
node scripts/codespace-vm.js \
  --credentials /mnt/s3/github/vm-manager123/github.json \
  --action create \
  --no-wait
```

Create options:

- `--credentials <path>`: Required. Playwright `storageState` file created by `ai-brain/github/github-auth.js --output` (e.g. `credentials/github/<name>/github.json` → `/mnt/s3/github/<name>/github.json` in container).
- `--action create`: Required.
- `--template <name>`: Template name. Defaults to `blank`.
- `--stop`: Stop the Codespace after creation.
- `--no-wait`: Do not wait for the Codespace to appear in the Codespaces list.

## List Codespace VMs

```bash
node scripts/list-codespaces.js \
  --credentials /mnt/s3/github/vm-manager123/github.json
```

List options:

- `--credentials <path>`: Required. Playwright storage-state file created by `github-auth.js`.
- `--action list`: Required.

## Delete A Codespace VM

```bash
node scripts/codespace-vm.js \
  --credentials /mnt/s3/github/vm-manager123/github.json \
  --action delete \
  --target <codespace-name-or-slug>
```

Stop and delete an active Codespace:

```bash
node scripts/codespace-vm.js \
  --credentials /mnt/s3/github/vm-manager123/github.json \
  --action delete \
  --target <codespace-name-or-slug> \
  --force
```

Delete options:

- `--credentials <path>`: Required. Playwright `storageState` file created by `ai-brain/github/github-auth.js --output`.
- `--action delete`: Required.
- `--target <name-or-slug>`: Required. Codespace name or slug to delete.
- `--force`: Stop an active Codespace before deleting it.

## Get CodeSandbox Credits

Fetch CodeSandbox workspace credit usage. Supports four modes: API-only (no browser), GitHub OAuth, Google OAuth, and direct CodeSandbox `storageState` (fastest, no re-OAuth).

**Defaults:** JSON output, headful mode (auto `xvfb-run` on headless VPS). No extra flags needed.

### API-only mode (no browser required)

Validates the CodeSandbox API token and returns rate limits. Dashboard credits are not exposed by the API, so credit fields will be `null` with a `_note` suggesting the dashboard URL.

```bash
# Auto-discovers token from credentials/codesandbox/*.json
node scripts/get-codesandbox-credits.js --api-only

# Explicit token file
node scripts/get-codesandbox-credits.js --api-only \
  --token-file ./credentials/codesandbox/vm-manager1.json

# Or set env var
CODESANDBOX_TOKEN=csb_v1_... node scripts/get-codesandbox-credits.js --api-only
```

### GitHub OAuth mode

Signs in to CodeSandbox via GitHub OAuth using a Playwright `storageState` file, then scrapes the dashboard for credit data.

```bash
node scripts/get-codesandbox-credits.js \
  --credentials /mnt/s3/github/vm-manager123/github.json

# Specific workspace
node scripts/get-codesandbox-credits.js \
  --credentials /mnt/s3/github/vm-manager123/github.json \
  --workspace ws_Sh4V5DwQDYJDBRgDKhm79X
```

### Google OAuth mode

Signs in to CodeSandbox via Google OAuth using a Google Playwright `storageState` file (cookies from `accounts.google.com`).

```bash
node scripts/get-codesandbox-credits.js \
  --google-credentials /mnt/s3/google/etecnologysys/google.json

# Also works with simca.scz
node scripts/get-codesandbox-credits.js \
  --google-credentials /mnt/s3/google/simca.scz/google.json
```

### CodeSandbox direct mode (no GitHub/Google re-OAuth)

Reuses a previously saved CodeSandbox Playwright `storageState` (like `github-auth.js --output`). This is the fastest mode — it goes straight to `https://codesandbox.io/dashboard` with minimal `webdriver` stealth and light Cloudflare handling, avoiding the Google `challenge/pwd` step that can block VPS IPs.

```bash
# Reuse saved session (created via --save-state or codesandbox-auth.js)
node scripts/get-codesandbox-credits.js \
  --codesandbox-credentials /mnt/s3/codesandbox-web/simcascz-svg.json

# Or via env var (same as GITHUB_AUTH_FILE / GOOGLE_AUTH_FILE)
CODESANDBOX_AUTH_FILE=/mnt/s3/codesandbox-web/simca.scz.json \
  node scripts/get-codesandbox-credits.js --json

# Inside Docker, the host folder ./credentials/codesandbox-web maps to /mnt/s3/codesandbox-web
# Host path: ./credentials/codesandbox-web/simca.scz.json
```

### Saving a CodeSandbox session for reuse

Save the CodeSandbox cookies after a successful GitHub/Google login so subsequent runs don't need OAuth (mirrors `ai-brain/github/github-auth.js --output`).

```bash
# One-liner: login via Google and save + validate credits
node scripts/get-codesandbox-credits.js \
  --google-credentials /mnt/s3/google/simca.scz/google.json \
  --save-state /mnt/s3/codesandbox-web/simca.scz.json --json
# → CodeSandbox session saved to /mnt/s3/codesandbox-web/simca.scz.json (reuse with --codesandbox-credentials ...)

# Via GitHub
node scripts/get-codesandbox-credits.js \
  --credentials /mnt/s3/github/vm-manager123/github.json \
  --save-state /mnt/s3/codesandbox-web/vm-manager123.json --json

# Standalone wrapper (same as above, explicit --output) — run on host (host /mnt/s3 is the S3 mount)
node scripts/codesandbox-auth.js \
  --google-credentials /mnt/s3/google/simca.scz/google.json \
  --output /mnt/s3/codesandbox-web/simca.scz.json

node scripts/codesandbox-auth.js \
  --credentials /mnt/s3/github/vm-manager123/github.json \
  --output /mnt/s3/codesandbox-web/vm-manager123.json

# Inside Docker the mount is ro, so use /tmp then copy:
docker exec play-with-docker-app-1 bash -c "timeout 180 node scripts/codesandbox-auth.js --google-credentials /mnt/s3/google/etecnologysys/google.json --output /tmp/etecnologysys.json && ls -lh /tmp/etecnologysys.json"
docker cp play-with-docker-app-1:/tmp/etecnologysys.json credentials/codesandbox-web/etecnologysys.json
# or via get-codesandbox-credits.js directly inside Docker:
docker exec play-with-docker-app-1 bash -c "timeout 180 node scripts/get-codesandbox-credits.js --google-credentials /mnt/s3/google/etecnologysys/google.json --save-state /tmp/etecnologysys.json --json"

# Refresh an existing CodeSandbox session
node scripts/codesandbox-auth.js \
  --codesandbox-credentials /mnt/s3/codesandbox-web/simca.scz.json \
  --output /mnt/s3/codesandbox-web/simca.scz.json
```

Saved files are standard Playwright `storageState` JSON (`{cookies, origins}`) stored in `credentials/codesandbox-web/` on the host (mounted as `/mnt/s3/codesandbox-web` inside the container via `docker-compose.yml` `./credentials:/mnt/s3`). `--save-state` only writes on `ok:true`; on `ok:false` (e.g. cold Cloudflare cache) the script auto-retries once after 5s and warns `Not saving storageState ... not overwriting existing file` — if no file existed it saves a small failure state for debugging (delete before retry). If the session expires, the script warns `CodeSandbox storageState expired … Re-create it with: node scripts/get-codesandbox-credits.js --google-credentials <google.json> --save-state <csb.json>`.

### Batch: generate for all GitHub credentials

```bash
mkdir -p /mnt/s3/codesandbox-web
for d in /mnt/s3/github/*; do
  [ -d "$d" ] || continue
  name=$(basename "$d")
  [ -f "/mnt/s3/codesandbox-web/$name.json" ] && echo "SKIP $name already exists" && continue
  echo "Generating $name..."
  timeout 240 node scripts/codesandbox-auth.js \
    --credentials "$d/github.json" \
    --output "/mnt/s3/codesandbox-web/$name.json" || echo "FAILED $name"
done
ls -lh /mnt/s3/codesandbox-web
# known failures: etecnologysys-byte → ok:false not authorized (needs codesandbox.io/signin → Authorize),
# vmmanager-1 → GitHub session expired (re-run ai-brain/github/github-auth.js)
```

### codesandbox-auth.js (wrapper)

Thin wrapper around `get-codesandbox-credits.js --save-state` with `ai-brain/github/github-auth.js`-style `--output`. Priority: `--codesandbox-credentials` > `--google-credentials` > `--credentials`. Honors `CODESANDBOX_AUTH_FILE`/`GOOGLE_AUTH_FILE`/`GITHUB_AUTH_FILE` env vars. See `scripts/codesandbox-auth.js:1` for usage.

### Headless VPS behavior

On a server with no `$DISPLAY`, the script auto-detects this and re-executes itself under `xvfb-run` when browser mode is needed. This passes Cloudflare's "Just a moment" challenge that blocks headless Chromium. No manual `xvfb-run` wrapping is required.

When no credentials of any kind are provided (no `--credentials`, `--google-credentials`, `--codesandbox-credentials`, `GITHUB_AUTH_FILE`, `GOOGLE_AUTH_FILE`, or `CODESANDBOX_AUTH_FILE`), the script automatically falls back to API-only mode.

### All options

- `--api-only`: Use CodeSandbox API directly (no browser). Uses `--token-file` or `CODESANDBOX_TOKEN` env.
- `--token-file <path>`: CodeSandbox API token file (JSON `{token:...}` or plain text).
- `--credentials <path>`: Playwright `storageState` for GitHub (`GITHUB_AUTH_FILE` env also honored).
- `--google-credentials <path>`: Playwright `storageState` for Google (`GOOGLE_AUTH_FILE` env also honored).
- `--codesandbox-credentials <path>` (aliases `--cs-credentials`, `--csb-credentials`): Playwright `storageState` for CodeSandbox directly (`CODESANDBOX_AUTH_FILE` env also honored). Created via `--save-state` or `scripts/codesandbox-auth.js --output`.
- `--save-state <path>` (aliases `--save-codesandbox-state`, `--save-auth`): After successful browser login, save CodeSandbox `storageState` to `<path>` for reuse.
- `--workspace <id>`: CodeSandbox workspace/team id (`ws_...`).
- `--no-json`: Output human-readable text instead of JSON (JSON is the default).
- `--headless`: Force headless mode, skip auto `xvfb-run`.
- `DEBUG=1`: Saves `debug-codesandbox-credits.html` and screenshot on failure.

### Output example

```json
{
  "ok": true,
  "team": "ws_Sh4V5DwQDYJDBRgDKhm79X",
  "url": "https://codesandbox.io/t/usage?workspace=ws_Sh4V5DwQDYJDBRgDKhm79X",
  "billingPeriod": "8 August – 8 September 2026",
  "includedCredits": 400,
  "usedCredits": 403,
  "remainingCredits": 0,
  "freeCreditsUsed": 403,
  "sandboxes": { "used": 0, "limit": 5 }
}
```

### Notes

- Requires `npx playwright install chromium` once per host for browser mode.
- The CodeSandbox API (`api.codesandbox.io/meta/info`) does not expose billing/credits — only rate limits and auth scopes. Credits are only available via dashboard scraping.
- If a GitHub credential hasn't authorized CodeSandbox via OAuth yet, the script exits `0` with a `_note` explaining how to complete the authorization in an interactive browser.
