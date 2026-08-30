# LAB-009: Implementation Tasks — CodeSandbox Credential Status

**Plan**: `plan-codesandbox.md` + `plan-codesandbox-scraping.md`
**Depends on**: shared infra from `plan-shared.md` must exist before task CS-4
**Files touched**:
- `src/services/providers/codesandbox/client.js` (modify)
- `src/services/providers/codesandbox-provider.js` (modify)
- `src/services/providers/codesandbox/credits-scraper.js` (replace)
- `.env.example` (modify)
- `tests/codesandbox-credential-status.test.js` (new)

---

## CS-1 — Extend `client.js`: add `getApiClient(token)` and extend `clearCache()`

**Status**: ✅ DONE

**File**: `src/services/providers/codesandbox/client.js`

**What was done**:
- `API` added to the destructured require: `const { CodeSandbox, API } = require('@codesandbox/sdk')`.
- `this.apiInstances = new Map()` added to the constructor.
- `getApiClient(token)` method added after `getClient()`, using SHA-256 cache key, throwing on blank/empty token.
- `clearCache()` extended to also call `this.apiInstances.clear()`.

No further changes needed. Existing `getClient()` behaviour and all callers in
`codesandbox-provider.js` are unchanged.

---

## CS-2 — Add `REFERENCE_PRICING` constant to `codesandbox-provider.js`

**Status**: ✅ DONE

**File**: `src/services/providers/codesandbox-provider.js`

**What was done**: `REFERENCE_PRICING` module-level constant is already present
with all 7 tiers (`Pico` → `XLarge`).

---

## CS-3 — Add private helpers to `codesandbox-provider.js`

**Status**: ✅ DONE

**File**: `src/services/providers/codesandbox-provider.js`

**What was done**: `numOrNull`, `limitation`, and `quotaEntry` are already
present as module-level private helpers.

---

## CS-4 — Implement `getCredentialStatus(loaded)` on `CodeSandboxProvider`

**Status**: ✅ DONE (with scraping integration beyond the original task spec)

**File**: `src/services/providers/codesandbox-provider.js`

**What was done**: `getCredentialStatus(loaded)` exists as a class method and
includes:
- `getApiClient(token).getMetaInfo()` call (not `getClient()`).
- HTTP 401/403 → `INVALID` return (no throw).
- Non-2xx non-auth → throw (dispatcher wraps as UNKNOWN, not cached).
- Hourly sandbox quota entry with `resetAt`.
- Concurrent VM quota entry.
- Credits quota entry populated from scraping when
  `CODESANDBOX_CREDITS_SCRAPER_ENABLED=1` — lazy `require('./codesandbox/credits-scraper')` for test mockability.
- `rateLimitExhausted` and `creditExhausted` both drive `QUOTA_EXHAUSTED`.
- Both `CODESANDBOX_CREDITS_SCRAPER_ENABLED` and `CODESANDBOX_SCRAPER_ENABLED` accepted.

**Outstanding issue**: the limitation message in the current implementation
leaks account-specific names (`etecnologysys`, `vm-manager123`) into the API
response. This is fixed in **CS-6** below alongside the full scraper replacement.

---

## CS-5 — Write unit tests

**Status**: ✅ DONE

**File**: `tests/codesandbox-credential-status.test.js`

**Test framework**: `node:test` with `assert` — matches all existing test files
in this project. Do not use Jest or Sinon.

**Mock pattern**: the project stubs dependencies via `require.cache` injection,
exactly as done in `codesandbox-provider-create.test.js`. Use the same
`stubModule` helper:

```javascript
const assert = require('assert');
const { test } = require('node:test');

function stubModule(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath, filename: modulePath, loaded: true, exports
  };
}
```

To mock `getMetaInfo()` for provider tests, stub the `clientPath` module and
include both `getClient` and `getApiClient` in the stub object:

