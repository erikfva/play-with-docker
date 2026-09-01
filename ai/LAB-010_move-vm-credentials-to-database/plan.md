# LAB-010: Implementation Plan

## Reuse Map

Before touching any file, here is what already exists and can be used directly:

| Need | Reuse from |
|:---|:---|
| DB query helpers (`run`, `all`, `get`) | `src/db/db.js` — identical API used everywhere |
| `ensureColumn` pattern for safe migrations | `src/db/db.js` — already handles idempotent column additions |
| `ProviderError` for structured error responses | `src/services/errors/provider-errors.js` |
| `mapErrorToHttp` for consistent error serialization | `src/routes/sessions.js` — copy the same function |
| `requireServerToken` middleware | `src/middleware/require-server-token.js` — mount as-is |
| TTL cache pattern (`getCachedCredential` / `setCachedCredential`) | `src/services/providers/codespaces/credentials-loader.js` — copy the 5-min TTL Map pattern |
| `parseTokenFromBuffer` plain-text + JSON PAT parsing | `src/services/providers/codespaces/credentials-loader.js` |
| `getRowValue` case-insensitive column helper | `src/utils/helpers.js` |
| `uuidv4` for ID generation | Already in `package.json` (`uuid`) |
| `crypto.createHash('sha256')` fingerprinting | Already used in both credential loaders |

---

## Step-by-Step Implementation

### Step 1 — `src/db/db.js`: Add `vps` table and indexes

**What to add** at the end of the existing `db.ready` IIFE, after the Codespaces index block:

```js
// vps table
await run(`CREATE TABLE IF NOT EXISTS vps (
  id                    TEXT PRIMARY KEY,
  provider              TEXT NOT NULL,
  name                  TEXT NOT NULL,
  credentialFileName    TEXT NOT NULL,
  credentialContent     TEXT NOT NULL,
  credentialFingerprint TEXT NOT NULL,
  createdAt             TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updatedAt             TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
)`);

await run(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_vps_provider_name
  ON vps (provider, name)
`);

await run(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_vps_provider_fingerprint
  ON vps (provider, credentialFingerprint)
`);

console.log('[DB] ✓ vps table ready');
```

**No changes** to any existing table or index. Safe to run against an existing database.

---

### Step 2 — `src/services/db-credentials-loader.js`: New module

This is the core of the feature. It resolves a `(provider, name)` pair from the `vps` table and returns the same credential shape that the existing loaders return.

**Key design decisions:**
- Reuse the TTL cache pattern verbatim from `codespaces/credentials-loader.js` (`CREDENTIAL_CACHE_TTL_MS = 5 * 60 * 1000`, same `getCachedCredential` / `setCachedCredential` helpers).
- Cache key: `vps:${provider}:${name}`.
- For `codespaces` / `codesandbox`: reuse `parseTokenFromBuffer` logic (JSON `token` field or plain-text). **Critically: valid JSON that lacks a `token` field must throw `VPS_CONTENT_INVALID` (not be treated as a plain-text PAT).** This matches the existing behaviour in `codespaces/credentials-loader.js` line 175 — the `catch` block re-throws `CODESPACES_NO_CREDENTIAL` before falling through to plain-text. The same guard must be applied here: if `JSON.parse` succeeds and returns an object but has no `token` field, reject immediately.
- For `gcs`: write the JSON content to a temp file at `path.join(os.tmpdir(), 'gcs-credentials', '<sha256(credentialContent)>.json')` — same directory and hash scheme as `google-credentials-loader.js`'s `getDownloadedCredentialsPath`. Use `fs.mkdir({ recursive: true })` and mode `0o600`. Return `{ keyFilePath, credentialRef, credentialFingerprint }`.
- On cache miss after DB miss: throw `ProviderError` with code `VPS_NOT_FOUND`, status `404`.
- Export a `invalidateCache(provider, name)` function so the `PUT /api/v1/vps/:id` route can evict the entry.

**Skeleton:**

```js
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const db = require('../db/db');
const { ProviderError } = require('./errors/provider-errors');

const CREDENTIAL_CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key → { result, cachedAt }

function getCached(key) { ... }      // identical to codespaces loader
function setCached(key, result) { } // identical to codespaces loader
function invalidateCache(provider, name) { cache.delete(`vps:${provider}:${name}`); }

async function loadCredentialByRef(provider, name) {
  const cacheKey = `vps:${provider}:${name}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // SELECT * is acceptable here — credentialContent is needed by parseContent.
  // Never log this row; fingerprint only in any console output.
  const row = await db.get(
    'SELECT * FROM vps WHERE provider = ? AND name = ?',
    [provider, name]
  );

  if (!row) {
    throw new ProviderError(`VPS not found: ${provider}/${name}`, {
      code: 'VPS_NOT_FOUND', statusCode: 404
    });
  }

  const result = await parseContent(provider, row);
  setCached(cacheKey, result);
  return result;
}

