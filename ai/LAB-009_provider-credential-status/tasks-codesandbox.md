# LAB-009: Implementation Tasks — CodeSandbox Credential Status

**Plan**: `plan-codesandbox.md`
**Depends on**: shared infra from `plan-shared.md` must exist before task CS-4
**Files touched**:
- `src/services/providers/codesandbox/client.js` (modify)
- `src/services/providers/codesandbox-provider.js` (modify)

---

## CS-1 — Extend `client.js`: add `getApiClient(token)` and extend `clearCache()`

**File**: `src/services/providers/codesandbox/client.js`

**Why**: `CodeSandbox` (returned by `getClient()`) does not expose `.api`
publicly — it is a local constructor variable. `API` must be instantiated
separately. `API` is a named export from `@codesandbox/sdk`.

**Changes**:

1. Add `API` to the destructured require at the top of the file:
   ```javascript
   const { CodeSandbox, API } = require('@codesandbox/sdk');
   ```

2. Add `this.apiInstances = new Map();` to the constructor alongside the
   existing `this.instances`:
   ```javascript
   constructor() {
     this.instances    = new Map();  // existing
     this.apiInstances = new Map();  // new — for getMetaInfo
   }
   ```

3. Add the `getApiClient(token)` method after `getClient()`:
   ```javascript
   /**
    * Returns a cached API instance for direct low-level calls (getMetaInfo, etc.).
    * Uses the same SHA-256 cache key as getClient().
    *
    * NOTE: CodeSandbox does NOT expose .api publicly — api is a local
    * constructor variable, not this.api. Use this method instead.
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
   ```

4. Extend `clearCache()` to also clear `apiInstances`:
   ```javascript
   clearCache() {
     this.instances.clear();
     this.apiInstances.clear();
   }
   ```

**Verification**: existing `getClient()` behaviour and all callers in
`codesandbox-provider.js` must remain unchanged.

---

## CS-2 — Add `REFERENCE_PRICING` constant to `codesandbox-provider.js`

**File**: `src/services/providers/codesandbox-provider.js`

Add the following module-level constant near the other constants at the top
of the file (after the existing `const` declarations):

```javascript
/**
 * CodeSandbox credit burn rates by VM tier.
 * Source: https://codesandbox.io/docs/learn/vm/vm-tiers
 * Used in details.referencePricing for credential status responses.
 */
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

## CS-3 — Add private helpers to `codesandbox-provider.js`

**File**: `src/services/providers/codesandbox-provider.js`

**Depends on**: nothing (pure helpers, no shared infra needed)

Add the following three functions alongside the other private helpers in the
file (e.g. after `parseMetadata` or `normalizeSessionRow`):

```javascript
/**
 * Returns n if n is a finite number, otherwise null.
 * Prevents NaN or Infinity from entering quota entry fields.
 */
