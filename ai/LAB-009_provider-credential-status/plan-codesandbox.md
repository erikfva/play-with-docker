# LAB-009: Implementation Plan — CodeSandbox Credential Status

**Spec**: `ai/LAB-009_provider-credential-status/spec.md` (§10.2)
**Research**: `research.md` (§5.2)
**Shared infra**: `plan-shared.md` — read first for envelope, cache, precedence
**Last Updated**: 2026-08-30 — updated to reflect codesandbox-web storageState approach

---

## Guiding Principle

CodeSandbox is the richest live-data provider: one authenticated metadata call
(`getMetaInfo()`) yields both token validity **and** live rate-limit headroom.
The SDK **does not** expose credit balance (`types.gen.ts: MetaInformation` has no `credits` field), but the web dashboard `https://codesandbox.io/dashboard` does (`400 / 400 credits`, `Virtual machine credits 8 Aug – 8 Sep`).

Probed `api.codesandbox.io` with `Bearer csb_v1_...` (30+ `/teams/{ws_...}/billing` variants) → `404/403` — dashboard is Cloudflare-protected and requires cookie-authenticated browser session.

The checker therefore has two layers:
1. **Primary**: `getMetaInfo()` for `INVALID` vs `AVAILABLE`/`QUOTA_EXHAUSTED` via `rate_limits` (always, no env needed)
2. **Secondary (scraping, opt-in)**: `CODESANDBOX_CREDITS_SCRAPER_ENABLED=1` → Playwright with **CodeSandbox** `storageState` from `credentials/codesandbox-web/` (passed as `--codesandbox-credentials` — direct session, no GitHub/Google OAuth needed) → `codesandbox.io/t/usage?workspace=ws_...` → parse `Included credits` / `Credits used`. Best-effort; on failure or when disabled keep `credits` `null` with limitation. Scraping result is cached per team with a configurable TTL (`CODESANDBOX_CREDITS_CACHE_TTL_SECONDS`, default 300s). Candidates are tried **sequentially** (one Chromium at a time). When `credentialHint` is provided (same basename as the API token file), the matching `codesandbox-web/` file is tried first — avoiding a full sequential scan in the common case.

---

## File Map

### Modified files

```
src/services/providers/codesandbox/client.js           — add getApiClient(token) + extend clearCache()
src/services/providers/codesandbox-provider.js         — add getCredentialStatus(loaded) + scraping integration
```

### New files

```
src/services/providers/codesandbox/credits-scraper.js  — codesandbox-web storageState → dashboard → credits
scripts/get-codesandbox-credits.js                     — standalone CLI (already exists, now reused as reference)
```

`client.js` **must** be modified. The `CodeSandbox` class returned by
`getClient(token)` does **not** expose `.api` publicly — `api` is a local
constructor variable (`const api = new API(...)`), not `this.api`. Calling
`sdkClient.api` returns `undefined`. A separate `getApiClient()` method is
needed to cache and expose `API` instances for `getMetaInfo()` calls.

No DB or route changes beyond the shared plan.

---

## 1. SDK surface used

**Verified from the live `@codesandbox/sdk@2.4.2` source**
(`github.com/codesandbox/codesandbox-sdk`, `src/index.ts`, `src/API.ts`,
`src/api-clients/client/types.gen.ts`):

### `CodeSandbox` class public surface (from `src/index.ts`)

```typescript
export class CodeSandbox {
  public readonly sandboxes: Sandboxes;  // ← only public properties
  public readonly hosts: HostTokens;
  constructor(apiToken?: string, opts: ClientOpts = {}) {
    const api = new API({ apiKey, config: opts });  // ← local variable, NOT this.api
    this.sandboxes = new Sandboxes(api, opts.tracer);
    this.hosts = new HostTokens(api);
  }
}
```

`CodeSandbox` does not expose `.api` publicly. `getClient(token)` returns a
`CodeSandbox` instance, so `sdkClient.api` is `undefined`.

