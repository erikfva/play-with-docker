# LAB-009: CodeSandbox Credits Scraping Integration Plan

**Spec**: `ai/LAB-009_provider-credential-status/spec.md` (§10.2)
**Depends on**: `plan-codesandbox.md` — read first for the API layer and `getCredentialStatus` method
**Last Updated**: 2026-08-29

---

## Problem Statement

The CodeSandbox API (`GET /meta/info`) exposes token validity and live rate-limit
headroom (`concurrent_vms`, `sandboxes_hourly`), but does **not** expose credit
balance. Credits are only visible on the CodeSandbox web dashboard
(`https://codesandbox.io/t/usage?workspace=ws_...`), which is protected by
Cloudflare and requires a cookie-authenticated browser session.

All 30+ attempts to probe `api.codesandbox.io` with a `Bearer csb_v1_...` token
for billing/credits endpoints returned 404/403. Scraping the dashboard is the
only way to get live credit balance, and `scripts/get-codesandbox-credits.js`
already does this reliably.

---

## Existing Assets

### `scripts/get-codesandbox-credits.js`

The primary scraping script. Supports four modes:

| Mode | Trigger | Description |
|---|---|---|
| `--api-only` | Default when no credentials supplied | Calls `GET /meta/info`, returns rate limits only; `credits` fields are null |
| `--credentials <github.json>` | GitHub Playwright `storageState` | GitHub OAuth → CodeSandbox dashboard → extract credits |
| `--google-credentials <google.json>` | Google Playwright `storageState` | Google OAuth → CodeSandbox dashboard → extract credits |
| `--codesandbox-credentials <csb.json>` | CodeSandbox Playwright `storageState` | Direct to dashboard, no OAuth needed — **fastest mode, preferred** |

Key capabilities:
- Auto-detects headless VPS (`!process.env.DISPLAY`) and re-executes under `xvfb-run -a --server-args="-screen 0 1366x850x24"` automatically. The re-execution sets `_XVFB_REEXEC=1` to prevent loops.
- Cloudflare bypass: `waitForCloudflare()` + `--disable-blink-features=AutomationControlled` + stealth script (`navigator.webdriver = undefined`, `chrome.runtime`).
- Navigates to `/dashboard`, clicks `View usage` → `https://codesandbox.io/t/usage?workspace=ws_...` for detailed data.
- Parses credit data from page body text using regex (`Credits used`, `Included credits`, `X / Y credits`, `run out of credits`).
- `--save-state <path>`: saves the resulting CodeSandbox Playwright `storageState` for reuse.
- Returns JSON: `{ ok, team, url, billingPeriod, includedCredits, usedCredits, remainingCredits, freeCreditsUsed, sandboxes, vmsActive, fetchedAt }`.

### `scripts/codesandbox-auth.js`

Thin wrapper around `get-codesandbox-credits.js --save-state`. Used to create
and refresh CodeSandbox Playwright `storageState` files. Priority:
`--codesandbox-credentials` > `--google-credentials` > `--credentials`.

### `scripts/auth-browser.js`

Shared browser launcher. Key exports used by the scraping script:
- `launchBrowserWithStorageState(stateFile, opts)` — loads cookies/origins from a Playwright JSON.
- `launchGitHubBrowser(opts)` — uses the persistent Chrome profile dir.
- `ensureSignedIn(context)` — verifies GitHub session.
- `STEALTH_SCRIPT` — navigator.webdriver/plugins/languages hide for Cloudflare.

### `credentials/codesandbox-web/` — web session files

Playwright `storageState` JSON files (cookies + localStorage origins) for
CodeSandbox dashboard sessions. One file per account. Already present:

| File | Account |
|---|---|
| `etecnologysys.json` | etecnologysys (`ws_Eha5JM84UeHdXshrooLDTA`) |
| `simcascz-svg.json` | simca.scz (SVG) |
| `vm-manager123.json` | vm-manager123 (`ws_Sh4V5DwQDYJDBRgDKhm79X`) |
| `vm-manager123-1.json` | vm-manager123-1 (`ws_ThQtWFucY3Rxk6KQzhW3gW`) |
| `vm-manager232.json` | vm-manager232 |
| `vm-manager232-1.json` | vm-manager232-1 |
| `vm-manager232-santi.json` | vm-manager232-santi |
| `vm-manager234.json` | vm-manager234 |
| `vm-manager234-1.json` | vm-manager234-1 |
| `erikfva2.json` | erikfva2 |

These are **CodeSandbox web sessions** — distinct from the GitHub/Google sessions
in `credentials/github/` and `credentials/google/`. They are passed with
`--codesandbox-credentials`, which is the fastest scraping mode (no OAuth
redirect). They are created/refreshed via `codesandbox-auth.js`.

### `credentials/codesandbox/` — API token files

