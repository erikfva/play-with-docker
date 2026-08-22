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
// Prevent a burst of identical cache misses from multiplying upstream calls.
const inFlight = new Map(); // key -> Promise<checkerResult>

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

/**
 * Return a cached checker result or share one in-progress upstream check.
 * UNKNOWN results and rejected checks are deliberately not cached.
 */
async function getOrCheckStatus(key, checker) {
  const cached = getCachedStatus(key);
  if (cached) return cached;

  let pending = inFlight.get(key);
  if (!pending) {
    pending = Promise.resolve()
      .then(checker)
      .then((result) => {
        if (result?.status !== 'UNKNOWN') putCachedStatus(key, result);
        return result;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

function clearCache() {
  cache.clear();
  // Do not cancel or detach existing requests: they must remain coalesced and
  // remove themselves from inFlight when they settle.
}

module.exports = { cacheKey, getOrCheckStatus, clearCache };
```

**Caching rule**: cache only the upstream **checker result** (`{ status, quotas, limitations, validated, expiresAt, details? }`) — not the fully finalized entry. `finalizeEntry` (DB session count + precedence) always runs fresh on every request because local session state changes frequently and the DB query is cheap. Only cache when `result.status !== 'UNKNOWN'`:
- A checker that **throws** (caught by the dispatcher → `buildUnknownEntry`) is never cached
- A checker that **returns `{ status: 'UNKNOWN' }`** directly is never cached

All other checker statuses — `INVALID`, `EXPIRED`, `QUOTA_EXHAUSTED`, `UNAVAILABLE`, `AVAILABLE` — are cached for the full TTL to protect upstream rate limits. Concurrent checks with the same key share one in-flight upstream request. Note: `LIMITED` is never returned by a checker directly — it is always produced by `finalizeEntry` based on local session state, so it never enters the cache.

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
    // Loader and SDK messages can contain absolute paths, S3 locations, or
    // request URLs. Error codes are already safe and actionable; expose only
    // a stable message rather than trying to redact every location format.
    entry.details.errorMessage = 'Credential status could not be determined.';
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
 * Returns null when the count cannot be reported accurately.
 *
 * Terminal sets MUST mirror the actual DB partial indexes (db.js):
 *   codesandbox index: NOT IN ('TERMINATED', 'DELETED', 'FAILED')
 *   codespaces  index: NOT IN ('TERMINATED', 'FAILED')
 */
async function countActiveSessions(db, provider, fingerprint) {
  // Existing GCS sessions never persisted a canonical credential identity.
  // Counting by raw credentialRef is misleading because list mode may discover
  // an absolute local path while session creation may have stored a relative
  // ref or basename for the same credential. GCS has no uniqueness constraint,
  // so report "unavailable" rather than a false zero.
  if (provider === 'gcs') return null;
  if (!fingerprint) return 0;

  // Per-provider terminal sets mirror the DB partial indexes exactly.
  // Using the wrong set causes false negatives (LIMITED not reported when
  // the DB would actually block a new session).
  const TERMINAL_SETS = {
    codesandbox: ['TERMINATED', 'DELETED', 'FAILED'],
    codespaces:  ['TERMINATED', 'FAILED']  // DELETED never set; STOPPED still blocks
  };
  const terminalStatuses = TERMINAL_SETS[provider] || ['TERMINATED', 'DELETED', 'FAILED'];
  const placeholders = terminalStatuses.map(() => '?').join(', ');
  // NOTE: the column must stay UNQUOTED. It was created via unquoted DDL
  // ("ADD COLUMN credentialFingerprint TEXT"), so Postgres stored it lowercase
  // ('credentialfingerprint'). Quoting it as "credentialFingerprint" would
  // raise: column "credentialFingerprint" does not exist.
  // Using ? placeholders — db.js convertSql() rewrites them to $1/$2/... before
  // passing to pg, consistent with every other caller in the codebase.
  const sql = `
    SELECT COUNT(*)::int AS count FROM sessions
    WHERE provider = ?
      AND credentialFingerprint = ?
      AND COALESCE(status, '') NOT IN (${placeholders})
  `;
  const row = await db.get(sql, [provider, fingerprint, ...terminalStatuses]);
  return row?.count ?? 0;
}
```

Result lands in `details.localActiveSessions`, never inside `quotas[]`.

Providers that enforce token uniqueness (`codesandbox`, `codespaces`) contribute
a `LIMITED` candidate when `localActiveSessions > 0`. GCS does not enforce
uniqueness and existing rows lack a canonical credential identity, so
`details.localActiveSessions` is `null` for GCS and never downgrades the status.

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
const crypto = require('crypto');
const { getProvider } = require('./provider-factory');
const { ProviderError } = require('./errors/provider-errors');
const db = require('../db/db');
const { listAvailableCredentials } = require('./credentials-lister');
const { cacheKey, getOrCheckStatus } = require('./status-cache');
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

const LOADERS = {
  // GCS: derive a stable fingerprint from the credential ref string for the
  // status cache. Existing GCS session rows do not persist a fingerprint.
  // initGoogleCredentialsFromS3IfNeeded() does not return a fingerprint, so
  // we derive one here. Hashing the ref string is stable (same ref → same key)
  // and cheap. It identifies the credential file, not the service-account identity,
  // which is sufficient for status-cache keying.
  gcs: async (ref) => ({
    credentialsPath: await initGoogleCredentialsFromS3IfNeeded(ref),
    credentialRef: ref,
    credentialFingerprint: `sha256:${crypto.createHash('sha256').update(ref).digest('hex')}`
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
 * `displayName` is optional — the file basename from credentials-lister;
 * used as the `credential` field in the response to avoid leaking absolute
 * filesystem paths in local/s3fs modes.
 */
async function getCredentialStatus(providerName, { credentialRef, displayName } = {}) {
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
    // Attach displayName so finalizeEntry → buildEntry can use it.
    // Loaders don't return displayName; it comes from credentials-lister.
    raw.displayName = displayName || null;
  } catch (loadError) {
    // Unresolvable ref → UNKNOWN entry, HTTP 200 (NFR: resilience)
    return buildUnknownEntry(
      { provider: providerName, credentialRef, displayName, credentialFingerprint: null },
      loadError
    );
  }

  // Cache only when a fingerprint exists — otherwise the key would collide
  // across unrelated credentials (`${provider}:undefined`).
  const key = raw.credentialFingerprint
    ? cacheKey(providerName, raw.credentialFingerprint)
    : null;

  // Check/cache only the upstream checker result.
  // finalizeEntry (DB session count + precedence) always runs fresh — local
  // session state changes frequently and the DB query is cheap (indexed).
  // Caching the finalized entry would freeze localActiveSessions and the
  // LIMITED status within the TTL.
  let result;
  try {
    result = key
      ? await getOrCheckStatus(key, () => provider.getCredentialStatus(raw))
      : await provider.getCredentialStatus(raw);
  } catch (error) {
    // Transient/unexpected failure → UNKNOWN, never cached
    return buildUnknownEntry(raw, error);
  }

  return finalizeEntry(providerName, raw, result);  // always fresh DB call
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
  // Pass displayName (file basename from credentials-lister) so that
  // buildEntry uses it as `credential` rather than the raw key, which is an
  // absolute filesystem path in local/s3fs modes (e.g. /mount/codesandbox/account.json).
  // A full listing can contain many credentials. Bound validation fan-out so a
  // single request cannot burst-rate-limit the provider APIs.
  const settled = await mapWithConcurrency(
    credentials,
    4,
    (c) => getCredentialStatus(providerName, { credentialRef: c.key, displayName: c.displayName })
  );
  return {
    provider: providerName,
    mode,
    credentials: settled.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : buildUnknownEntry(
            { provider: providerName, credentialRef: credentials[i].key, displayName: credentials[i].displayName },
            r.reason
          )
    )
  };
}

/**
 * Like Promise.allSettled(items.map(mapper)), but starts no more than `limit`
 * validations at once and preserves the input order.
 */
async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: 'fulfilled', value: await mapper(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}

/**
 * Merge checker result with local DB state and assemble the final entry.
 */
async function finalizeEntry(providerName, raw, checkerResult) {
  const localCount = await countActiveSessions(
    db,
    providerName,
    raw.credentialFingerprint
  );

  const candidates = [checkerResult.status];
  if (localCount > 0 && ENFORCES_TOKEN_UNIQUENESS.has(providerName)) {
    candidates.push('LIMITED');
  }

  const limitations = [...(checkerResult.limitations ?? [])];
  if (providerName === 'gcs') {
    limitations.push(limitation(
      'details.localActiveSessions',
      'Local active-session count is unavailable for GCS because existing session rows do not persist a canonical credential identity. GCS has no credential uniqueness constraint, so this does not affect availability.'
    ));
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
    limitations,
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
6. **Aliases deferred** (`credential` field, spec open question #6): no alias
   registry in v1. `credential` carries `displayName` (file basename) when
   available from `credentials-lister`, falling back to `credentialRef`. This
   prevents absolute filesystem paths from leaking in local/s3fs modes where
   `credentials-lister` returns `key` as a full path (e.g. `/mount/codesandbox/account.json`)
   but `displayName` is always `path.basename()` (e.g. `account.json`).
   The list response also includes `mode` (`'local'`, `'s3fs'`, or `'s3-api'`)
   as a convenience extension beyond the spec §8.1 example shape.

---

## Test Checklist (shared)

- Cache: miss → hit within TTL → miss after TTL; `UNKNOWN` never cached
  regardless of whether it came from a thrown error or a returned value.
- Cache stores checker result only (not the finalized entry): calling the same
  credential twice in quick succession hits the cache for the upstream call but
  still runs `finalizeEntry` (DB count) fresh both times.
- `LIMITED` status is never stored in the cache — it is produced by
  `finalizeEntry` from local session state, not by the checker.
- `QUOTA_EXHAUSTED`/`INVALID` cached for full TTL: a follow-up request within
  the TTL returns the cached checker result without hitting upstream again, but
  `localActiveSessions` and `LIMITED` promotion are still re-evaluated live.
- List mode: one failing credential does not affect others; validations run at
  a bounded concurrency of four and preserve credential-list order.
- Precedence table unit tests, including `LIMITED`-from-local-constraint
  overriding `AVAILABLE`, and `QUOTA_EXHAUSTED` beating `LIMITED`.
- `buildUnknownEntry`: preserves a safe `errorCode`, returns the stable generic
  error message, and never exposes a filesystem path, S3 reference, token, or key.
- GCS local-session count: `details.localActiveSessions === null` and
  `details.limitations[]` explains that existing rows lack a canonical
  credential identity. Verify GCS never produces `LIMITED` from local state.
- Concurrent same-credential cache misses share one upstream checker request;
  rejected and `UNKNOWN` results do not populate the cache.
- Credential without fingerprint: check runs uncached (no
  `${provider}:undefined` cache-key collisions).
- `credential` field in list mode uses `displayName` (file basename), not the
  raw `key` (which is an absolute path in local/s3fs modes). Verify
  `credential === 'account.json'` not `'/mount/codesandbox/account.json'`.
- Unrecognized checker status (e.g. a typo'd string not in `PRECEDENCE`) →
  `resolveStatus` returns `'UNKNOWN'` → entry is not cached.
- Route ordering (defensive): `/:provider/credentials/status` registered before
  `/:id`; verify `gcs`, `codesandbox`, `codespaces` reach the status handler,
  never the session handler.
- Route: unknown provider → 404; `pwd` → 404; missing `credentialRef` lists all.
- `PROVIDER_PREFIXES.gcs === 'gcloud'` matches what `credentials-lister.js`
  uses (regression: must not be `'google'`).