```javascript
const clientPath = require.resolve('../src/services/providers/codesandbox/client');
const providerPath = require.resolve('../src/services/providers/codesandbox-provider');

// Before each test, clear provider from cache so it re-requires the stub
delete require.cache[providerPath];

stubModule(clientPath, {
  getClient: () => ({ sandboxes: { /* ... existing stubs ... */ } }),
  getApiClient: () => ({
    getMetaInfo: async () => ({
      data: { /* MetaInformation mock */ },
      error: undefined,
      response: { status: 200 }
    })
  }),
  clearCache: () => undefined
});

const CodeSandboxProvider = require('../src/services/providers/codesandbox-provider');
const provider = new CodeSandboxProvider();
```

Also stub `credits-scraper` to return `null` by default (prevents real browser
spawning in tests):

```javascript
const scraperPath = require.resolve(
  '../src/services/providers/codesandbox/credits-scraper'
);
stubModule(scraperPath, {
  scrapeCreditsForTeam: async () => null,
  listWebCredentialFiles: () => [],
  clearScrapeCache: () => undefined,
  getCachedScrape: () => null,
  putCachedScrape: () => undefined,
});
```

Vary the `getApiClient` and `scrapeCreditsForTeam` stub return values per test
case to simulate each scenario.

Cover every case from the plan's Test Checklist:

### `getApiClient()` behaviour (tests for `client.js`)

Test `client.js` directly — no stubbing needed for these. `new API({ apiKey })`
only constructs an HTTP client object; no network call is made at construction
time, so these tests are safe to run without a real CodeSandbox token:

```javascript
const clientPath = require.resolve('../src/services/providers/codesandbox/client');
// Remove any stub before testing real implementation
delete require.cache[clientPath];
const codesandboxClient = require('../src/services/providers/codesandbox/client');
```

- `getApiClient(token)` returns an object (an `API` instance).
- Calling `getApiClient(token)` twice with the same token returns the same
  cached instance (strict equality `===`).
- Calling `getApiClient(token)` with a different token returns a different instance.
- `clearCache()` clears both `instances` and `apiInstances`; subsequent call
  to `getApiClient` creates a fresh instance.
- `getApiClient('')` throws with message `'CodeSandbox token is required'`.
- `getApiClient('   ')` (whitespace-only) throws same message.

### `getCredentialStatus()` behaviour (tests for `codesandbox-provider.js`)