JSON files with `{ "token": "csb_v1_..." }`. These are loaded by
`credentials-loader.js` and passed to `getCredentialStatus`. The `meta.auth.team`
field from `GET /meta/info` returns the workspace ID (`ws_...`) that links an
API token to its corresponding web session file.

---

## The Mapping Problem

The scraping integration connects two things:
1. A **CodeSandbox API token** (`csb_v1_...`) from `credentials/codesandbox/`
2. A **CodeSandbox web session** (`storageState` JSON) from `credentials/codesandbox-web/`

These are linked via the workspace ID (`ws_...`) returned by `meta.auth.team`
when the token is validated via `GET /meta/info`. Both the API token and the web
session belong to the same CodeSandbox workspace/team.

The mapping is resolved at runtime — no hardcoded map is needed:
1. `getMetaInfo()` returns `meta.auth.team` (e.g. `ws_Eha5JM84UeHdXshrooLDTA`).
2. The scraper tries each `codesandbox-web/*.json` file by running the scraper
   script with `--codesandbox-credentials <file> --workspace <teamId>`.
3. The script returns `team: "ws_..."` (extracted from the page URL or
   localStorage). The scraper accepts the result when `parsed.team === teamId`.

---

## Current Implementation State

`src/services/providers/codesandbox/credits-scraper.js` **already exists** in
the codebase. The file implements:
- `scrapeCreditsForTeam(teamId, opts)` — main entry point
- `parseCreditsFromBody(bodyText)` — regex parser (shared with the CLI script logic)
- `candidateAuthFiles()` — discovers auth files to use
- `runScraperWithAuth(authFile, teamId, timeoutMs)` — spawns the CLI script
- TTL cache via `scrapeCache` Map
- Exports: `parseCreditsFromBody`, `scrapeCreditsForTeam`, `candidateAuthFiles`, `clearScrapeCache`, `getCachedScrape`, `putCachedScrape`

`src/services/providers/codesandbox-provider.js` **already has** `getCredentialStatus(loaded)` implemented with the scraping integration block.

The implementation is functional but has several issues documented below.

---

## Issues Found in the Current Implementation

### Issue 1: Wrong credential type — GitHub instead of CodeSandbox web sessions

**File**: `credits-scraper.js`, `candidateAuthFiles()` and `runScraperWithAuth()`

The current implementation discovers **GitHub** `storageState` files from
`/mnt/s3/github/*/github.json` and passes them with `--credentials` (GitHub
OAuth flow). This is wrong for two reasons:

1. `credentials/codesandbox-web/` already contains **CodeSandbox** `storageState`
   files, which are passed with `--codesandbox-credentials`. This mode skips
   GitHub/Google OAuth entirely, goes directly to the dashboard, and is faster
   and more reliable.

2. The hardcoded GitHub file list (`vm-manager123`, `vm-manager123-1`,
   `vm-manager232`, etc.) does not cover all accounts that have API tokens in
   `credentials/codesandbox/` (e.g. `etecnologysys`, `simca-scz1/2`,
   `sistemamedical`, `vm-manager1`, `vmmanager1`).

**Fix**: Replace `candidateAuthFiles()` with a function that discovers
`codesandbox-web/*.json` files from `CODESANDBOX_WEB_CREDENTIALS_DIR`, and
change `runScraperWithAuth` to pass `--codesandbox-credentials` instead of
`--credentials`.

### Issue 2: Parallel execution of Playwright instances

**File**: `credits-scraper.js`, `scrapeCreditsForTeam()`

The current implementation runs all candidates with `Promise.all`:
```javascript
const promises = candidates.map(authFile => runScraperWithAuth(...));
const results = await Promise.all(promises);
```

Each `runScraperWithAuth` call launches a full Chromium browser process via
`xvfb-run`. Running them in parallel means up to 10 simultaneous Chromium
instances competing for memory and CPU, likely causing OOM kills or all of them
failing the Cloudflare challenge. The scraper should stop at the first matching
result — there is no benefit to parallel execution here.

**Fix**: Change to a sequential `for` loop that breaks on the first matching
result. This also eliminates the "which result to use" ambiguity in
`results.find(r => r && ...)`.

### Issue 3: Null results are cached

**File**: `credits-scraper.js`, `scrapeCreditsForTeam()`

```javascript
const value = hit || null;
putCachedScrape(teamId, value);  // caches null when no candidates found
```

A `null` result means "no matching web credential found right now". This is not
a stable state — a new `codesandbox-web/*.json` file could be added. Caching
`null` for 5 minutes would suppress the benefit of a freshly created session
file.

**Fix**: Only cache non-null results. The cache's purpose is to avoid re-launching
Chromium when we already have a good result.

### Issue 4: Fragile JSON extraction from script stdout

**File**: `credits-scraper.js`, `runScraperWithAuth()`

```javascript
const jsonStart = stdout.indexOf('{');
const jsonEnd = stdout.lastIndexOf('}');
const jsonStr = stdout.slice(jsonStart, jsonEnd + 1);
```