async function parseContent(provider, row) { ... } // branches on provider

module.exports = { loadCredentialByRef, invalidateCache };
```

> **Note on db.js query syntax:** `db.run` / `db.get` use `?` placeholders (converted to `$N` internally by `convertSql`). Use `?` consistently, same as every existing caller. `SELECT *` is used here because `parseContent` needs `credentialcontent` — this row is never passed to a logger or response.

---

### Step 3 — `src/routes/vps.js`: New CRUD router

Follows the exact same structure as `src/routes/sessions.js`:
- Uses `db.run` / `db.all` / `db.get` directly.
- Uses the same `mapErrorToHttp` function (copy it, or extract to a shared utility).
- Uses `uuidv4()` for `id` generation on `POST`.
- Calls `invalidateCache(provider, name)` from `db-credentials-loader.js` on `PUT`.

**Routes to implement:**

```
POST   /       → validate provider+name+credentialContent, insert into vps, return 201 (safe columns only)
GET    /       → SELECT safe columns [WHERE provider = ?]; if ?provider= present, validateProvider first
GET    /:id    → SELECT safe columns WHERE id = ?, return 200 or 404
PUT    /:id    → require at least one of {credentialContent, credentialFileName};
                 UPDATE vps SET ..., updatedAt = CURRENT_TIMESTAMP WHERE id = ?;
                 invalidate cache; return 200 (safe columns only)
DELETE /:id    → fetch {credentialFingerprint, provider} only; check active sessions; DELETE; return 204
```

**PUT contract:** reject with `400 VPS_CONTENT_INVALID` if both `credentialContent` and `credentialFileName` are absent. When `credentialContent` is present, re-validate and re-fingerprint; also call `invalidateCache(provider, name)` to evict the cached entry before responding. `updatedAt` must always be set to `CURRENT_TIMESTAMP` in the UPDATE, not left to the application layer.

**Validation helpers (extracted to `src/services/vps-credential-utils.js` — shared between `vps.js` route and `db-credentials-loader.js`):**

```js
function validateProvider(provider) {
  if (!['gcs', 'codesandbox', 'codespaces'].includes(provider)) {
    throw new ProviderError(`Invalid provider: ${provider}`, {
      code: 'VPS_INVALID_PROVIDER', statusCode: 400
    });
  }
}

function validateName(name) {
  if (!name || !name.trim() || /[/\\]/.test(name) || name.includes('..')) {
    throw new ProviderError('Invalid VPS name: must be non-empty and contain no path separators or traversal sequences', {
      code: 'VPS_NAME_INVALID', statusCode: 400
    });
  }
}