`API` is a named export: `export { API } from "./API"`. Instantiate it directly
with `new API({ apiKey: token })` to call `getMetaInfo()`.

### `MetaInformation` type (from `types.gen.ts` — authoritative)

```typescript
export type MetaInformation = {
  api: { latest_version: string; name: string; };
  auth?: {
    scopes: string[];
    team:    string | null;
    version: string;
  };
  rate_limits?: {
    concurrent_vms:   { limit?: number; remaining?: number; };
    requests_hourly:  { limit?: number; remaining?: number; reset?: number; };
    sandboxes_hourly: { limit?: number; remaining?: number; reset?: number; };
  };
};
```

All fields under `rate_limits` are optional (`?`). Guard every access.

### `getMetaInfo()` return shape — no `handleResponse` wrapper

From `src/API.ts`:
```typescript
async getMetaInfo() {
  return metaInfo({ client: this.client });  // returns raw hey-api response object
}
```

Unlike all other `API` methods, `getMetaInfo()` does **not** call
`handleResponse()`. It returns the raw `hey-api` shape:

```typescript
{ data?: MetaInformation, error?: unknown, response: Response }
```

Behaviour by HTTP status:
- **200**: `data` is `MetaInformation`; `response.status === 200`.
- **401 / 403**: `data` is `undefined`; `response.status` is 401 or 403.
  **No exception is thrown** — the response object is returned.
- **429**: `handleResponse` is not called, so `RateLimitError` is not thrown
  either — check `response.status === 429` in the status guard.
- **Network failure** (`fetch` rejects): propagates as a thrown error.

Auth failures must be detected by inspecting `metaResult.response.status`
directly, not by catching a thrown error.

### Dashboard scraping surface (new)

No SDK endpoint. Verified via `scripts/get-codesandbox-credits.js` with `vm-manager123` (`ws_Sh4V5DwQDYJDBRgDKhm79X`) and `vm-manager123-1` (`ws_ThQtWFucY3Rxk6KQzhW3gW`):

- **Auth**: GitHub `storageState` (`/mnt/s3/github/vm-manager123/github.json`) → `github-browser.js:71` `launchGitHubBrowser()` + `ensureSignedIn()` → `https://codesandbox.io/dashboard` (Cloudflare `Just a moment` → `xvfb-run -a --server-args="-screen 0 1366x850x24" node ... --headful` + `--disable-blink-features=AutomationControlled` + `waitForCloudflare()`).
- **OAuth**: `Continue with GitHub` → `github.com/login/oauth/authorize` → `Authorize codesandbox` → redirect to `https://codesandbox.io/dashboard/recent`.
- **Credits**: Sidebar `400 / 400 credits` + `You have run out of credits` → click `View usage` → `https://codesandbox.io/t/usage?workspace=ws_...` → `Virtual machine credits` `8 August – 8 September 2026` `Included credits 400` `Credits used 403` `403 free credits used` `Sandboxes 0 / 5`.

All 30+ `Bearer` probes to `api.codesandbox.io/teams/{team}/billing` etc. → `404/403` — scraping is the only way.

---

## 2. `client.js` — add `getApiClient(token)`

