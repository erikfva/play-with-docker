# LAB-009: Implementation Plan — Shared Credential Status Infrastructure

**Spec**: `ai/LAB-009_provider-credential-status/spec.md`
**Research**: `ai/LAB-009_provider-credential-status/research.md`
**Provider plans**: `plan-gcs.md`, `plan-codesandbox.md`, `plan-codespaces.md`
**Last Updated**: 2026-08-21

---

## Guiding Principle: Reuse First

Every provider already ships a credential loader that resolves a ref into
`{ token/credentialsPath, credentialRef, credentialFingerprint }`. The status
layer reuses those loaders as-is — it never re-implements credential resolution.

Other reuse anchors:

| Anchor | Reuse |
|---|---|
| `codespaces/read-cache.js` | Pattern for the new TTL cache (in-process Map, fingerprint keys, errors never cached) |
| `credentials-lister.js` | Source of discoverable credentials per provider prefix (`gcloud/`, `codesandbox/`, `codespaces/`) |
| `db.js` (`run`/`all`/`get`) | Local active-session counts by fingerprint |
| Route pattern of `/google-credentials` etc. + `mapErrorToHttp` | New status routes follow the same shape |

---

## File Map

### New files

```
src/services/credential-status-service.js   — dispatcher: resolve → checker → merge local state → cache
src/services/status-cache.js                — generic in-process TTL cache
```

### Modified files

```
src/services/providers/base-provider.js     — optional getCredentialStatus hook (default throws)
src/routes/sessions.js                      — one GET route (list + single via query param)
```

Per-provider checkers are specified in their own plan files:

```
GCS          → gcs-service.js addition (no separate module; provider stays flat like existing code)
CodeSandbox  → method on CodeSandboxProvider
Codespaces   → method on CodespacesProvider + one new function in providers/codespaces/client.js
```

---

## 1. `src/services/status-cache.js`

Modeled on `providers/codespaces/read-cache.js`. Differences: generic key,
configurable TTL, no write-invalidation hooks needed.

```javascript
function parsePositiveInteger(val, defaultVal) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultVal;
}

const DEFAULT_TTL_MS = parsePositiveInteger(
  process.env.CREDENTIAL_STATUS_CACHE_TTL_MS,
  5 * 60 * 1000  // spec FR-14: ~5 min default
);

const cache = new Map(); // key -> { value, expiresAt }

function cacheKey(provider, credentialFingerprint) {
  return `${provider}:${credentialFingerprint}`;
}

function getCachedStatus(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);  // lazy expiry
    return null;
  }
  return hit.value;
}

function putCachedStatus(key, value, ttlMs = DEFAULT_TTL_MS) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function clearCache() { cache.clear(); }  // for tests

module.exports = { cacheKey, getCachedStatus, putCachedStatus, clearCache };
```

**Caching rule**: only cache entries whose `status !== 'UNKNOWN'`. This covers
both paths that produce `UNKNOWN`:
- A checker that **throws** (caught by the dispatcher → `buildUnknownEntry`)
- A checker that **returns `{ status: 'UNKNOWN' }`** directly (e.g. caught
  internally and surfaced as UNKNOWN rather than re-thrown)

All other statuses — including `INVALID`, `EXPIRED`, `QUOTA_EXHAUSTED`,
`UNAVAILABLE`, `LIMITED`, `AVAILABLE` — are cached for the full TTL to protect
upstream rate limits from hammering on every request.

---

## 2. Response envelope (shared builder)

One credential entry, exactly per spec §9:

