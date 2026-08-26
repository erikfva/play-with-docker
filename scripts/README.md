# Scripts

Utility scripts for managing Codespace VMs, listing codespaces, and checking CodeSandbox credits.

## Shared Module

All browser-based scripts depend on `auth-browser.js`, which wraps `playwright-core` for launching Chromium with GitHub or Google Playwright `storageState` files. It auto-discovers any installed Chromium binary regardless of Playwright revision, so `npx playwright install chromium` is only needed once.

## Create A Codespace VM

```bash
node scripts/codespace-vm.js \
  --credentials /config/workspace/play-with-docker/github-auth.json \
  --action create
```

Create and stop the Codespace after it appears in the Codespaces list:

```bash
node scripts/codespace-vm.js \
  --credentials /config/workspace/play-with-docker/github-auth.json \
  --action create \
  --stop
```

Create without waiting for the Codespace to appear in `/codespaces`:

```bash
node scripts/codespace-vm.js \
  --credentials /config/workspace/play-with-docker/github-auth.json \
  --action create \
  --no-wait
```

Create options:

- `--credentials <path>`: Required. Playwright storage-state file created by `github-auth.js`.
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
  --credentials /config/workspace/play-with-docker/github-auth.json \
  --action delete \
  --target <codespace-name-or-slug>
```

Stop and delete an active Codespace:

```bash
node scripts/codespace-vm.js \
  --credentials /config/workspace/play-with-docker/github-auth.json \
  --action delete \
  --target <codespace-name-or-slug> \
  --force
```

Delete options:

- `--credentials <path>`: Required. Playwright storage-state file created by `github-auth.js`.
- `--action delete`: Required.
- `--target <name-or-slug>`: Required. Codespace name or slug to delete.
- `--force`: Stop an active Codespace before deleting it.

## Get CodeSandbox Credits

Fetch CodeSandbox workspace credit usage. Supports three modes: API-only (no browser), GitHub OAuth, and Google OAuth.

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
```

### Headless VPS behavior

On a server with no `$DISPLAY`, the script auto-detects this and re-executes itself under `xvfb-run` when browser mode is needed. This passes Cloudflare's "Just a moment" challenge that blocks headless Chromium. No manual `xvfb-run` wrapping is required.

When no credentials of any kind are provided (no `--credentials`, `--google-credentials`, `GITHUB_AUTH_FILE`, or `GOOGLE_AUTH_FILE`), the script automatically falls back to API-only mode.

### All options

- `--api-only`: Use CodeSandbox API directly (no browser). Uses `--token-file` or `CODESANDBOX_TOKEN` env.
- `--token-file <path>`: CodeSandbox API token file (JSON `{token:...}` or plain text).
- `--credentials <path>`: Playwright `storageState` for GitHub (`GITHUB_AUTH_FILE` env also honored).
- `--google-credentials <path>`: Playwright `storageState` for Google (`GOOGLE_AUTH_FILE` env also honored).
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