This breaks when:
- Log lines contain `{` characters (e.g. object literals in console.log output).
- The script emits multiple JSON objects.
- stdout contains a trailing `}` from a log line after the JSON blob.

The script emits exactly one JSON object as its last block of structured output.
The regex `/\{[\s\S]*\}/` applied to the whole stdout, taking the last match, is
more robust.

**Fix**: Use a regex-based last-JSON-block extraction:
```javascript
const matches = [...stdout.matchAll(/\{[\s\S]*?\}/g)];
// Or, simpler: find the last { and match to its corresponding }
```

Actually the most robust approach is to find the last line that starts with `{`
(since the script always emits the JSON as the final output):
```javascript
const lines = stdout.split('\n');
const jsonLine = [...lines].reverse().find(l => l.trim().startsWith('{'));
```

### Issue 5: Limitation message leaks account names

**File**: `codesandbox-provider.js`, `getCredentialStatus()`

```javascript
'Dashboard credits (e.g. 400 included / 275 used for etecnologysys, 400/403 for vm-manager123) are rendered by...'
```

This embeds account-specific data (`etecnologysys`, `vm-manager123`) in an API
response that any authenticated user can see. These are internal deployment
details. The limitation message should be generic.

**Fix**: Remove account-specific examples from the limitation string. The
`details.referenceLimits.dashboardUrl` already points to the correct workspace
URL for the token being checked.

### Issue 6: `candidateAuthFiles()` ignores `CODESANDBOX_WEB_CREDENTIALS_DIR`

**File**: `credits-scraper.js`

The env variable `CODESANDBOX_WEB_CREDENTIALS_DIR` is mentioned in the original
plan as the configuration point for web session file location, but
`candidateAuthFiles()` ignores it entirely. This makes the scraper
unconfigurable in non-standard deployments.

**Fix**: Resolve the directory from `CODESANDBOX_WEB_CREDENTIALS_DIR`, falling
back to `/mnt/s3/codesandbox-web` (Docker), then
`{projectRoot}/credentials/codesandbox-web` (local dev).

### Issue 7: `_XVFB_REEXEC` deletion in env spread

**File**: `credits-scraper.js`, `runScraperWithAuth()`

The current code passes `env: { ...process.env, GITHUB_AUTH_FILE: authFile }`.
The scraping script checks `_XVFB_REEXEC` to prevent re-execution loops. If the
parent process was itself launched under xvfb-run, `_XVFB_REEXEC=1` is inherited
and the child script will not re-exec under xvfb-run (even though it needs to).
The plan-described fix is to unset it:
```javascript
env: { ...process.env, _XVFB_REEXEC: undefined }
```
This is correct and should be applied.

---

## Corrected Implementation

### `src/services/providers/codesandbox/credits-scraper.js` — full replacement