// Provider branches are split — codesandbox does NOT support plain-text:
function validateAndFingerprintContent(provider, credentialContent) {
  if (provider === 'codespaces') {
    // JSON with token field, OR plain-text PAT.
    // Valid JSON without token field → throws VPS_CONTENT_INVALID (never falls to plain-text).
    // Returns { token, fingerprint }
  } else if (provider === 'codesandbox') {
    // JSON with token field only. Plain-text is rejected.
    // Returns { token, fingerprint }
  } else if (provider === 'gcs') {
    // JSON object with at minimum a `type` field.
    // Returns { keyJson, fingerprint }
    // fingerprint = sha256(JSON.stringify(JSON.parse(credentialContent))) for stability
  }
  throw new ProviderError('VPS_CONTENT_INVALID', { code: 'VPS_CONTENT_INVALID', statusCode: 400 });
}
```

**GCS temp file path:** Use `path.join(os.tmpdir(), 'gcs-credentials', '<sha256(credentialContent)>.json')` with `fs.mkdir({ recursive: true })` and mode `0o600` — matching `google-credentials-loader.js`'s `getDownloadedCredentialsPath`. Do **not** use `/tmp/vps-credentials/` directly (os.tmpdir() is portable).

**PUT stale file note:** When `PUT /api/v1/vps/:id` changes `credentialContent` for a GCS record, the old temp file at the previous fingerprint path becomes stale. `invalidateCache(provider, name)` evicts the in-memory entry; the next `loadCredentialByRef` call will write a fresh file at the new fingerprint path. The old file is left behind in `os.tmpdir()` — this matches the existing `google-credentials-loader.js` behaviour (no cleanup on rotation) and is acceptable.

Extracting to `vps-credential-utils.js` avoids duplicating the `parseTokenFromBuffer` guard in both the route (on `POST`/`PUT` input validation) and the loader (on DB read). Both import from the same utility.

**`credentialContent` stripping — pg column casing:** PostgreSQL lowercases unquoted identifiers, so `row.credentialContent` is `undefined` on a `SELECT *` result — the destructure `const { credentialContent, ...safe } = row` is a no-op and leaks nothing but also strips nothing. Fix: **never use `SELECT *` on `vps`**. Always select explicit columns with `AS` aliases to preserve camelCase, and omit `credentialcontent`:

```js
const VPS_SAFE_COLUMNS = `
  id,
  provider,
  name,
  credentialFileName    AS "credentialFileName",
  credentialFingerprint AS "credentialFingerprint",
  createdAt             AS "createdAt",
  updatedAt             AS "updatedAt"
`;
// credentialContent is intentionally excluded from every SELECT
```

Use `VPS_SAFE_COLUMNS` in all `GET` queries. For internal queries that need `credentialContent` (DELETE block check, PUT fetch-before-update), select only the specific columns needed with explicit `AS` aliases. Never `console.log` a row that was fetched with `credentialcontent` included.

**DELETE block check:**
```js
const blocking = await db.all(
  `SELECT id FROM sessions
   WHERE credentialFingerprint = ? AND provider = ?
   AND COALESCE(status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED')`,
  [row.credentialFingerprint, row.provider]
);
if (blocking.length > 0) {
  return res.status(409).json({
    error: 'VPS is in use by active sessions',
    code: 'VPS_IN_USE',
    details: { blockingSessionIds: blocking.map(s => s.id) }
  });
}
```

**Duplicate handling (DB unique index violations):**
PostgreSQL error code `23505` is already handled in `sessions.js` — apply same pattern. Constraint names from the DDL in Step 1 are used to distinguish the two cases precisely:
```js
if (dbError.code === '23505') {
  const isNameDupe = dbError.constraint === 'idx_vps_provider_name';
  return res.status(409).json({
    error: isNameDupe ? 'A VPS with this name already exists for this provider' : 'Duplicate credential token for this provider',
    code: isNameDupe ? 'VPS_ALREADY_EXISTS' : 'VPS_DUPLICATE_TOKEN'
  });
}
```
This covers both concurrent `POST` requests hitting the same token (fingerprint index `idx_vps_provider_fingerprint` → `VPS_DUPLICATE_TOKEN`) and duplicate name inserts (`idx_vps_provider_name` → `VPS_ALREADY_EXISTS`). Do not rely on `dbError.detail` substring matching — the constraint name is authoritative and stable.

---

### Step 4 — `src/server.js`: Mount the new router

Add two lines, mirroring the existing sessions router mount:

```js
const vpsRoutes = require('./routes/vps');
// ...
app.use('/api/v1/vps', requireServerToken, vpsRoutes);
```

No other changes to `server.js`.

---

### Step 5 — `src/routes/sessions.js` + provider credential loaders: DB-first resolution

**The problem with a route-only approach:** Providers call their own credential loaders internally — `gcs-provider.js` calls `initGoogleCredentialsFromS3IfNeeded(credentialRef)`, `codesandbox-provider.js` calls `loadCodeSandboxCredentials(credentialRef)`, `codespaces-provider.js` calls `loadCodespacesCredentials(credentialRef)`. If `sessions.js` only resolves at the route level and then passes `credentialRef: 'vm-manager232'` into `provider.createSession()`, the provider's internal loader will try to find `vm-manager232` as a filesystem path or S3 key and fail. The DB-resolved result must reach the internal loaders.

**Chosen approach — DB-first inside each provider's credential loader (thin prefix wrapper):**

Add a DB-first check at the top of each provider's existing `load*Credentials` function, before any filesystem/S3 logic:

```js
// Pattern applied to loadCodespacesCredentials, loadCodeSandboxCredentials,
// and initGoogleCredentialsFromS3IfNeeded:
const { loadCredentialByRef } = require('../../../services/db-credentials-loader');