function numOrNull(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Builds a quota limitation entry. Used in getCredentialStatus responses. */
function limitation(field, reason) { return { field, reason }; }

/** Builds a normalized quota entry. `extra` fields are spread into the object. */
function quotaEntry({ quotaUnit, quotaPeriod, usage = null, limit = null, remaining = null, extra = {} }) {
  return { quotaUnit, quotaPeriod, usage, limit, remaining, ...extra };
}
```

**Note**: `limitation` and `quotaEntry` are intentionally duplicated here from
`credential-status-service.js`. They are not exported from that module and are
small enough to keep local. The return shapes must remain identical to the
shared plan's definitions.

---

## CS-4 — Implement `getCredentialStatus(loaded)` on `CodeSandboxProvider`

**File**: `src/services/providers/codesandbox-provider.js`

**Depends on**: CS-1 (`getApiClient` must exist on the client singleton),
CS-2 (`REFERENCE_PRICING` constant), CS-3 (`numOrNull`, `limitation`,
`quotaEntry` helpers). Also requires the shared infra dispatcher
(`credential-status-service.js`) to exist so the method can be called end-to-end,
but the method body itself has no import dependency on shared infra —
`quotaEntry` and `limitation` are defined locally in CS-3.

Add the following method to the `CodeSandboxProvider` class. It must be a
class method alongside `createSession`, `refreshSession`, etc.:

```javascript
/**
 * Check the validity and live rate-limit headroom for a CodeSandbox token.
 *
 * Calls getMetaInfo() (GET /meta/info) — a single low-impact read-only call
 * that returns token validity + live rate-limit headroom in one response.
 *
 * Returns: { status, validated, quotas, limitations, expiresAt, details }
 * Throws on transient failures (network, 5xx, 429) so the dispatcher wraps
 * the result as UNKNOWN and does not cache it.
 *
 * @param {Object} loaded - Result of loadCodeSandboxCredentials()
 * @param {string} loaded.token - The raw CodeSandbox API token
 */
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
  // requests_hourly intentionally omitted: API-level HTTP throttle, not a
  // sandbox-creation quota; does not block session creation.

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
    extra:       { resetAt: hourly.reset ?? null }  // Unix timestamp of next hourly reset
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
  }));

  // Credit balance — SDK exposes no balance field; report honestly as null
  quotas.push(quotaEntry({
    quotaUnit:   'credits',
    quotaPeriod: 'billing-cycle',
    usage: null, limit: null, remaining: null
  }));
  limitations.push(limitation(
    'quotas[2].usage',
    'The CodeSandbox SDK exposes live rate-limit headroom (concurrent_vms, ' +
    'sandboxes_hourly) but no account credit-balance field. A token that ' +
    'passes all rate-limit checks can still fail at VM creation if paid credits are exhausted.'
  ));

  // --- status determination -------------------------------------------------
  // QUOTA_EXHAUSTED only when a live counter explicitly returns 0.
  // remaining === undefined or null means "not reported" — not exhaustion.
  const rateLimitExhausted = conc.remaining === 0 || hourly.remaining === 0;

  return {
    status:    rateLimitExhausted ? 'QUOTA_EXHAUSTED' : 'AVAILABLE',
    validated: true,
    quotas,
    limitations,
    expiresAt: null,  // CodeSandbox tokens carry no embedded expiry timestamp
    details: {
      referencePricing: REFERENCE_PRICING,
      authScopes: meta.auth?.scopes ?? null,
      referenceLimits: {
        freePlanConcurrentVmsDefault: 10  // documented default; live conc.limit is authoritative
      }
    }
  };
}
```

**Integration note**: `quotaEntry` and `limitation` are **not exported** from
`credential-status-service.js` — they are internal helpers there. The provider
uses its own local copies defined in CS-3.

---

## CS-5 — Write unit tests

**File**: `tests/codesandbox-credential-status.test.js` (new file — follows the
naming convention of `tests/codesandbox-provider-create.test.js`)

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

Vary the `getApiClient` stub return value per test case to simulate each
scenario (401, 403, 500, network throw, exhausted counters, etc.).

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

**Happy path**:
- Valid token, `sandboxes_hourly: { limit: 50, remaining: 40, reset: 1234567890 }`,
  `concurrent_vms: { limit: 10, remaining: 8 }`:
  - `status: 'AVAILABLE'`, `validated: true`.
  - `quotas[0]`: `quotaUnit: 'count'`, `quotaPeriod: 'hourly-window'`,
    `usage: 10`, `limit: 50`, `remaining: 40`, `resetAt: 1234567890`.
  - `quotas[1]`: `quotaUnit: 'count'`, `quotaPeriod: null`,
    `usage: 2`, `limit: 10`, `remaining: 8`.
  - `quotas[2]`: `quotaUnit: 'credits'`, `quotaPeriod: 'billing-cycle'`,
    `usage: null`, `limit: null`, `remaining: null`.
  - One limitation present referencing `quotas[2].usage`.
  - `details.referencePricing` has all 7 tiers (`Pico` through `XLarge`).
  - `details.authScopes` matches `meta.auth.scopes` from mock.
  - `details.referenceLimits.freePlanConcurrentVmsDefault === 10`.
  - `expiresAt: null`.

**`QUOTA_EXHAUSTED`**:
- `sandboxes_hourly.remaining === 0` → `status: 'QUOTA_EXHAUSTED'`.
- `concurrent_vms.remaining === 0` → `status: 'QUOTA_EXHAUSTED'`.
- Both `=== 0` → `status: 'QUOTA_EXHAUSTED'` (not an error, not doubled).

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

**`LIMITED` (tested at dispatcher level, not provider level)**:

`getCredentialStatus()` on the provider never touches the DB and never calls
`finalizeEntry`. It returns `{ status: 'AVAILABLE', ... }` when the token is
valid. The `LIMITED` promotion happens inside `credential-status-service.js`'s
`finalizeEntry`, which is called by the dispatcher after the provider returns.

These cases belong in the `credential-status-service` tests (covered by
`plan-shared.md`'s test checklist), not here. Do not stub `db.get` in
provider-level tests expecting `LIMITED` — the provider method will never
read it.

### `numOrNull` helper

Export or extract `numOrNull` for direct unit testing, or test it indirectly
via quota entry assertions above. If testing directly:

- `numOrNull(5)` → `5`.
- `numOrNull(0)` → `0` (zero is a valid finite number).
- `numOrNull(NaN)` → `null`.
- `numOrNull(Infinity)` → `null`.
- `numOrNull(-Infinity)` → `null`.
- `numOrNull(null)` → `null`.
- `numOrNull(undefined)` → `null`.
- `numOrNull('5')` → `null`.

---

## Task order and dependencies

```
CS-1  (client.js: getApiClient)
CS-2  (REFERENCE_PRICING constant)              ← no deps, can do alongside CS-1
CS-3  (numOrNull, limitation, quotaEntry helpers) ← no deps, can do alongside CS-1

[shared infra from plan-shared.md must exist: credential-status-service.js,
 status-cache.js, base-provider.js hook, route in sessions.js]

CS-4  (getCredentialStatus method)              ← needs CS-1, CS-2, CS-3, shared infra
CS-5  (unit tests)                              ← needs CS-1 through CS-4
```

CS-1, CS-2, and CS-3 are independent of each other and of shared infra —
they can all be done in parallel or in any order. CS-4 cannot be wired up
until the shared `quotaEntry` and `limitation` helpers exist. CS-5 can be
written in parallel with CS-4 if mocks are set up first.