```javascript
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SCRAPER_SCRIPT = path.resolve(
  __dirname, '../../../../scripts/get-codesandbox-credits.js'
);
const DEFAULT_TIMEOUT_MS =
  parseInt(process.env.CODESANDBOX_SCRAPER_TIMEOUT_MS, 10) || 60000;

function resolveWebCredentialsDir() {
  if (process.env.CODESANDBOX_WEB_CREDENTIALS_DIR) {
    return path.resolve(process.env.CODESANDBOX_WEB_CREDENTIALS_DIR);
  }
  // Docker: ./credentials is mounted at /mnt/s3 (read-only)
  const docker = '/mnt/s3/codesandbox-web';
  if (fs.existsSync(docker)) return docker;
  // Local dev fallback
  return path.resolve(__dirname, '../../../../credentials/codesandbox-web');
}

// ---------------------------------------------------------------------------
// In-process TTL cache — keyed by teamId, null results never cached
// ---------------------------------------------------------------------------

const scrapeCache = new Map(); // teamId → { result, expiresAt }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedScrape(teamId) {
  const hit = scrapeCache.get(teamId);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    scrapeCache.delete(teamId);
    return null;
  }
  return hit.value;
}

function putCachedScrape(teamId, value) {
  // Only cache successful (non-null) results. null means "no matching credential
  // found", which is transient — a new codesandbox-web file could be added.
  if (value != null) {
    scrapeCache.set(teamId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}

function clearScrapeCache() {
  scrapeCache.clear();
}

// ---------------------------------------------------------------------------
// Candidate discovery — codesandbox-web/*.json files (CodeSandbox storageState)
// ---------------------------------------------------------------------------

/**
 * List all .json files in the web-credentials directory.
 * Returns absolute paths, sorted by filename (stable order across runs).
 * Prefers codesandbox-web session files over GitHub/Google sessions because:
 * - No OAuth redirect required (fastest mode).
 * - Files were created specifically for this purpose via codesandbox-auth.js.
 */
function listWebCredentialFiles() {
  const dir = resolveWebCredentialsDir();
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Single-candidate scrape (async spawn, not spawnSync)
// ---------------------------------------------------------------------------

/**
 * Run get-codesandbox-credits.js with one CodeSandbox web credential file.
 *
 * Uses async spawn (not spawnSync) to avoid blocking the event loop during
 * a 60-second browser scrape. Candidates are tried sequentially (not in
 * parallel) by the caller to avoid launching multiple Playwright+Chromium
 * instances simultaneously.
 *
 * Passes --codesandbox-credentials (direct session, no GitHub/Google OAuth).
 * Unsets _XVFB_REEXEC so the child can re-exec under xvfb-run if needed.
 *
 * @returns {Promise<object|null>} Parsed JSON output, or null on failure.
 */
function runScraperWithCredential(credFile, teamId, timeoutMs) {
  return new Promise((resolve) => {
    if (!fs.existsSync(credFile)) return resolve(null);

    const args = [
      SCRAPER_SCRIPT,
      '--codesandbox-credentials', credFile,
      '--json',
    ];
    if (teamId) args.push('--workspace', teamId);

    // Remove _XVFB_REEXEC from the inherited env so the child script can
    // re-exec under xvfb-run even if the parent was already under xvfb-run.
    const childEnv = { ...process.env };
    delete childEnv._XVFB_REEXEC;

    const child = spawn(process.execPath, args, {
      env: childEnv,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        console.warn(
          `[credits-scraper] Timeout (${timeoutMs}ms) for ${path.basename(credFile)}`
        );
        resolve(null);
      }
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', () => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0 && code !== null) {
        console.warn(
          `[credits-scraper] Script exited ${code} for ${path.basename(credFile)}`
        );
      }

      // The script emits log lines before the JSON block.
      // Find the last line that starts with '{' — that is the JSON output.
      const lines = stdout.split('\n');
      const jsonLine = [...lines].reverse().find((l) => l.trim().startsWith('{'));
      if (!jsonLine) return resolve(null);

      try {
        const parsed = JSON.parse(jsonLine.trim());
        resolve(typeof parsed === 'object' && parsed !== null ? parsed : null);
      } catch {
        console.warn(
          `[credits-scraper] JSON parse failed for ${path.basename(credFile)}`
        );
        resolve(null);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Team matching
// ---------------------------------------------------------------------------

/**
 * Return true when a scrape result belongs to the requested team.
 *
 * - The script extracts team from the page URL or localStorage and returns it
 *   as `result.team`. Exact match is authoritative.
 * - When team is absent from the result (rare edge case), accept the result
 *   as a last-resort if ok:true and credit fields are present.
 */
function resultMatchesTeam(parsed, teamId) {
  if (!parsed || !parsed.ok) return false;
  if (parsed.team && teamId) return parsed.team === teamId;
  // Team absent in result — accept if credit data is present
  return parsed.includedCredits != null || parsed.usedCredits != null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrape credit balance for a CodeSandbox workspace.
 *
 * Tries codesandbox-web/*.json session files sequentially.
 * Stops at the first file whose dashboard shows the target team ID.
 * Returns null when no match is found or scraping is disabled.
 * Never throws (errors are caught internally or result in null).
 *
 * @param {string} teamId  - Workspace ID from meta.auth.team (e.g. ws_...)
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]  - Per-candidate timeout (default 60s)
 * @returns {Promise<ScrapedCredits|null>}
 *
 * @typedef {object} ScrapedCredits
 * @property {number|null} included       - Included credits for the billing period
 * @property {number|null} used           - Credits consumed so far
 * @property {number|null} remaining      - max(0, included - used) or null
 * @property {string|null} billingPeriod  - e.g. "4 Aug – 4 Sep 2026"
 * @property {string|null} team           - Workspace ID confirmed by scraper
 * @property {string|null} url            - URL that was scraped
 * @property {string}      fetchedAt      - ISO timestamp
 */
async function scrapeCreditsForTeam(teamId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!teamId) return null;

  // In test mode skip real browser scraping — tests stub this module directly.
  if (process.env.NODE_ENV === 'test') return null;

  const cached = getCachedScrape(teamId);
  if (cached !== null) return cached;

  const candidates = listWebCredentialFiles();
  if (candidates.length === 0) {
    console.warn(
      '[credits-scraper] No web credential files found in',
      resolveWebCredentialsDir()
    );
    return null;
  }

  // Sequential: one Playwright/Chromium process at a time.
  // Stop at the first candidate that matches the target team.
  for (const credFile of candidates) {
    let parsed;
    try {
      parsed = await runScraperWithCredential(credFile, teamId, timeoutMs);
    } catch {
      parsed = null;
    }

    if (!parsed) continue;

    if (resultMatchesTeam(parsed, teamId)) {
      const result = {
        included:      parsed.includedCredits  ?? null,
        used:          parsed.usedCredits       ?? null,
        remaining:     parsed.remainingCredits  ?? null,
        billingPeriod: parsed.billingPeriod     ?? null,
        team:          parsed.team              ?? teamId,
        url:           parsed.url               ?? null,
        fetchedAt:     parsed.fetchedAt         ?? new Date().toISOString(),
      };
      putCachedScrape(teamId, result);
      return result;
    }

    console.log(
      `[credits-scraper] ${path.basename(credFile)} returned team=${parsed.team || 'unknown'}, want ${teamId} — skipping`
    );
  }

  console.warn(
    `[credits-scraper] No web credential matched team ${teamId} after ${candidates.length} candidates`
  );
  return null;
}

/**
 * Parse credits from dashboard body text.
 * Shared helper — mirrors the parsing logic in get-codesandbox-credits.js.
 * Kept here so unit tests can verify parsing without spawning a browser.
 */
function parseCreditsFromBody(bodyText) {
  let included = null, used = null, freeUsed = null, billingPeriod = null;
  const period = bodyText.match(
    /(\d{1,2}\s+[A-Za-z]+)\s*[–-]\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/
  );
  if (period) billingPeriod = period[0].trim();
  const inc = bodyText.match(/Included credits\s*[:\n]*\s*(\d+)/i);
  if (inc) included = parseInt(inc[1], 10);
  const usedM = bodyText.match(/Credits used\s*[:\n]*\s*(\d+)/i);
  if (usedM) used = parseInt(usedM[1], 10);
  const freeM = bodyText.match(/(\d+)\s*free credits used/i);
  if (freeM) freeUsed = parseInt(freeM[1], 10);
  if (included == null || used == null) {
    const slash = bodyText.match(/(\d+)\s*\/\s*(\d+)\s*credits/i);
    if (slash) {
      const first = parseInt(slash[1], 10), second = parseInt(slash[2], 10);
      if (/run out of credits/i.test(bodyText) && first === second) {
        used = first; included = second;
      } else {
        used = first; included = second;
      }
    }
  }
  if (/run out of credits/i.test(bodyText) && included != null && used == null) {
    used = included;
  }
  const remaining = included != null && used != null
    ? Math.max(0, included - used)
    : null;
  return { included, used, freeUsed, billingPeriod, remaining };
}

module.exports = {
  parseCreditsFromBody,
  scrapeCreditsForTeam,
  listWebCredentialFiles,
  clearScrapeCache,
  // Exported for test inspection only:
  getCachedScrape,
  putCachedScrape,
};
```