```javascript
function buildEntry({ provider, credentialRef, displayName, fingerprint }) {
  return {
    provider,
    credential: displayName || credentialRef,  // spec §9: `credential` = file name or alias
    credentialFingerprint: fingerprint || null,
    status: 'UNKNOWN',
    checkedAt: new Date().toISOString(),
    expiresAt: null,
    quotas: [],
    details: { validated: false, limitations: [] }
  };
}

/**
 * Build an UNKNOWN entry from a raw loaded credential + optional error context.
 * Used when a checker throws or the loader fails.
 * Never caches the result.
 */
function buildUnknownEntry(raw, error) {
  const entry = buildEntry({
    provider:      raw.provider      || null,
    credentialRef: raw.credentialRef || null,
    displayName:   raw.displayName   || null,
    fingerprint:   raw.credentialFingerprint || null
  });
  if (error) {
    entry.details.errorCode    = error.code    || null;
    entry.details.errorMessage = error.message
      ? redactTokensFromMessage(error.message)
      : null;
  }
  return entry;
}

// Shared helpers used by all provider checkers
function limitation(field, reason) { return { field, reason }; }

function quotaEntry({ quotaUnit, quotaPeriod, usage = null, limit = null, remaining = null, extra = {} }) {
  return { quotaUnit, quotaPeriod, usage, limit, remaining, ...extra };
}

/**
 * Strip anything that looks like a token or key from error messages before
 * including them in responses. Conservative: replaces long alphanumeric runs.
 */
function redactTokensFromMessage(msg) {
  return msg.replace(/\b[A-Za-z0-9_\-]{20,}\b/g, '[REDACTED]');
}
```

### Local session count

```javascript
/**
 * Count non-terminal sessions for this provider + credential fingerprint.
 * GCS does not enforce token uniqueness but still reports the count
 * informationally; it never produces a LIMITED candidate.
 */
async function countActiveSessions(db, provider, fingerprint) {
  if (!fingerprint) return 0;
  // Terminal sets mirror each provider's unique partial index:
  //   codesandbox: TERMINATED, DELETED, FAILED
  //   codespaces:  TERMINATED, FAILED  (STOPPED still blocks creation)
  //   gcs:         TERMINATED, DELETED, FAILED  (no uniqueness index, informational only)
  const terminalStatuses = ['TERMINATED', 'DELETED', 'FAILED'];
  const placeholders = terminalStatuses.map((_, i) => `$${i + 3}`).join(', ');
  // NOTE: the column must stay UNQUOTED. It was created via unquoted DDL
  // ("ADD COLUMN credentialFingerprint TEXT"), so Postgres stored it lowercase
  // ('credentialfingerprint'). Quoting it as "credentialFingerprint" would
  // raise: column "credentialFingerprint" does not exist.
  const sql = `
    SELECT COUNT(*)::int AS count FROM sessions
    WHERE provider = $1
      AND credentialFingerprint = $2
      AND COALESCE(status, '') NOT IN (${placeholders})
  `;
  const row = await db.get(sql, [provider, fingerprint, ...terminalStatuses]);
  return row?.count ?? 0;
}
```

Result lands in `details.localActiveSessions`, never inside `quotas[]`.

Providers that enforce token uniqueness (`codesandbox`, `codespaces`) contribute
a `LIMITED` candidate when `localActiveSessions > 0`. GCS does not enforce
uniqueness, so its session count is reported but never downgrades the status.

### Status precedence resolver

```javascript
const PRECEDENCE = [
  'INVALID', 'EXPIRED', 'QUOTA_EXHAUSTED', 'UNAVAILABLE', 'LIMITED', 'AVAILABLE'
];

function resolveStatus(candidates) {
  return PRECEDENCE.find((s) => candidates.includes(s)) || 'UNKNOWN';
}
```

Checkers return `{ status, quotas, limitations, validated, expiresAt, details? }`.
The dispatcher calls `finalizeEntry` to apply precedence against the
local-constraint candidate and assemble the final envelope.

---

## 3. `src/services/credential-status-service.js`

