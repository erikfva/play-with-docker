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
src/services/providers/codesandbox-provider.js — add getCredentialStatus(loaded)
```

No `client.js` changes: the singleton `codesandboxClient.getClient(token)`
already caches SDK instances per token (SHA-256 key) and is reused as-is.
No DB or route changes beyond the shared plan.

---

## 1. SDK surface used

**Verified from the live `@codesandbox/sdk@2.4.2` source**
(`github.com/codesandbox/codesandbox-sdk`, `src/API.ts` + `src/api-clients/client/types.gen.ts`):

```typescript
// From types.gen.ts — the authoritative MetaInformation shape:
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

All fields under `rate_limits` are optional (`?`). The code must guard each one.

**Accessor path** (verified from `src/API.ts`):

```javascript
// The CodeSandbox class exposes `this.api = new API(options)`.
// codesandboxClient.getClient(token) returns a CodeSandbox instance.
const sdkClient = codesandboxClient.getClient(token);   // CodeSandbox instance
const meta = await sdkClient.api.getMetaInfo();          // ✅ confirmed accessor
```

The `API` class has `getMetaInfo()` as a direct method (line confirmed in
`src/API.ts`: `async getMetaInfo() { return metaInfo({ client: this.client }); }`).
The endpoint is `GET /meta/info`, returns `MetaInformation` on 200.

`listRunningVms()` is deliberately **not called** in v1: `rate_limits.concurrent_vms`
already carries count-vs-limit headroom from the same `getMetaInfo()` call,
and `VmListRunningVmsResponse` returns `{ concurrent_vm_count, concurrent_vm_limit }`
which is redundant.

---

## 2. Private helpers

These helpers live in `codesandbox-provider.js` alongside the new method.

```javascript
/**
 * Returns n if n is a finite number, otherwise null.
 * Prevents NaN or Infinity from slipping into quota entries.
 */
function numOrNull(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Returns true when the SDK throws a 401 or 403 error, indicating the token
 * is expired, revoked, or lacks required scopes.
 *
 * The SDK wraps HTTP errors as AxiosError/GaxiosError-style objects. The
 * status code surfaces on error.response?.status, error.status, or
 * error.statusCode depending on the HTTP client used internally.
 */
function isUnauthorizedError(error) {
  const code = error?.response?.status ?? error?.status ?? error?.statusCode;
  return code === 401 || code === 403;
}
```

---

## 3. `getCredentialStatus(loaded)` on `CodeSandboxProvider`