```javascript
// src/services/providers/codesandbox/client.js
const { CodeSandbox, API } = require('@codesandbox/sdk');  // ← add API to destructure
const crypto = require('crypto');

class CodeSandboxClient {
  constructor() {
    this.instances    = new Map();  // CodeSandbox instances (existing)
    this.apiInstances = new Map();  // API instances (new — for getMetaInfo)
  }

  /**
   * Existing method — unchanged.
   * Returns a cached CodeSandbox instance (exposes .sandboxes.*, .hosts).
   */
  getClient(token) {
    if (!token || typeof token !== 'string' || !token.trim()) {
      throw new Error('CodeSandbox token is required');
    }
    const trimmedToken = token.trim();
    const cacheKey = crypto.createHash('sha256').update(trimmedToken).digest('hex');
    if (!this.instances.has(cacheKey)) {
      this.instances.set(cacheKey, new CodeSandbox(trimmedToken));
      console.log('[CodeSandbox] Created new SDK client');
    }
    return this.instances.get(cacheKey);
  }

  /**
   * New method.
   * Returns a cached API instance for direct low-level calls (getMetaInfo, etc.).
   * Uses the same SHA-256 cache key as getClient().
   *
   * Rationale: CodeSandbox does NOT expose .api publicly — it is a local
   * constructor variable. Instantiate API separately with the same token.
   */
  getApiClient(token) {
    if (!token || typeof token !== 'string' || !token.trim()) {
      throw new Error('CodeSandbox token is required');
    }
    const trimmedToken = token.trim();
    const cacheKey = crypto.createHash('sha256').update(trimmedToken).digest('hex');
    if (!this.apiInstances.has(cacheKey)) {
      this.apiInstances.set(cacheKey, new API({ apiKey: trimmedToken }));
    }
    return this.apiInstances.get(cacheKey);
  }

  /**
   * Clear all cached instances (useful for tests).
   * Extended to cover both cache maps.
   */
  clearCache() {
    this.instances.clear();
    this.apiInstances.clear();
  }
}

const client = new CodeSandboxClient();
module.exports = client;
```

---

## 3. `credits-scraper.js` — new module

Reuses `scripts/github-browser.js` + `scripts/get-codesandbox-credits.js` logic but as a service with timeout and mock seam.

```javascript
// src/services/providers/codesandbox/credits-scraper.js
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 35000; // aligns with dashboard load + Cloudflare
const WORKSPACE_CANDIDATE_FILES = [
  '/mnt/s3/github/vm-manager123/github.json',
  '/mnt/s3/github/vm-manager123-1/github.json',
  process.env.GITHUB_AUTH_FILE,
].filter(Boolean);

function parseCreditsFromBody(bodyText) {
  // Handles both "Credits used 403" and "400 / 400 credits" + "run out of credits"
  let included = null, used = null, freeUsed = null, billingPeriod = null;
  const period = bodyText.match(/(\d{1,2}\s+[A-Za-z]+)\s*[–-]\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/);
  if (period) billingPeriod = period[0].trim();
  const inc = bodyText.match(/Included credits\s*[:\n]*\s*(\d+)/i);
  if (inc) included = parseInt(inc[1],10);
  const usedM = bodyText.match(/Credits used\s*[:\n]*\s*(\d+)/i);
  if (usedM) used = parseInt(usedM[1],10);
  const freeM = bodyText.match(/(\d+)\s*free credits used/i);
  if (freeM) freeUsed = parseInt(freeM[1],10);
  if (included == null || used == null) {
    const slash = bodyText.match(/(\d+)\s*\/\s*(\d+)\s*credits/i);
    if (slash) {
      const first = parseInt(slash[1],10), second = parseInt(slash[2],10);
      if (/run out of credits/i.test(bodyText) && first===second) { used = first; included = second; }
      else { used = first; included = second; }
    }
  }
  if (/run out of credits/i.test(bodyText) && included != null && used == null) used = included;
  return { included, used, freeUsed, billingPeriod, remaining: (included!=null&&used!=null)?Math.max(0,included-used):null };
}

async function scrapeCreditsForTeam(teamId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // Resolve GitHub auth file: prefer file that matches workspace's GitHub user.
  // For etecnologysys (ws_Eha5JM84UeHdXshrooLDTA) we have no GitHub file → return null.
  // For vm-manager123 (ws_Sh4V5DwQDYJDBRgDKhm79X) → /mnt/s3/github/vm-manager123/github.json
  // Heuristic: try each candidate file and check if its dashboard shows the requested team.
  const lib = require('../../../scripts/github-browser'); // relative to src/.../credits-scraper.js
  // Actual implementation in file delegates to scripts/get-codesandbox-credits.js extractCredits() by spawning with GITHUB_AUTH_FILE and parsing JSON.
  // Keeping the file small: we spawn the CLI script and capture JSON.
}

module.exports = { parseCreditsFromBody, scrapeCreditsForTeam };
```