async function loadCodespacesCredentials(credentialRef) {
  // 1. Try DB first
  try {
    const dbResult = await loadCredentialByRef('codespaces', credentialRef);
    if (dbResult) return dbResult; // already in correct {token, credentialRef, credentialFingerprint} shape
  } catch (err) {
    if (err.code !== 'VPS_NOT_FOUND') throw err;
    // VPS_NOT_FOUND → fall through to legacy
    console.warn(`[Credentials] DB lookup miss for codespaces/${credentialRef}, falling back to legacy loader`);
  }

  // 2. Legacy path unchanged below
  const resolvedRef = resolveCredentialReference(credentialRef);
  return loadCredentialFile(resolvedRef);
}
```

Same pattern for `loadCodeSandboxCredentials` and for `initGoogleCredentialsFromS3IfNeeded` (which also sets `process.env.GOOGLE_APPLICATION_CREDENTIALS` — when DB path resolves, call it with the `keyFilePath` returned by `db-credentials-loader`).

**This means the following files are also edited (update File Change Summary):**
- `src/services/providers/codespaces/credentials-loader.js`
- `src/services/providers/codesandbox/credentials-loader.js`
- `src/services/google-credentials-loader.js`

The route-level `resolveCredentialRef` wrapper in `sessions.js` is **removed** — it is no longer needed since providers handle the fallback internally. The only change to `sessions.js` is removing the `initGoogleCredentialsFromS3IfNeeded` direct call in `DELETE /:id` (the GCS provider's loader now handles it).

> **Why not patch route only:** `POST /:id/command`, `GET /:id` (GCS refresh), and `DELETE /:id` (GCS terminate) all ultimately invoke internal provider credential loading. A route-level intercept that sets `GOOGLE_APPLICATION_CREDENTIALS` only works for GCS and only for routes that explicitly call `initGoogleCredentialsFromS3IfNeeded` — it misses `codesandbox` and `codespaces` entirely.

---

### Step 6 — `scripts/seed-credentials.js`: Import utility

Standalone Node.js script, no new dependencies. Uses built-in `fs`, `path`, `fetch` (Node 18+ native).

```
node scripts/seed-credentials.js
  [--base-dir ./credentials]   # default
  [--url http://localhost:3000] # default
  [--token $SERVER_TOKEN]       # from env SERVER_TOKEN if not passed
```

Directory walk logic:
- `gcloud/` → provider `gcs`
- `codesandbox/` → provider `codesandbox`
- `codespaces/` → provider `codespaces`
- Files with `.json` or `.txt` extension only.
- `name` = filename without extension.
- `credentialFileName` = filename with extension.
- POST to `/api/v1/vps`, skip on `VPS_ALREADY_EXISTS` (409), log failures.

Add to `package.json`:
```json
"scripts": {
  "seed-credentials": "node scripts/seed-credentials.js"
}
```

---

## File Change Summary

| File | Type | What changes |
|:---|:---:|:---|
| `src/db/db.js` | Edit | Append `vps` table + 2 indexes to schema bootstrap |
| `src/services/vps-credential-utils.js` | New | Shared validation + per-provider fingerprinting logic (used by both `vps.js` and `db-credentials-loader.js`) |
| `src/services/db-credentials-loader.js` | New | DB-backed loader with TTL cache and `invalidateCache` |
| `src/routes/vps.js` | New | CRUD router for `/api/v1/vps` |
| `src/server.js` | Edit | 2 lines: import `vps.js`, mount at `/api/v1/vps` |
| `src/routes/sessions.js` | Edit | Remove direct `initGoogleCredentialsFromS3IfNeeded` call in `DELETE /:id` (now handled by GCS loader internally) |
| `src/services/providers/codespaces/credentials-loader.js` | Edit | Add DB-first prefix in `loadCodespacesCredentials` before legacy path |
| `src/services/providers/codesandbox/credentials-loader.js` | Edit | Add DB-first prefix in `loadCodeSandboxCredentials` before legacy path |
| `src/services/google-credentials-loader.js` | Edit | Add DB-first prefix in `initGoogleCredentialsFromS3IfNeeded` before legacy path |
| `scripts/seed-credentials.js` | New | Bulk import script |
| `package.json` | Edit | Add `seed-credentials` script entry |

**Not changed:**
- `src/services/credentials-lister.js`
- All provider implementations (gcs-provider, codesandbox-provider, codespaces-provider)
- All existing tests

---

## Implementation Order

1. `src/db/db.js` — schema first; everything else depends on the table existing.
2. `src/services/vps-credential-utils.js` — shared validation and fingerprinting; no dependencies of its own.
3. `src/services/db-credentials-loader.js` — imports `vps-credential-utils.js`; needed by provider loaders.
4. `src/routes/vps.js` — imports both utilities; can be tested in isolation once DB and utils are ready.
5. `src/server.js` — mount the router; one-liner once `vps.js` exists.
6. Provider loader edits (all three in parallel — same pattern, no interdependency):
   - `src/services/providers/codespaces/credentials-loader.js`
   - `src/services/providers/codesandbox/credentials-loader.js`
   - `src/services/google-credentials-loader.js`
7. `src/routes/sessions.js` — remove the now-redundant direct `initGoogleCredentialsFromS3IfNeeded` call; minimal change.
8. `scripts/seed-credentials.js` — standalone, no interdependencies.

---

## Risk Notes

- **`credentialContent` in logs:** Never `console.log` a row fetched with `credentialcontent` included. Use `VPS_SAFE_COLUMNS` for all read responses; use explicit column selection for internal queries.
- **`db.js` query syntax:** All queries use `?` placeholders (not `$1`). The `convertSql` helper in `db.js` handles the conversion. Do not mix syntaxes.
- **GCS temp file path:** Use `path.join(os.tmpdir(), 'gcs-credentials', '<sha256>.json')` with `fs.mkdir({ recursive: true })` and mode `0o600`.
- **Cache key prefix:** `vps:${provider}:${name}` — `invalidateCache(provider, name)` must use the same prefix. Both `PUT` and `DELETE` must call it so no stale in-memory entry outlives its DB row.
- **Cache invalidation on PUT:** Call `invalidateCache(provider, name)` before responding; the next `loadCredentialByRef` call will write a fresh temp file at the new fingerprint path for GCS. Old temp files are not cleaned up — this matches existing loader behaviour.
- **Cache invalidation on DELETE:** Also call `invalidateCache(provider, name)` on successful delete so no stale in-memory entry is served after the row is removed.
- **PUT duplicate fingerprint:** Rely on the `23505` + `idx_vps_provider_fingerprint` constraint check rather than a pre-SELECT; this handles the concurrent case correctly.
- **Seed script skip logic:** Skip on `409 VPS_ALREADY_EXISTS` (name collision). Also skip on `409 VPS_DUPLICATE_TOKEN` (same token already registered under a different name) with a distinct log message — it's informational, not a failure.
- **sessions.js change is minimal:** Only the direct `initGoogleCredentialsFromS3IfNeeded(credentialRef)` call in `DELETE /:id` is removed; all other credential flows are handled inside provider loaders. Call this out in the PR description — reviewers will expect a sessions.js change and should understand why it is a deletion, not an addition.
- **NFR-1 enforcement:** Before opening any PR, grep `vps.js` and `db-credentials-loader.js` for any log or response that could include `credentialContent` or raw token values. Only `sha256:<hex>` fingerprints are permissible in logs and responses.