```javascript
const { getProvider } = require('./provider-factory');
const { ProviderError } = require('./errors/provider-errors');
const db = require('../db/db');
const { listAvailableCredentials } = require('./credentials-lister');
const { cacheKey, getCachedStatus, putCachedStatus } = require('./status-cache');
const { initGoogleCredentialsFromS3IfNeeded } = require('./google-credentials-loader');
const { loadCodeSandboxCredentials } = require('./providers/codesandbox/credentials-loader');
const { loadCodespacesCredentials } = require('./providers/codespaces/credentials-loader');

// Matches the actual S3/filesystem prefix used by each provider's credential
// folder. Must match what credentials-lister.js already uses (verified from
// existing route handlers: gcs → 'gcloud', codesandbox → 'codesandbox',
// codespaces → 'codespaces').
const PROVIDER_PREFIXES = {
  gcs:          'gcloud',       // ← 'gcloud', not 'google'
  codesandbox:  'codesandbox',
  codespaces:   'codespaces'
};

// Providers that enforce one-session-per-token (drives LIMITED candidate).
const ENFORCES_TOKEN_UNIQUENESS = new Set(['codesandbox', 'codespaces']);

// Per-provider loaders, adapted from the existing session-creation path
// (same functions, so behavior and error codes stay identical).
//   gcs         → { credentialsPath, credentialRef }
//                 (google-credentials-loader.js — returns the resolved path)
//   codesandbox → { token, credentialRef, credentialFingerprint }  (sha256-prefixed)
//   codespaces  → { token, credentialRef, credentialFingerprint }  (verified shape)
const LOADERS = {
  gcs: async (ref) => ({
    credentialsPath: await initGoogleCredentialsFromS3IfNeeded(ref),
    credentialRef: ref
  }),
  codesandbox: (ref) => loadCodeSandboxCredentials(ref),
  codespaces:  (ref) => loadCodespacesCredentials(ref)
};

async function loadForStatus(providerName, credentialRef) {
  if (!credentialRef) {
    throw new ProviderError(
      'credentialRef query parameter is required',
      { code: 'CREDENTIAL_REF_REQUIRED', statusCode: 400 }
    );
  }
  const loader = LOADERS[providerName];
  if (!loader) {
    throw new ProviderError(
      `Provider '${providerName}' does not support credential status checks`,
      { code: 'CREDENTIAL_STATUS_UNSUPPORTED', statusCode: 404 }
    );
  }
  return loader(credentialRef);
}

/**
 * Check the status of one credential ref for a given provider.
 * Returns a normalized entry (never throws; errors become UNKNOWN entries).
 */
async function getCredentialStatus(providerName, { credentialRef } = {}) {
  // Reject 'pwd' and unknown providers before touching the factory.
  // provider-factory.getProvider('pwd') succeeds (pwd exists), so we block it here.
  const SUPPORTED_FOR_STATUS = new Set(['gcs', 'codesandbox', 'codespaces']);
  if (!SUPPORTED_FOR_STATUS.has(providerName)) {
    throw new ProviderError(
      `Provider '${providerName}' does not support credential status checks`,
      { code: 'CREDENTIAL_STATUS_UNSUPPORTED', statusCode: 404 }
    );
  }

  const provider = getProvider(providerName);  // getProvider, not resolveProvider
  if (typeof provider.getCredentialStatus !== 'function') {
    throw new ProviderError(
      `Provider ${providerName} does not support credential status`,
      { code: 'CREDENTIAL_STATUS_UNSUPPORTED', statusCode: 400 }
    );
  }

  let raw;
  try {
    raw = await loadForStatus(providerName, credentialRef);
  } catch (loadError) {
    // Unresolvable ref → UNKNOWN entry, HTTP 200 (NFR: resilience)
    return buildUnknownEntry(
      { provider: providerName, credentialRef, credentialFingerprint: null },
      loadError
    );
  }

  // Cache only when a fingerprint exists — otherwise the key would collide
  // across unrelated credentials (`${provider}:undefined`).
  const key = raw.credentialFingerprint
    ? cacheKey(providerName, raw.credentialFingerprint)
    : null;
  const cached = key ? getCachedStatus(key) : null;
  if (cached) return cached;

  let result;
  try {
    result = await provider.getCredentialStatus(raw);
  } catch (error) {
    // Transient/unexpected failure → UNKNOWN, never cached
    return buildUnknownEntry(raw, error);
  }

  const entry = await finalizeEntry(providerName, raw, result);  // ← must await: does async DB call

  // Cache everything except UNKNOWN (covers both checker-returned UNKNOWN
  // and any status that didn't match a known value). Skip entirely when no
  // fingerprint (key === null).
  if (key && entry.status !== 'UNKNOWN') {
    putCachedStatus(key, entry);
  }
  return entry;
}

/**
 * List credential status for all discovered credentials for a provider.
 * One failing credential does not prevent others from being reported.
 */
async function listCredentialStatuses(providerName) {
  const prefix = PROVIDER_PREFIXES[providerName];
  if (!prefix) {
    throw new ProviderError(
      `Provider '${providerName}' does not support credential status checks`,
      { code: 'CREDENTIAL_STATUS_UNSUPPORTED', statusCode: 404 }
    );
  }
  const { credentials, mode } = await listAvailableCredentials(prefix);
  const settled = await Promise.allSettled(
    credentials.map((c) => getCredentialStatus(providerName, { credentialRef: c.key }))
  );
  return {
    provider: providerName,
    mode,
    credentials: settled.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : buildUnknownEntry(
            { provider: providerName, credentialRef: credentials[i].key },
            r.reason
          )
    )
  };
}

/**
 * Merge checker result with local DB state and assemble the final entry.
 */
async function finalizeEntry(providerName, raw, checkerResult) {
  const localCount = await countActiveSessions(db, providerName, raw.credentialFingerprint);

  const candidates = [checkerResult.status];
  if (localCount > 0 && ENFORCES_TOKEN_UNIQUENESS.has(providerName)) {
    candidates.push('LIMITED');
  }

  const entry = buildEntry({
    provider:      providerName,
    credentialRef: raw.credentialRef,
    displayName:   raw.displayName,
    fingerprint:   raw.credentialFingerprint
  });

  entry.status          = resolveStatus(candidates);
  entry.checkedAt       = new Date().toISOString();
  entry.expiresAt       = checkerResult.expiresAt ?? null;
  entry.quotas          = checkerResult.quotas    ?? [];
  entry.details         = {
    ...(checkerResult.details ?? {}),  // provider extras first — explicit fields below win
    validated:           checkerResult.validated   ?? false,
    limitations:         checkerResult.limitations ?? [],
    localActiveSessions: localCount,
  };

  return entry;
}

module.exports = { getCredentialStatus, listCredentialStatuses };
```