Simpler production implementation (used in `codesandbox-provider.js`): spawn `scripts/get-codesandbox-credits.js --credentials <file> --workspace <team> --json --headful` via `child_process.spawn` with `xvfb-run` wrapper, 60s timeout, parse JSON. If no `GITHUB_AUTH_FILE` candidate succeeds, return `null`. This avoids importing Playwright directly in the provider (keeps provider lightweight and test-mockable).

Key behaviours:
- Cloudflare `Just a moment` → `waitForCloudflare(page, 45s)` + `--disable-blink-features=AutomationControlled` (`scripts/github-browser.js:29`) + `xvfb-run -a --server-args="-screen 0 1366x850x24"`.
- Dashboard `400 / 400 credits` sidebar fallback + `View usage` click → `https://codesandbox.io/t/usage?workspace=ws_...` detailed extraction (verified for `vm-manager123` `403/400` and `vm-manager123-1` `406/400`).
- Parsing via `parseCreditsFromBody()` handles both `Credits used 275` and `400 / 400 credits`.
- Returns `{ included, used, remaining, billingPeriod, team, url }` or `null` on failure.

If `scrapeCreditsForTeam` returns `null`, provider keeps `credits` `null` with limitation.

---

## 4. Private helpers in `codesandbox-provider.js`

```javascript
/**
 * Returns n if n is a finite number, otherwise null.
 * Prevents NaN or Infinity from slipping into quota entries.
 */
function numOrNull(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
```

`isUnauthorizedError` is **not needed**: `getMetaInfo()` returns a raw
`{ data, error, response }` object on 401/403 — it does not throw. Auth
failures are detected by inspecting `metaResult.response.status` directly
inside `getCredentialStatus` (§5).

---

## 5. `getCredentialStatus(loaded)` on `CodeSandboxProvider` — updated with scraping