---

### `codesandbox-provider.js` — `getCredentialStatus` credits block

The provider implementation is mostly correct. The only change needed is the
limitation message — remove account-specific examples:

```javascript
// Current (problematic — leaks account names into API response):
'Dashboard credits (e.g. 400 included / 275 used for etecnologysys, 400/403 for vm-manager123) are rendered by...'

// Corrected (generic):
limitations.push(limitation(
  'quotas[2].usage',
  'The CodeSandbox API does not expose credit balance. Credits are available only via ' +
  'the dashboard at ' + (teamId
    ? `https://codesandbox.io/t/usage?workspace=${teamId}`
    : 'https://codesandbox.io/dashboard') + '. ' +
  (scraperEnabled
    ? 'Scraping was enabled but no matching web credential file was found for this workspace. ' +
      'Ensure a codesandbox-web session file exists in CODESANDBOX_WEB_CREDENTIALS_DIR.'
    : 'Set CODESANDBOX_CREDITS_SCRAPER_ENABLED=1 and provide web session files in ' +
      'CODESANDBOX_WEB_CREDENTIALS_DIR to retrieve live credit balance.')
));
```

The rest of the `getCredentialStatus` method is correct as-is:
- `getApiClient()` used correctly (not `getClient()`).
- `httpStatus === 401 || 403` handled without throwing.
- Non-2xx non-auth throws (re-throw) so dispatcher marks as UNKNOWN without caching.
- `rateLimitExhausted` and `creditExhausted` both drive `QUOTA_EXHAUSTED`.
- Lazy `require('./codesandbox/credits-scraper')` for test mockability.
- Both `CODESANDBOX_CREDITS_SCRAPER_ENABLED` and `CODESANDBOX_SCRAPER_ENABLED` accepted.

---

## Integration Design (Confirmed)

When `getCredentialStatus(loaded)` is called on `CodeSandboxProvider`:

1. `API.getMetaInfo()` — always. Returns `{ data: MetaInformation, response }`.
   - `response.status 401/403` → return `INVALID` immediately (no throw).
   - `data == null` (500/429) → throw (dispatcher wraps as UNKNOWN, not cached).
2. Extract `meta.auth.team` (workspace ID).
3. Build rate-limit quota entries from `meta.rate_limits`.
4. If `CODESANDBOX_CREDITS_SCRAPER_ENABLED=1` and team ID present:
   - Call `scrapeCreditsForTeam(teamId)`.
   - On success: populate credits quota entry with live data.
   - On null/failure: populate credits quota entry with all-null + limitation.
5. Determine status:
   - `conc.remaining === 0` or `hourly.remaining === 0` → `QUOTA_EXHAUSTED`
   - `creditRemaining === 0` (explicit zero from scraping) → `QUOTA_EXHAUSTED`
   - Otherwise → `AVAILABLE`
6. Return `{ status, validated: true, quotas, limitations, expiresAt: null, details }`.

`finalizeEntry` in `credential-status-service.js` then:
- Queries DB for `localActiveSessions` (non-terminal sessions for this fingerprint).
- Adds `LIMITED` candidate if `localActiveSessions > 0`.
- `resolveStatus([checkerStatus, 'LIMITED'])` — `QUOTA_EXHAUSTED` beats `LIMITED`.

---

## Data Flow Summary

```
GET /api/v1/sessions/codesandbox/credentials/status
  [?credentialRef=codesandbox/etecnologysys.json]
         │
         ▼