### Error mapping (shared)

| Failure stage | Result |
|---|---|
| Unknown provider or `pwd` | Service throws `ProviderError` (404, `CREDENTIAL_STATUS_UNSUPPORTED`) before `getProvider()` is called — `mapErrorToHttp` returns 404. Note: `UnsupportedProviderError` from the factory is 400, but the service never reaches the factory for unsupported providers. |
| Provider lacks hook | 400 `CREDENTIAL_STATUS_UNSUPPORTED` |
| Credential ref missing/unloadable in **single** mode | `UNKNOWN` entry, HTTP 200; `details.errorCode` carries the loader code (e.g. `CODESPACES_NO_CREDENTIAL`) |
| Same in **list** mode | Per-credential `UNKNOWN` entry; other credentials unaffected |
| Checker throws (transient upstream failure) | `UNKNOWN` entry, **not cached** |
| Checker returns `status: 'UNKNOWN'` directly | `UNKNOWN` entry, **not cached** |

Loader error codes are already secret-free (they name the problem, not the
credential value), so they pass through to `details.errorCode` unchanged.

---

## 4. `base-provider.js` hook

```javascript
/**
 * Check a credential's validity and quota without creating sessions or running
 * commands. Returns:
 *   { status, quotas, limitations, validated, expiresAt, details? }
 *
 * Throwing causes the dispatcher to return an UNKNOWN entry (not cached).
 * Returning { status: 'UNKNOWN' } has the same effect and is appropriate for
 * provider-internal soft failures (e.g. a sub-call that is expected to be
 * unreliable).
 *
 * Optional — base default throws to signal "not implemented". Providers that
 * support status checking override this method.
 */
async getCredentialStatus(loadedCredential) {
  throw new Error('getCredentialStatus must be implemented by provider');
}
```