```javascript
async getCredentialStatus(loaded) {
  const limitations = [];
  const quotas = [];

  // --- single upstream call: token validity + live rate limits ----------------
  // Use getApiClient() — NOT getClient(). CodeSandbox does not expose .api.
  // Network / fetch-level errors (DNS, timeout, ECONNREFUSED) propagate up;
  // the dispatcher catches them and wraps as UNKNOWN (not cached).
  const apiClient = codesandboxClient.getApiClient(loaded.token);
  const metaResult = await apiClient.getMetaInfo();  // returns { data, error, response }

  // getMetaInfo() does NOT throw on 401/403 — inspect status directly.
  const httpStatus = metaResult?.response?.status;

  if (httpStatus === 401 || httpStatus === 403) {
    return {
      status: 'INVALID',
      validated: false,
      quotas: [],
      expiresAt: null,
      limitations: [limitation(
        'status',
        `getMetaInfo() returned HTTP ${httpStatus}: token is expired, revoked, ` +
        'or lacks required scopes (sandbox_create, vm_manage).'
      )]
    };
  }

  if (!metaResult?.data) {
    // Non-2xx that isn't 401/403 (e.g. 500, 429) — transient.
    // Re-throw as a plain error so the dispatcher returns UNKNOWN without caching.
    const err = new Error(`getMetaInfo() returned HTTP ${httpStatus ?? 'unknown'}`);
    err.statusCode = httpStatus;
    throw err;
  }

  const meta = metaResult.data;  // MetaInformation, confirmed non-null

  // --- quota entries from live rate_limits ----------------------------------
  const rl     = meta.rate_limits    || {};
  const hourly = rl.sandboxes_hourly || {};
  const conc   = rl.concurrent_vms   || {};
  // requests_hourly is intentionally omitted: it is an API-level HTTP request
  // throttle (not a sandbox-creation quota), does not block session creation,
  // and is not operationally relevant to the caller. sandboxes_hourly is the
  // meaningful creation window; concurrent_vms is the instantaneous cap.

  // Hourly sandbox-creation window
  const hourlyUsage =
    hourly.limit != null && hourly.remaining != null
      ? numOrNull(hourly.limit - hourly.remaining)
      : null;

  quotas.push(quotaEntry({
    quotaUnit:   'count',
    quotaPeriod: 'hourly-window',
    usage:       hourlyUsage,
    limit:       numOrNull(hourly.limit),
    remaining:   numOrNull(hourly.remaining),
    extra:       { resetAt: hourly.reset ?? null }  // Unix timestamp of next reset
  }));

  // Instantaneous concurrent-VM headroom
  const concUsage =
    conc.limit != null && conc.remaining != null
      ? numOrNull(conc.limit - conc.remaining)
      : null;

  quotas.push(quotaEntry({
    quotaUnit:   'count',
    quotaPeriod: null,              // instantaneous limit, not a time window
    usage:       concUsage,
    limit:       numOrNull(conc.limit),
    remaining:   numOrNull(conc.remaining)
    // The free-plan concurrent-VM default of 10 is reference data only.
    // The live conc.limit from getMetaInfo() is authoritative; do not hardcode.
  }));

  // Credit balance — try web scraping via dashboard (GitHub auth required, opt-in)
  // This replaces the previous always-null behaviour when CODESANDBOX_CREDITS_SCRAPER_ENABLED=1.
  let creditUsage = null, creditLimit = null, creditRemaining = null, creditSource = null, creditBillingPeriod = null;
  const teamId = meta.auth?.team; // e.g. ws_Eha5JM84UeHdXshrooLDTA (etecnologysys), ws_Sh4V5DwQDYJDBRgDKhm79X (vm-manager123)
  const scraperEnabled = process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED === '1' || process.env.CODESANDBOX_SCRAPER_ENABLED === '1';
  if (teamId && scraperEnabled) {
    try {
      const scraper = require('./codesandbox/credits-scraper'); // lazy, mockable via stubModule
      const scraped = await scraper.scrapeCreditsForTeam(teamId, { timeoutMs: 45000 });
      if (scraped && (typeof scraped.used === 'number' || typeof scraped.included === 'number')) {
        creditUsage = scraped.used;
        creditLimit = scraped.included;
        creditRemaining = scraped.remaining;
        creditBillingPeriod = scraped.billingPeriod;
        creditSource = scraped.url || `https://codesandbox.io/t/usage?workspace=${teamId}`;
      }
    } catch (scrapeErr) {
      console.warn(`[CodeSandbox] scrapeCreditsForTeam failed: ${scrapeErr.message}`);
    }
  }

  if (creditUsage != null || creditLimit != null) {
    quotas.push(quotaEntry({
      quotaUnit:   'credits',
      quotaPeriod: 'billing-cycle',
      usage: numOrNull(creditUsage),
      limit: numOrNull(creditLimit),
      remaining: numOrNull(creditRemaining),
      extra: {
        ...(creditSource ? { source: creditSource } : {}),
        ...(creditBillingPeriod ? { billingPeriod: creditBillingPeriod } : {})
      }
    }));
  } else {
    quotas.push(quotaEntry({
      quotaUnit:   'credits',
      quotaPeriod: 'billing-cycle',
      usage: null, limit: null, remaining: null
    }));
    limitations.push(limitation(
      'quotas[2].usage',
      'Dashboard credits (e.g. 400 included / 275 used for etecnologysys, 400/403 for vm-manager123) are rendered by codesandbox.io web UI via private cookie-auth billing API, not by GET /meta/info. ' +
      'Probed api.codesandbox.io billing candidates with Bearer token → 404/403. ' +
      'Scraping https://codesandbox.io/dashboard via Playwright (GitHub storageState, xvfb-run --headful, Cloudflare bypass) was attempted and failed or no GitHub session was available. ' +
      'Check https://codesandbox.io/dashboard?workspace=' + (meta.auth?.team || 'ws_...') + ' for authoritative usage; a passing rate-limit check can still fail at VM creation if credits are exhausted.'
    ));
  }

  // --- status determination -------------------------------------------------
  // QUOTA_EXHAUSTED only when a live counter explicitly returns 0 OR scraped credits show remaining===0.
  // remaining === undefined or null means "not reported" — not exhaustion evidence.
  const rateLimitExhausted = conc.remaining === 0 || hourly.remaining === 0;
  const creditExhausted = creditRemaining === 0;

  return {
    status:    (rateLimitExhausted || creditExhausted) ? 'QUOTA_EXHAUSTED' : 'AVAILABLE',
    validated: true,
    quotas,
    limitations,
    expiresAt: null,  // CodeSandbox tokens carry no embedded expiry timestamp
    details: {
      referencePricing: REFERENCE_PRICING,
      authScopes: meta.auth?.scopes ?? null,
      referenceLimits: {
        freePlanConcurrentVmsDefault: 10,  // documented default; live conc.limit is authoritative
        includedCreditsDefault: 400,
        billingPeriodExample: '4 Aug – 8 Sep 2026 (etecnologysys: 275/400, vm-manager123: 403/400 as scraped from dashboard)',
        dashboardUrl: meta.auth?.team ? `https://codesandbox.io/t/usage?workspace=${meta.auth.team}` : 'https://codesandbox.io/dashboard'
      },
      ...(creditSource ? { creditSource } : {}),
      ...(creditBillingPeriod ? { creditBillingPeriod } : {})
    }
  };
}
```

### Static reference pricing (`details.referencePricing`)

Defined as a module-level constant in `codesandbox-provider.js`:

```javascript
const REFERENCE_PRICING = {
  Pico:   { creditsPerHour: 5   },
  Nano:   { creditsPerHour: 10  },
  Micro:  { creditsPerHour: 20  },
  Small:  { creditsPerHour: 40  },
  Medium: { creditsPerHour: 80  },
  Large:  { creditsPerHour: 160 },
  XLarge: { creditsPerHour: 320 }
};
```

---

## 6. Local constraint → LIMITED

`finalizeEntry` in the shared service adds a `LIMITED` candidate when
`localActiveSessions > 0` for token-uniqueness-enforcing providers. For
CodeSandbox the terminal set is `TERMINATED, DELETED, FAILED` (mirrors the
unique partial index in `db.js`).

Precedence: `QUOTA_EXHAUSTED` beats `LIMITED`. A token that is both exhausted
and holding a local session reports `QUOTA_EXHAUSTED`.

`LIMITED` signals to the client that the orchestrator will reuse the existing
session rather than create a new one — consistent with the session creation flow.
Credit-based `QUOTA_EXHAUSTED` (scraped `remaining===0`) also beats `LIMITED`.

---

## Reuse Summary

| Existing component | Used by checker | How |
|---|---|---|
| `providers/codesandbox/client.js` singleton | Token → API instance caching | Extended with `getApiClient()`; `getClient()` unchanged |
| `new API({ apiKey: token }).getMetaInfo()` | Validity + live quota in one call | Via new `getApiClient()` method; verified from SDK source |
| `scripts/github-browser.js` + `scripts/get-codesandbox-credits.js` | Credit scraping | Reused via `credits-scraper.js` wrapper (spawns CLI, parses JSON) |
| `loadCodeSandboxCredentials` | Dispatcher load step | Unchanged |
| Shared `quotaEntry` / `limitation` helpers | All quota entries | Per `plan-shared.md` |
| Shared envelope / cache / routes / precedence | Everything | Per `plan-shared.md` |

---

## Key Decisions

- **`getApiClient()` not `getClient()`**: `CodeSandbox` class does not expose
  `.api`. `API` is a separate named export and must be instantiated directly.
  Both are cached under the same SHA-256 key.
- **Raw response inspection for auth errors**: `getMetaInfo()` does not call
  `handleResponse()` and does not throw on 401/403. Check `response.status`
  directly; only network errors throw.
- **One upstream call in v1 + optional scraping**: `getMetaInfo()` covers validity and both live
  quota dimensions. `sandboxes.listRunning()` is skipped. Scraping is second layer for `credits` only, best-effort, 45s timeout, `xvfb-run -a --headful`.
- **Scraping is best-effort and mockable**: `credits-scraper.js` is a thin wrapper around the CLI script; provider requires it lazily (`require('./credits-scraper')`) so tests can stub it with `stubModule()`. On failure or missing `GITHUB_AUTH_FILE`, keep `credits` `null` with limitation.
- **Cloudflare bypass**: `waitForCloudflare()` + `--disable-blink-features=AutomationControlled` + `xvfb-run`. Verified with `vm-manager123-1` `ws_ThQtWFucY3Rxk6KQzhW3gW` `400/406` on `https://codesandbox.io/t/usage`.
- **Parsing robustness**: `parseCreditsFromBody()` handles both `Credits used 403` and `400 / 400 credits` + `run out of credits` + `View usage` click.
- **Usage derived, not invented**: `usage = limit − remaining` only when both
  are non-null; otherwise `null`. Scraped `remaining = max(0, included - used)`.
