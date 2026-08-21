# LAB-009: Implementation Plan — CodeSandbox Credential Status

**Spec**: `ai/LAB-009_provider-credential-status/spec.md` (§10.2)
**Research**: `research.md` (§5.2)
**Shared infra**: `plan-shared.md` — read first for envelope, cache, precedence
**Last Updated**: 2026-08-21

---

## Guiding Principle

CodeSandbox is the richest live-data provider: one authenticated metadata call
(`getMetaInfo()`) yields both token validity **and** live rate-limit headroom.
The checker converts that into quota entries; credit balance stays honestly
`null` because the SDK does not expose it.

## File Map

### Modified files

```
src/services/providers/codesandbox/client.js           — add getApiClient(token) + extend clearCache()
src/services/providers/codesandbox-provider.js         — add getCredentialStatus(loaded)
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

## 3. Private helpers in `codesandbox-provider.js`

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
inside `getCredentialStatus` (§4).

---

## 4. `getCredentialStatus(loaded)` on `CodeSandboxProvider`

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
  // remaining === undefined or null means "not reported" — not exhaustion evidence.
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

## 5. Local constraint → LIMITED

`finalizeEntry` in the shared service adds a `LIMITED` candidate when
`localActiveSessions > 0` for token-uniqueness-enforcing providers. For
CodeSandbox the terminal set is `TERMINATED, DELETED, FAILED` (mirrors the
unique partial index in `db.js`).

Precedence: `QUOTA_EXHAUSTED` beats `LIMITED`. A token that is both exhausted
and holding a local session reports `QUOTA_EXHAUSTED`.

`LIMITED` signals to the client that the orchestrator will reuse the existing
session rather than create a new one — consistent with the session creation flow.

---

## Reuse Summary

| Existing component | Used by checker | How |
|---|---|---|
| `providers/codesandbox/client.js` singleton | Token → API instance caching | Extended with `getApiClient()`; `getClient()` unchanged |
| `new API({ apiKey: token }).getMetaInfo()` | Validity + live quota in one call | Via new `getApiClient()` method; verified from SDK source |
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
- **One upstream call in v1**: `getMetaInfo()` covers validity and both live
  quota dimensions. `sandboxes.listRunning()` is skipped — it gives only
  `concurrentVmCount / concurrentVmLimit`, is noted as ~30s stale, and would
  require a second call.
- **Usage derived, not invented**: `usage = limit − remaining` only when both
  are non-null; otherwise `null`.
- **Credits always null** with an explicit limitation explaining the gap.
- **`resetAt` on the hourly quota entry** (not a top-level field).
- **`QUOTA_EXHAUSTED` requires explicit `=== 0`**: `undefined/null` means
  "not reported by the API", not "exhausted".

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
- Credits entry: `usage: null`, `limit: null`, `remaining: null`; limitation
  text present.
- `referenceLimits.freePlanConcurrentVmsDefault === 10` in details.
- `getApiClient(token)` returns the same cached `API` instance on repeated
  calls with the same token.
- `clearCache()` clears both `instances` and `apiInstances` maps.
- Mock `API.prototype.getMetaInfo` (or inject a mock `API` instance via the
  `getApiClient` seam) for unit tests; existing `clearCache()` pattern applies.