`pwd-provider` intentionally does **not** implement it. The service layer
rejects `pwd` before ever reaching the factory, so `pwd-provider` never needs
to declare this method.

---

## 5. Routes (`src/routes/sessions.js`)

Add the require at the top of the file alongside the other service imports:

```javascript
const credentialStatusService = require('../services/credential-status-service');
```

Register the route **alongside the other credential routes** (lines ~305–325,
after `/codesandbox-credentials` and `/codespaces-credentials`) and **before**
`router.get('/:id', ...)`. The `/:provider/credentials/status` path is three
segments and cannot collide with the one-segment `/:id` in Express, but placing
it in the credential-routes block is cleaner and keeps the router safe against
future single-segment additions.

```javascript
// Alongside the existing /google-credentials, /codesandbox-credentials, /codespaces-credentials routes
// GET /api/v1/sessions/:provider/credentials/status
// GET /api/v1/sessions/:provider/credentials/status?credentialRef=gcloud/account-a.json
router.get('/:provider/credentials/status', async (req, res) => {
  try {
    const { provider } = req.params;
    const { credentialRef } = req.query;  // slashes in refs → query param (spec §8.2)
    const result = credentialRef
      ? await credentialStatusService.getCredentialStatus(provider, { credentialRef })
      : await credentialStatusService.listCredentialStatuses(provider);
    return res.json(result);
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to check credential status');
  }
});
```

Auth: inherits the router's existing server-token middleware — no changes
needed.

No auto-status on the existing `*-credentials` file-listing endpoints (spec
open question #2 resolved: explicit-only, because status checks call upstream
APIs and should never be triggered by a passive listing).

Env additions (document in README and `.env.example` when implemented):

```bash
CREDENTIAL_STATUS_CACHE_TTL_MS=300000   # optional, default 5 min (300000 ms)
```

---

## Decisions Closing Spec Open Questions

1. **Route**: provider-scoped path `/:provider/credentials/status` under the
   existing session router; single + list share one route via optional
   `credentialRef` query param.
2. **Auto-check on listing**: never — explicit endpoint only.
3. **Cache persistence**: in-memory only (consistent with `read-cache.js`);
   restarts re-validate.
4. **Org billing scope**: personal accounts first (Codespaces plan notes org
   deferral).
5. **Static limits**: included in every response via `quotas[].limit` +
   `details.referenceLimits` (cheap constants, high client value).

---

## Test Checklist (shared)

- Cache: miss → hit within TTL → miss after TTL; `UNKNOWN` never cached
  regardless of whether it came from a thrown error or a returned value.
- List mode: one failing credential does not affect others (`Promise.allSettled`).
- Precedence table unit tests, including `LIMITED`-from-local-constraint
  overriding `AVAILABLE`, and `QUOTA_EXHAUSTED` beating `LIMITED`.
- `buildUnknownEntry`: error message is redacted; `errorCode` is preserved.
- Redaction: no token/key material in entries or logs (fingerprint only).
- Credential without fingerprint: check runs uncached (no
  `${provider}:undefined` cache-key collisions).
- Route ordering (defensive): `/:provider/credentials/status` registered before
  `/:id`; verify `gcs`, `codesandbox`, `codespaces` reach the status handler,
  never the session handler.
- Route: unknown provider → 404; `pwd` → 404; missing `credentialRef` lists all.
- `PROVIDER_PREFIXES.gcs === 'gcloud'` matches what `credentials-lister.js`
  uses (regression: must not be `'google'`).