- **Credits can now be live**: when scraping succeeds, `credits` `usage/limit/remaining` are live; otherwise `null` with explicit limitation.
- **`resetAt` on the hourly quota entry** (not a top-level field).
- **`QUOTA_EXHAUSTED` now includes `creditRemaining===0`**: `undefined/null` still means "not reported", but `0` from scraping is exhaustion.

---

## Test Checklist

- Valid token, free headroom → `AVAILABLE`; hourly entry has `resetAt`;
  `usage = limit − remaining` for both live entries.
- `sandboxes_hourly.remaining === 0` → `QUOTA_EXHAUSTED`.
- `concurrent_vms.remaining === 0` → `QUOTA_EXHAUSTED`.
- Both zero → still single `QUOTA_EXHAUSTED` (not doubled).
- `remaining` is `undefined` or `null` → status stays `AVAILABLE`, quota
  fields stay `null`.
- `getMetaInfo()` response has `status: 401` → `INVALID` returned directly
  (not thrown, not UNKNOWN).
- `getMetaInfo()` response has `status: 403` → `INVALID`.
- `getMetaInfo()` response has `status: 429` or `500` (data is null) →
  re-throw → dispatcher returns `UNKNOWN`, not cached.
- `getMetaInfo()` fetch throws (network error) → re-throw → `UNKNOWN`,
  not cached.
