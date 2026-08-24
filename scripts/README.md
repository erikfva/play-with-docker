# Codespace VM Scripts

Create, list, or delete GitHub Codespace VMs using `codespace-vm.js`.

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
node scripts/codespace-vm.js \
  --credentials /config/workspace/play-with-docker/github-auth.json \
  --action list
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

Fetch CodeSandbox workspace credit usage via the dashboard (SDK `api.codesandbox.io` exposes only `rate_limits`; credits are UI-only). Authenticates with GitHub via Playwright, then scrapes `https://codesandbox.io/dashboard` → `View usage`.

```bash
# GitHub session from storageState (created by ai-brain/github/github-auth.js or /mnt/s3/github/<user>/github.json)
node scripts/get-codesandbox-credits.js \
  --credentials /mnt/s3/github/vm-manager123/github.json --json --headful

# With xvfb on headless servers (bypasses Cloudflare "Just a moment")
xvfb-run -a --server-args="-screen 0 1366x850x24" \
  node scripts/get-codesandbox-credits.js \
  --credentials /mnt/s3/github/vm-manager123/github.json --json --headful

# Specific workspace
node scripts/get-codesandbox-credits.js \
  --credentials ./github-auth.json --workspace ws_Sh4V5DwQDYJDBRgDKhm79X --json

# Debug (saves debug-codesandbox-credits.html/.png)
DEBUG=1 xvfb-run -a node scripts/get-codesandbox-credits.js \
  --credentials /mnt/s3/github/vm-manager123/github.json --headful
```

Options:

- `--credentials <path>`: Playwright `storageState` JSON with GitHub cookies (`GITHUB_AUTH_FILE` env also honored). Created via `node ai-brain/github/github-auth.js --user <u> --password <p> --output <path>`.
- `--workspace <id>`: CodeSandbox workspace/team id (`ws_...` from `GET /meta/info` `auth.team`). If omitted, uses dashboard default.
- `--json`: Output raw JSON only.
- `--headful` / `--headless`: Force headed/headless. Dashboard is Cloudflare-protected; `headful` + `xvfb-run` is required on servers.
- `DEBUG=1`: Saves `debug-codesandbox-credits.html` and screenshot on failure.

Output:

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

Notes:

- Requires `npx playwright install chrome` (or `chromium`) once per host.
- `etecnologysys` (`275/400` `4 Aug–4 Sep 2026`) needs its own GitHub session file (e.g. `/mnt/s3/github/etechnologysys/github.json`); the `csb_v1_...` API token alone cannot read the dashboard — `src/services/providers/codesandbox-provider.js:211` probes `api.codesandbox.io/billing` with `Bearer` and correctly returns `quotas[2].usage:null` with limitation pointing to `https://codesandbox.io/dashboard?workspace=<team>`.
- Implementation: `scripts/get-codesandbox-credits.js:57` handles `Just a moment` + `__Host` OAuth, `extractCredits()` parses `400 / 400 credits` and `View usage` detail.