credential-status-service.js
  loadCodeSandboxCredentials('codesandbox/etecnologysys.json')
  → { token: 'csb_v1_...', credentialRef, credentialFingerprint }
         │
         ▼
CodeSandboxProvider.getCredentialStatus(loaded)
  │
  ├─► codesandboxClient.getApiClient(token).getMetaInfo()
  │     └─ meta.auth.team = 'ws_Eha5JM84UeHdXshrooLDTA'
  │        meta.rate_limits = { sandboxes_hourly: {...}, concurrent_vms: {...} }
  │
  ├─► [CODESANDBOX_CREDITS_SCRAPER_ENABLED=1]
  │     credits-scraper.scrapeCreditsForTeam('ws_Eha5JM84UeHdXshrooLDTA')
  │       │
  │       ├─ listWebCredentialFiles()   ← CODESANDBOX_WEB_CREDENTIALS_DIR
  │       │    → ['/mnt/s3/codesandbox-web/erikfva2.json',
  │       │        '/mnt/s3/codesandbox-web/etecnologysys.json', ...]  (sorted)
  │       │
  │       └─ for each candidate (sequential):
  │            spawn(node scripts/get-codesandbox-credits.js
  │              --codesandbox-credentials /mnt/s3/codesandbox-web/etecnologysys.json
  │              --workspace ws_Eha5JM84UeHdXshrooLDTA
  │              --json)
  │            ↳ xvfb-run -a (auto inside child, _XVFB_REEXEC cleared)
  │            ↳ Playwright + Cloudflare bypass
  │            ↳ codesandbox.io/dashboard → View usage
  │            ↳ { ok:true, team:'ws_Eha5JM84UeHdXshrooLDTA',
  │                 includedCredits:400, usedCredits:275, remainingCredits:125 }
  │            → match found → return result, cache it
  │
  └─► return {
        status: 'AVAILABLE',
        quotas: [
          { quotaUnit:'count', quotaPeriod:'hourly-window', usage:10, limit:50, remaining:40, resetAt:... },
          { quotaUnit:'count', quotaPeriod:null, usage:1, limit:10, remaining:9 },
          { quotaUnit:'credits', quotaPeriod:'billing-cycle', usage:275, limit:400, remaining:125,
            source:'https://codesandbox.io/t/usage?workspace=ws_Eha5JM84UeHdXshrooLDTA',
            billingPeriod:'4 Aug – 4 Sep 2026' }
        ],
        details: { referencePricing, authScopes, referenceLimits, creditSource }
      }
         │
         ▼
credential-status-service.finalizeEntry()
  countActiveSessions(db, 'codesandbox', fingerprint) → 0
  resolveStatus(['AVAILABLE']) → 'AVAILABLE'
         │
         ▼
HTTP 200 { provider:'codesandbox', credential:'etecnologysys.json',
           status:'AVAILABLE', quotas:[...], details:{...} }