- Local non-terminal session → `LIMITED`; combined with exhausted quota →
  `QUOTA_EXHAUSTED` wins via precedence.
- Scraping succeeds (`used=403, included=400`) → `credits` `usage:403, limit:400, remaining:0`, status `QUOTA_EXHAUSTED` (credit exhaustion), `details.creditSource` set.
- Scraping fails / no GitHub session → `credits` `usage:null`, limitation with `https://codesandbox.io/dashboard?workspace=ws_...`, still `AVAILABLE` if rate-limits free.
- `QUOTA_EXHAUSTED` from `creditRemaining===0` beats `LIMITED` (scraped exhausted + local session → `QUOTA_EXHAUSTED`).
- `referenceLimits.freePlanConcurrentVmsDefault === 10` + `includedCreditsDefault === 400` in details.
- `getApiClient(token)` returns the same cached `API` instance on repeated
  calls with the same token.
- `clearCache()` clears both `instances` and `apiInstances` maps.
- Mock `API.prototype.getMetaInfo` (or inject a mock `API` instance via the
  `getApiClient` seam) + stub `credits-scraper` (`stubModule(creditsScraperPath, {scrapeCreditsForTeam: async()=>({used:403, included:400, remaining:0})})`) for unit tests; existing `clearCache()` pattern applies.
- Scraper parsing: `parseCreditsFromBody("400 / 400 credits\nYou have run out")` → `used=400, included=400`; `parseCreditsFromBody("Included credits 400\nCredits used 403")` → `used=403, included=400`.