Use the `stubModule` + `delete require.cache[providerPath]` pattern above.
Also stub `dbPath` to provide a no-op `get` (needed for `countActiveSessions`
in `credential-status-service.js`, which is called by `finalizeEntry` when the
dispatcher processes the provider's result). Match the exact stub shape used in
`codesandbox-provider-create.test.js` — include `pool`:

```javascript
const dbPath = require.resolve('../src/db/db');

stubModule(dbPath, {
  get: async () => ({ count: 0 }),  // zero active sessions by default
  run: async () => undefined,
  all: async () => [],
  pool: { end: async () => undefined },  // required — db exports pool at module level
  ready: Promise.resolve()
});
```

**Happy path — scraper disabled (default)**:
- Valid token, `sandboxes_hourly: { limit: 50, remaining: 40, reset: 1234567890 }`,
  `concurrent_vms: { limit: 10, remaining: 8 }`, `CODESANDBOX_CREDITS_SCRAPER_ENABLED` unset:
  - `status: 'AVAILABLE'`, `validated: true`.
  - `quotas[0]`: `quotaUnit: 'count'`, `quotaPeriod: 'hourly-window'`,
    `usage: 10`, `limit: 50`, `remaining: 40`, `resetAt: 1234567890`.
  - `quotas[1]`: `quotaUnit: 'count'`, `quotaPeriod: null`,
    `usage: 2`, `limit: 10`, `remaining: 8`.
  - `quotas[2]`: `quotaUnit: 'credits'`, `quotaPeriod: 'billing-cycle'`,
    `usage: null`, `limit: null`, `remaining: null`.
  - One limitation present referencing `quotas[2].usage`; message does NOT contain account-specific names.
  - `details.referencePricing` has all 7 tiers (`Pico` through `XLarge`).
  - `details.authScopes` matches `meta.auth.scopes` from mock.
  - `details.referenceLimits.freePlanConcurrentVmsDefault === 10`.
  - `expiresAt: null`.

**Happy path — scraper enabled, credits returned**:
- `CODESANDBOX_CREDITS_SCRAPER_ENABLED=1`, `meta.auth.team = 'ws_abc'`,
  scraper stub returns `{ included: 400, used: 275, remaining: 125, billingPeriod: '4 Aug – 4 Sep 2026', url: 'https://codesandbox.io/t/usage?workspace=ws_abc' }`:
  - `quotas[2]`: `usage: 275`, `limit: 400`, `remaining: 125`,
    `billingPeriod: '4 Aug – 4 Sep 2026'`, `source` set to the workspace URL.
  - No `quotas[2].usage` limitation present.
  - `status: 'AVAILABLE'` (credits not exhausted).

**Happy path — scraper enabled, scraper returns null**:
- `CODESANDBOX_CREDITS_SCRAPER_ENABLED=1`, scraper stub returns `null`:
  - `quotas[2]` all-null.
  - Limitation present referencing `quotas[2].usage`, mentioning `CODESANDBOX_WEB_CREDENTIALS_DIR`.
  - Status driven by rate-limits only.

**`QUOTA_EXHAUSTED` via rate limits**:
- `sandboxes_hourly.remaining === 0` → `status: 'QUOTA_EXHAUSTED'`.
- `concurrent_vms.remaining === 0` → `status: 'QUOTA_EXHAUSTED'`.
- Both `=== 0` → `status: 'QUOTA_EXHAUSTED'` (not an error, not doubled).

**`QUOTA_EXHAUSTED` via credits**:
- Scraper enabled, returns `{ included: 400, used: 400, remaining: 0 }` →
  `creditExhausted = true`; `status: 'QUOTA_EXHAUSTED'` even if rate-limits have headroom.

**Null/missing fields — not exhaustion**:
- `remaining: undefined` on both counters → `status: 'AVAILABLE'`;
  `usage: null`, `remaining: null` on those quota entries.
- `rate_limits` field absent entirely from `meta` → same result as above.

**`INVALID`**:
- `getMetaInfo()` returns `{ response: { status: 401 }, data: undefined }` →
  `status: 'INVALID'`, `validated: false`, limitations has one entry with
  `field: 'status'` containing "401".
- `getMetaInfo()` returns `{ response: { status: 403 }, data: undefined }` →
  `status: 'INVALID'` (same path, message contains "403").

**Transient errors — must throw, not return INVALID**:
- `getMetaInfo()` returns `{ response: { status: 500 }, data: undefined }` →
  `getCredentialStatus` throws an `Error` with `statusCode: 500`.
- `getMetaInfo()` returns `{ response: { status: 429 }, data: undefined }` →
  throws with `statusCode: 429`.
- `getMetaInfo()` stub itself throws `new Error('fetch failed')` → error
  propagates out of `getCredentialStatus` unchanged.

**Scraper throws — must not propagate**:
- Scraper enabled, scraper stub throws `new Error('browser crash')` →
  `getCredentialStatus` catches it, logs a `console.warn`, returns normally
  with credits all-null and a limitation; `status` unaffected.

**Limitation message content**:
- With scraper disabled: limitation message does NOT contain `etecnologysys`
  or `vm-manager123` (no account-specific names).
- With scraper enabled + null result: limitation message mentions
  `CODESANDBOX_WEB_CREDENTIALS_DIR` and/or the workspace dashboard URL.

**`LIMITED` (tested at dispatcher level, not provider level)**:

`getCredentialStatus()` on the provider never touches the DB and never calls
`finalizeEntry`. It returns `{ status: 'AVAILABLE', ... }` when the token is
valid. The `LIMITED` promotion happens inside `credential-status-service.js`'s
`finalizeEntry`, which is called by the dispatcher after the provider returns.

These cases belong in the `credential-status-service` tests (covered by
`plan-shared.md`'s test checklist), not here.

### `numOrNull` helper

Test indirectly via quota entry assertions above, or export for direct testing:

- `numOrNull(5)` → `5`.
- `numOrNull(0)` → `0` (zero is a valid finite number).
- `numOrNull(NaN)` → `null`.
- `numOrNull(Infinity)` → `null`.
- `numOrNull(-Infinity)` → `null`.
- `numOrNull(null)` → `null`.
- `numOrNull(undefined)` → `null`.
- `numOrNull('5')` → `null`.

---

## CS-6 — Replace `credits-scraper.js` with corrected implementation

**Status**: ✅ DONE

**File**: `src/services/providers/codesandbox/credits-scraper.js`

**Why**: The current implementation has 7 documented issues — see
`plan-codesandbox-scraping.md` § "Issues Found in the Current Implementation"
for full details. Summary:

| # | Issue | Impact |
|---|---|---|
| 1 | Uses GitHub `storageState` files (`--credentials`) instead of CodeSandbox web sessions (`--codesandbox-credentials`) | Wrong auth flow; misses most accounts |
| 2 | Runs all Playwright candidates in parallel (`Promise.all`) | OOM / Cloudflare failures under load |
| 3 | Caches `null` results | Masks newly added web session files for up to the TTL |
| 4 | Fragile JSON extraction (`indexOf('{')` / `lastIndexOf('}')`) | Breaks when stdout has log lines with `{` characters |
| 5 | `candidateAuthFiles()` ignores `CODESANDBOX_WEB_CREDENTIALS_DIR` | Scraper unconfigurable in non-standard deployments |
| 6 | Inherits `_XVFB_REEXEC=1` from parent process | Child script cannot re-exec under `xvfb-run` when needed |
| 7 | TTL hardcoded to `5 * 60 * 1000` | Not configurable without a code change |

**Replacement**: use the full corrected implementation from
`plan-codesandbox-scraping.md` § "Corrected Implementation". Key changes:

- Replace `candidateAuthFiles()` + `runScraperWithAuth()` with
  `listWebCredentialFiles()` + `runScraperWithCredential()`.
- `listWebCredentialFiles()` reads `CODESANDBOX_WEB_CREDENTIALS_DIR`, falling
  back to `/mnt/s3/codesandbox-web` then `credentials/codesandbox-web`.
- `runScraperWithCredential()` passes `--codesandbox-credentials` (not `--credentials`).
- Sequential `for` loop replaces `Promise.all`.
- `putCachedScrape` only stores non-null results.
- Last-`{`-line JSON extraction replaces `indexOf`/`lastIndexOf`.
- `_XVFB_REEXEC` deleted from child env before spawn.
- `CACHE_TTL_MS` driven by `CODESANDBOX_CREDITS_CACHE_TTL_SECONDS` env var
  (integer seconds, `>= 0`), defaulting to `300` (5 minutes). Evaluated once
  at module load time. `0` disables caching.
- Updated exports: `parseCreditsFromBody`, `scrapeCreditsForTeam`,
  `listWebCredentialFiles`, `clearScrapeCache`, `getCachedScrape`,
  `putCachedScrape`. (`candidateAuthFiles` removed — no longer exported.)

**Also fix in `codesandbox-provider.js`**: the limitation message currently
leaks account-specific names. Replace with the generic version from
`plan-codesandbox-scraping.md` § "Corrected Implementation —
`codesandbox-provider.js`".

**Also add to `.env.example`**: the four scraper-related env vars from
`plan-codesandbox-scraping.md` § "Environment Variables":
```bash
CODESANDBOX_CREDITS_SCRAPER_ENABLED=0
CODESANDBOX_WEB_CREDENTIALS_DIR=
CODESANDBOX_SCRAPER_TIMEOUT_MS=60000
CODESANDBOX_CREDITS_CACHE_TTL_SECONDS=300
```

**Verification**: run CS-5 tests after this task. Tests must pass with the
corrected scraper stubbed; no real browser is launched.

---

## CS-7 — Write `credits-scraper.js` unit tests

**Status**: ✅ DONE

**File**: `tests/codesandbox-credits-scraper.test.js`

**Depends on**: CS-6 (corrected `credits-scraper.js` must be in place)

**Test framework**: `node:test` + `assert`. Same `stubModule` pattern.

Cover every case from `plan-codesandbox-scraping.md` § "Test Checklist":

### `parseCreditsFromBody` (pure — no browser)
- `"Included credits 400\nCredits used 275"` → `{ included:400, used:275, remaining:125 }`.
- `"400 / 400 credits\nYou have run out of credits"` → `{ included:400, used:400, remaining:0 }`.
- `"Credits used 403\nIncluded credits 400"` → `{ included:400, used:403, remaining:0 }` (remaining clamped to 0).
- `"4 August – 4 September 2026"` → `billingPeriod` extracted.
- No credit patterns → all null.

### `listWebCredentialFiles`
- Returns sorted `.json` paths; returns `[]` when dir absent.
- `CODESANDBOX_WEB_CREDENTIALS_DIR` env var overrides default.
- Re-reads directory on every call (no internal caching of the listing).
- New file added between two calls → second call includes it without any reset.
- Deleted file → absent from the next call's result without error.

### `runScraperWithCredential` (spawn-level, use a stub script)
- Returns `null` when `credFile` does not exist (`fs.existsSync` guard).
- Returns `null` on script timeout (verify SIGTERM sent to child).
- Extracts last JSON line from stdout that starts with `{`.
- Returns `null` on JSON parse failure (malformed JSON on last `{` line).
- Returns `null` when script exits non-zero (but still tries to parse stdout).
- `_XVFB_REEXEC` is absent from child env regardless of parent env value.

### `resultMatchesTeam`
- `parsed.team === teamId` → `true`.
- `parsed.team !== teamId` → `false`.
- `parsed.team` absent, `ok:true`, credits present → `true` (fallback).
- `parsed.ok === false` → `false` always.
- `parsed === null` → `false`.

### `scrapeCreditsForTeam` (stub `runScraperWithCredential` via `stubModule`)
- `NODE_ENV=test` → returns `null` immediately, no spawn.
- No candidates (empty dir) → returns `null`, no cache entry written.
- Cache hit within TTL → returns cached value, no spawn.
- TTL expired → re-scrapes (spawn called again).
- `null` result not cached; fresh call re-scrapes immediately.
- Sequential: second candidate only tried when first returns `null` or mismatch.
- First matching candidate wins; subsequent candidates not tried.
- Successful result cached; `putCachedScrape` called with non-null value.
- `clearScrapeCache` resets the map; next call re-scrapes.
- **Configurable TTL**: `CODESANDBOX_CREDITS_CACHE_TTL_SECONDS=10` → cache
  entry has `expiresAt = Date.now() + 10000`. `CODESANDBOX_CREDITS_CACHE_TTL_SECONDS=0`
  → `CACHE_TTL_MS === 0`; `getCachedScrape` returns entry as expired immediately.
- **Dynamic: new file added after a prior null result** → next call includes the
  new file (null was not cached; directory re-read fresh).
- **Dynamic: matching file deleted after a cached hit** → cache serves last
  result until TTL, then returns `null`.

---

## Task order and dependencies

```
CS-1  (client.js: getApiClient)                ✅ DONE
CS-2  (REFERENCE_PRICING constant)             ✅ DONE
CS-3  (numOrNull, limitation, quotaEntry)      ✅ DONE
CS-4  (getCredentialStatus method)             ✅ DONE

[shared infra from plan-shared.md must exist: credential-status-service.js,
 status-cache.js, base-provider.js hook, route in sessions.js]

CS-6  (credits-scraper.js replacement +        ❌ TODO  ← no deps beyond CS-4
        limitation message fix +
        .env.example additions)

CS-5  (provider unit tests)                    ❌ TODO  ← can run after CS-4;
                                                          stub scraper to null
CS-7  (credits-scraper unit tests)             ❌ TODO  ← needs CS-6
```

CS-5 and CS-6 can proceed in parallel — CS-5 stubs the scraper so it does not
depend on CS-6 being correct. CS-7 requires CS-6.