```javascript
async getCredentialStatus(loaded) {
  const limitations = [];
  const quotas = [];

  // --- single upstream call: token validity + live rate limits -------------
  let meta;
  try {
    const sdkClient = codesandboxClient.getClient(loaded.token);
    meta = await sdkClient.api.getMetaInfo();
  } catch (error) {
    if (isUnauthorizedError(error)) {
      // 401/403 → token expired, revoked, or missing required scopes.
      // Return INVALID directly; do not re-throw (this is a known terminal state).
      return {
        status: 'INVALID',
        validated: false,
        quotas: [],
        expiresAt: null,
        limitations: [limitation(
          'status',
          'getMetaInfo() returned 401/403: token is expired, revoked, or lacks required scopes.'
        )]
      };
    }
    // Transient error (5xx, network, timeout) → re-throw so the dispatcher
    // wraps it as UNKNOWN and does not cache the result.
    throw error;
  }

  // --- quota entries from live rate_limits ---------------------------------
  const rl     = meta.rate_limits     || {};
  const hourly = rl.sandboxes_hourly  || {};
  const conc   = rl.concurrent_vms    || {};

  // Hourly sandbox-creation window
  const hourlyUsage =
    hourly.limit != null && hourly.remaining != null
      ? numOrNull(hourly.limit - hourly.remaining)
      : null;

  quotas.push(quotaEntry({
    quotaUnit:  'count',
    quotaPeriod: 'hourly-window',
    usage:     hourlyUsage,
    limit:     numOrNull(hourly.limit),
    remaining: numOrNull(hourly.remaining),
    extra:     { resetAt: hourly.reset ?? null }  // Unix timestamp of next hourly reset
  }));

  // Instantaneous concurrent-VM headroom
  const concUsage =
    conc.limit != null && conc.remaining != null
      ? numOrNull(conc.limit - conc.remaining)
      : null;

  quotas.push(quotaEntry({
    quotaUnit:  'count',
    quotaPeriod: null,             // instantaneous limit, not a time window
    usage:     concUsage,
    limit:     numOrNull(conc.limit),      // live value from API; authoritative
    remaining: numOrNull(conc.remaining)
    // Note: the free-plan concurrent-VM default of 10 is documented reference
    // data only. The live conc.limit from getMetaInfo() supersedes it.
    // Do NOT hardcode 10 as a fallback here.
  }));

  // Credit balance — SDK has no field for this; report honestly as null
  quotas.push(quotaEntry({
    quotaUnit:  'credits',
    quotaPeriod: 'billing-cycle',
    usage: null, limit: null, remaining: null
  }));
  limitations.push(limitation(
    'quotas[2].usage',
    'The CodeSandbox SDK exposes live rate-limit headroom (concurrent_vms, ' +
    'sandboxes_hourly) but no account credit-balance field. A token that ' +
    'passes all rate-limit checks can still fail at VM creation if paid credits are exhausted.'
  ));

  // --- status determination ------------------------------------------------
  // QUOTA_EXHAUSTED when any live hard-limit counter hits zero.
  // "remaining not returned" (undefined/null) is not exhaustion evidence —
  // only an explicit 0 counts.
  const rateLimitExhausted =
    conc.remaining === 0 || hourly.remaining === 0;

  return {
    status:    rateLimitExhausted ? 'QUOTA_EXHAUSTED' : 'AVAILABLE',
    validated: true,
    quotas,
    limitations,
    expiresAt: null,    // CodeSandbox tokens carry no embedded expiry timestamp
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

Defined once as a module-level constant in `codesandbox-provider.js`:

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

## 4. Local constraint → LIMITED

The shared service (`finalizeEntry`) adds a `LIMITED` candidate when
`localActiveSessions > 0` for a token-uniqueness-enforcing provider. For
CodeSandbox the terminal set is `TERMINATED, DELETED, FAILED` (mirrors the
unique partial index in `db.js`).

Precedence: `QUOTA_EXHAUSTED` beats `LIMITED`. So a token that is both
exhausted and holding a local session reports `QUOTA_EXHAUSTED`.

A `LIMITED` response signals to the client that the orchestrator will reuse
the existing session rather than create a new one — consistent with the
reuse behavior documented in the session creation flow.

---

## Reuse Summary

| Existing component | Used by checker | How |
|---|---|---|
| `providers/codesandbox/client.js` singleton | Token → SDK instance caching | Unchanged; call `codesandboxClient.getClient(token)` |
| `sdkClient.api.getMetaInfo()` | Validity + live quota in one call | Verified from `src/API.ts` in the SDK source |
| `loadCodeSandboxCredentials` | Dispatcher load step | Unchanged |
| Shared `quotaEntry` / `limitation` helpers | All quota entries | Per `plan-shared.md` |
| Shared envelope / cache / routes / precedence | Everything | Per `plan-shared.md` |

---

## Key Decisions

- **One upstream call in v1** (`getMetaInfo()`): covers validity and both live
  quota dimensions; `listRunningVms()` skipped as redundant (`VmListRunningVmsResponse`
  just duplicates what `concurrent_vms` already tells us).
- **Usage derived, not invented**: hourly/instantaneous `usage = limit − remaining`
  only when both fields are non-null; otherwise `null`.
- **Credits always null** with an explicit "can still fail at creation" limitation.
- **`resetAt` on the hourly quota entry** (not a top-level field).
- **No hardcoded fallback for concurrent limit**: `conc.limit` is the live
  authoritative value. The documented free-plan default of 10 is placed in
  `details.referenceLimits` as documentation only.
- **`QUOTA_EXHAUSTED` requires an explicit `=== 0`**: undefined/null remaining
  means "not reported", not "exhausted".

---

## Test Checklist

- Valid token, free headroom → `AVAILABLE`; hourly entry has `resetAt`;
  `usage = limit - remaining` for each live entry.
- `sandboxes_hourly.remaining === 0` → `QUOTA_EXHAUSTED`.
- `concurrent_vms.remaining === 0` → `QUOTA_EXHAUSTED`.
- Both zero → still single `QUOTA_EXHAUSTED` (not doubled).
- `remaining` returned as `undefined` or `null` (not reported) → status stays
  `AVAILABLE`, usage and remaining stay `null`.
- `getMetaInfo()` 401 → `INVALID` (not re-thrown, not UNKNOWN).
- `getMetaInfo()` 403 → `INVALID` (same path).
- `getMetaInfo()` network error / 5xx → re-thrown → dispatcher wraps as
  `UNKNOWN`, **not cached**.
- Local non-terminal session → `LIMITED`; combined with exhausted quota →
  `QUOTA_EXHAUSTED` wins via precedence.
- Credits entry: `usage: null`, `limit: null`, `remaining: null`; limitation
  text present.
- `referenceLimits.freePlanConcurrentVmsDefault === 10` in details.
- Mock the SDK client singleton via existing `clearCache()` test seam.