```

---

## Dynamic Credential File Discovery

The set of `codesandbox-web/*.json` session files changes over time: new accounts
are added, sessions expire and get regenerated, and old accounts are removed.
The scraper is designed to handle this without restarts or config changes.

### How dynamism is handled

`listWebCredentialFiles()` calls `fs.readdirSync()` on every cache miss. It
never caches the directory listing. This means:

- **New file added** → picked up on the next scrape call for any team (the new
  file is included in the sorted candidate list immediately).
- **File deleted** → `fs.existsSync(credFile)` check inside
  `runScraperWithCredential` skips it silently; no error propagates.
- **File replaced / refreshed** (same name, new cookies) → the new content is
  used on the next call because the file is re-read by the CLI script each time.
- **All files deleted** → `listWebCredentialFiles()` returns `[]`; `scrapeCreditsForTeam`
  returns `null` immediately with a warn log.

### Cache interaction with dynamic files

The TTL cache is keyed by `teamId` (workspace ID), not by file path or filename.
A cached result means "we successfully scraped credits for this workspace within
the last 5 minutes". This has two implications:

- **New file added for a team that previously had no match** → because `null`
  results are never cached, the next call immediately tries the full candidate
  list including the new file. There is no delay.
- **Matching file deleted while a cached result is live** → the cache serves
  the last known result for up to 5 minutes. After expiry, the next call will
  try the remaining files. If no match is found, `null` is returned (not cached),
  so subsequent calls keep retrying.
- **File refreshed (session re-authenticated)** → the cache may serve the
  result from the old session for up to 5 minutes. This is acceptable — the
  credits data itself (balance, billing period) does not change because the
  session was refreshed; only the cookies changed.

### No config changes needed when files change

`CODESANDBOX_WEB_CREDENTIALS_DIR` points to the directory, not to individual
files. Adding or removing files from the directory is all that is needed.
The scraper re-reads the directory listing on every effective scrape invocation.

---

## Edge Cases and Failure Modes

| Scenario | Behavior |
|---|---|
| `CODESANDBOX_CREDITS_SCRAPER_ENABLED` not set or `0` | Credits entry: all-null; limitation explains how to enable. Scraper not called. |
| `CODESANDBOX_WEB_CREDENTIALS_DIR` does not exist | `listWebCredentialFiles()` returns `[]`; scraper returns `null`; credits stay `null`. |
| No web session file matches the target workspace | All candidates tried sequentially, none match; scraper returns `null`; credits stay `null` with specific limitation. |
| Web session expired (`ok:false`, lands on `/signin`) | `resultMatchesTeam` returns `false` (no credits); candidate skipped; continues to next. |
| Cloudflare blocks (`ok:false`) | Same — candidate skipped. |
| Script times out (60s per candidate) | Timer fires; `SIGTERM` sent; `resolve(null)` for that candidate; next tried. |
| `team` field absent from script result | Accepted as match if `ok:true` and credit fields present (`resultMatchesTeam` fallback path). |
| `remaining: 0` from scraping | `creditExhausted = true`; status → `QUOTA_EXHAUSTED` even if rate-limits are free. |
| Rate-limits exhausted + active local session | `QUOTA_EXHAUSTED` beats `LIMITED` via precedence. |
| Same team requested twice within 5 min TTL | Second call returns cached result; no browser launched. |
| List mode: 3 credentials, same team across calls | Cache prevents redundant launches after the first match; each subsequent call returns the cached result. |
| `NODE_ENV=test` | `scrapeCreditsForTeam` returns `null` immediately; tests use `stubModule` to inject mock scrapers. |
| **New file added to `codesandbox-web/`** | Picked up immediately on the next cache miss — `listWebCredentialFiles()` re-reads the directory every time. No restart needed. |
| **File deleted from `codesandbox-web/`** | `fs.existsSync` check skips the missing file silently. If it was the only match for a team, the cache serves the last result until TTL expires, then returns `null`. |
| **File refreshed (same name, new cookies)** | New cookies used on the next effective scrape (after TTL expires or on first call). Cache serves old credits data until TTL — acceptable since the balance itself doesn't change when cookies rotate. |
| **All files deleted from `codesandbox-web/`** | `listWebCredentialFiles()` returns `[]`; scraper returns `null` immediately with a warn log. No error thrown. |
| **New file added for a team that had no prior match** | Null results are never cached, so the next call immediately tries the new file. Zero delay. |

---

## Session File Lifecycle

### Creating a new web session

```bash
# Via CodeSandbox storageState refresh (fastest — if an existing session exists)
node scripts/codesandbox-auth.js \
  --codesandbox-credentials credentials/codesandbox-web/vm-manager123.json \
  --output credentials/codesandbox-web/vm-manager123.json

# Via Google session (recommended for first-time creation)
node scripts/codesandbox-auth.js \
  --google-credentials credentials/google/etecnologysys/google.json \
  --output credentials/codesandbox-web/etecnologysys.json

# Via GitHub session
node scripts/codesandbox-auth.js \
  --credentials credentials/github/vm-manager123/github.json \
  --output credentials/codesandbox-web/vm-manager123.json

# Inside Docker (mount is read-only; write to /tmp then copy out)
docker exec play-with-docker-app-1 bash -c \
  "timeout 180 node scripts/codesandbox-auth.js \
    --google-credentials /mnt/s3/google/etecnologysys/google.json \
    --output /tmp/etecnologysys.json"
docker cp play-with-docker-app-1:/tmp/etecnologysys.json \
  credentials/codesandbox-web/etecnologysys.json
```

### Batch: generate for all known web sessions

```bash
# On host (credentials/ is already a local directory)
for f in credentials/codesandbox-web/*.json; do
  name=$(basename "$f" .json)
  echo "Refreshing $name..."
  timeout 180 node scripts/codesandbox-auth.js \
    --codesandbox-credentials "$f" \
    --output "$f" || echo "FAILED $name — try --google-credentials or --credentials fallback"
done
```

### Storage in Docker / S3

In Docker, `./credentials` is mounted as `/mnt/s3` (read-only). Web session files:
- Host: `credentials/codesandbox-web/*.json`
- Container: `/mnt/s3/codesandbox-web/*.json`

`resolveWebCredentialsDir()` automatically uses `/mnt/s3/codesandbox-web` as the
first fallback when `CODESANDBOX_WEB_CREDENTIALS_DIR` is not set, so no env var
change is needed in the Docker deployment.

---

## Environment Variables

Add to `.env.example`:

```bash
# CodeSandbox credits scraping (browser-based, opt-in)
# Requires Playwright + Chromium and codesandbox-web session files in CODESANDBOX_WEB_CREDENTIALS_DIR
CODESANDBOX_CREDITS_SCRAPER_ENABLED=0
# Default: /mnt/s3/codesandbox-web (Docker) or credentials/codesandbox-web (local)
CODESANDBOX_WEB_CREDENTIALS_DIR=
# Per-candidate browser timeout in ms (default 60000)
CODESANDBOX_SCRAPER_TIMEOUT_MS=60000
```

Note: `CODESANDBOX_SCRAPER_ENABLED` (without `CREDITS_`) is accepted as an
alias in the provider but `CODESANDBOX_CREDITS_SCRAPER_ENABLED` is canonical.

---

## Test Checklist

### `parseCreditsFromBody` (pure — no browser)
- `"Included credits 400\nCredits used 275"` → `{ included:400, used:275, remaining:125 }`
- `"400 / 400 credits\nYou have run out of credits"` → `{ included:400, used:400, remaining:0 }`
- `"Credits used 403\nIncluded credits 400"` → `{ included:400, used:403, remaining:0 }` (remaining clamped to 0)
- `"4 August – 4 September 2026"` → `billingPeriod` extracted
- No credit patterns → all null

### `listWebCredentialFiles`
- Returns sorted `.json` paths; returns `[]` when dir absent.
- `CODESANDBOX_WEB_CREDENTIALS_DIR` env var overrides default.
- `/mnt/s3/codesandbox-web` used when env var absent and path exists.
- Re-reads directory on every call (no internal caching of the listing).
- New file added between two calls → second call includes it without any reset.
- Deleted file → absent from the next call's result without error.

### `runScraperWithCredential`
- Returns `null` when `credFile` does not exist.
- Returns `null` on script timeout (verify SIGTERM sent).
- Extracts last JSON line from stdout that starts with `{`.
- Returns `null` on JSON parse failure.
- Returns `null` when script exits non-zero (but still tries to parse stdout).
- `_XVFB_REEXEC` is absent from child env regardless of parent env.

### `resultMatchesTeam`
- `parsed.team === teamId` → `true`
- `parsed.team !== teamId` → `false`
- `parsed.team` absent, `ok:true`, credits present → `true` (fallback)
- `parsed.ok === false` → `false` always
- `parsed === null` → `false`

### `scrapeCreditsForTeam`
- `NODE_ENV=test` → returns `null` immediately, no spawn.
- No candidates → returns `null`, no cache entry.
- Cache hit within TTL → returns cached value, no spawn.
- TTL expired → re-scrapes.
- `null` result not cached; fresh call re-scrapes immediately.
- Sequential: second candidate only tried when first returns `null` or mismatch.
- First matching candidate wins; subsequent candidates not tried.
- Successful result cached; `putCachedScrape` called with non-null value.
- `clearScrapeCache` resets the map; next call re-scrapes.
- **Dynamic: new file added after a prior null result** → next call includes the
  new file (null was not cached; directory re-read fresh).
- **Dynamic: matching file deleted after a cached hit** → cache serves last result
  until TTL, then returns `null` (re-reads directory, file gone).
- **Dynamic: file refreshed (same name)** → after TTL expiry, new file content
  is used automatically (CLI script re-reads the file on each spawn).

### Provider integration (stub `credits-scraper` via `stubModule`)
- Scraper returns `{ included:400, used:275, remaining:125 }` → `quotas[2]` has
  `usage:275`, `limit:400`, `remaining:125`, `source` set, no `quotas[2].usage` limitation.
- Scraper returns `null` → `quotas[2]` all-null; limitation present; `status` driven by rate-limits only.
- Scraper returns `{ included:400, used:400, remaining:0 }` → `creditExhausted=true`; `status:'QUOTA_EXHAUSTED'` even if rate-limits have headroom.
- `CODESANDBOX_CREDITS_SCRAPER_ENABLED` unset → scraper not called; limitation mentions how to enable.
- Scraper throws → caught; credits `null`; `console.warn` called; status unaffected.
- `concurrent_vms.remaining === 0` alone → `QUOTA_EXHAUSTED` (rate-limit exhaustion, independent of credits).
- `remaining:0` (credits) + non-terminal local session → `QUOTA_EXHAUSTED` beats `LIMITED`.
- Limitation message does NOT contain account-specific names (`etecnologysys`, `vm-manager123`).
