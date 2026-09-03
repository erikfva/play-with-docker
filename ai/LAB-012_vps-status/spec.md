# LAB-012: Persist Provider Credential Status in VPS Table

**Issue Type**: Story
**Priority**: Medium
**Component**: VPS Management API, Credential Status, Database
**Labels**: vps, credentials, status, persistence, providers
**Epic**: Multi-Provider VM Orchestration

> **Reference PR**: https://github.com/erikfva/play-with-docker/pull/9 — Provider Credential Status and Availability (LAB-009). This story persists the normalized status contract introduced in that PR into the `vps` table so consumers can read availability without an extra provider round-trip, and adds a timestamp column that records when the persisted status was last refreshed from the provider API.

---

## Summary

Persist the normalized provider credential status produced by the LAB-009 `credential-status-service` (`getCredentialStatus` / `listCredentialStatuses` → `provider.getCredentialStatus`) into the `vps` table, and add a new timestamp column that records when that status was last refreshed from the upstream provider API.

Concretely:

1. **Persisted `status`** — the `vps.status JSONB` column added in LAB-011 becomes the durable store for the full normalized status entry (`status`, `checkedAt`, `expiresAt`, `quotas[]`, `details`). It is populated on demand by re-checking the provider API, not by clients writing arbitrary JSON.
2. **New `statusCheckedAt`** — a `TIMESTAMP WITH TIME ZONE` column that records the wall-clock time of the last successful or unsuccessful provider check that wrote `status`. Cheap to sort/filter on, unlike the JSONB `status` column itself.
3. **Refresh endpoints** — explicit API operations that fetch fresh status from the provider (`provider.getCredentialStatus` via the shared `credential-status-service` dispatcher), write `status` + `statusCheckedAt` back to the row, and return the updated VPS object. Reads (`GET /api/v1/vps`, `GET /api/v1/vps/:id`) serve the persisted values without re-hitting the provider by default.

---

## Background

LAB-009 (PR #9) introduced a provider-agnostic credential-status subsystem:

- **Contract** — one normalized entry per credential: `{ provider, credential, credentialFingerprint, status, checkedAt, expiresAt, quotas[], details }` with a shared `status` enum (`AVAILABLE`, `UNAVAILABLE`, `INVALID`, `EXPIRED`, `QUOTA_EXHAUSTED`, `LIMITED`, `UNKNOWN`) and a `quotas[]` array of `{ quotaUnit, quotaPeriod, usage, limit, remaining }`.
- **Checkers** — `BaseProvider#getCredentialStatus(loadedCredential)` implemented per provider (`gcs`, `codesandbox`, `codespaces`) using low-impact validation calls (Cloud Shell `users.environments.get`, CodeSandbox `API.getMetaInfo()`, GitHub `GET /user` + `GET /user/codespaces` + billing preview endpoint). Errors are mapped to statuses; throws become `UNKNOWN`.
- **Dispatcher** — `src/services/credential-status-service.js` reuses the existing per-provider credential loaders (now DB-first via `db-credentials-loader.js` after LAB-010), applies local session-state precedence (`LIMITED` when a non-terminal session already consumes the token), and caches upstream checker results for a configurable TTL (`CREDENTIAL_STATUS_CACHE_TTL_MS`, default 5 min) via `src/services/status-cache.js` (`cacheKey` = `provider:fingerprint`). Only non-`UNKNOWN` checker results are cached; `LIMITED` is never cached because it is derived from local DB state.
- **Routes** — `GET /api/v1/sessions/:provider/credentials/status?credentialRef=` (single) and the same route without `credentialRef` (list). Listing uses `credentials-lister.js` over `gcloud/` / `codesandbox/` / `codespaces` prefixes and fans out with `mapWithConcurrency(4)`.

What LAB-009 **did not** do is persist anything. Every status read re-hits the provider (modulo the short in-memory TTL) and nothing is stored in the `vps` table.

LAB-011 added the durable column that makes persistence possible:

```sql
ALTER TABLE vps ADD COLUMN status JSONB DEFAULT NULL;
-- via ensureColumn('vps', 'status', ...) in src/db/db.js
```

and exposed `status` + `sessionActive` in `GET /api/v1/vps` and `GET /api/v1/vps/:id` (still `null` until something writes it). Sorting by `status` is intentionally unsupported because JSONB has no meaningful total order.

This story completes the loop: **check → normalize → persist → serve**.

- Operators get a cheap, single-call inventory view (`GET /api/v1/vps` already returns `status` and `sessionActive` together) without paying a provider fan-out on every list request.
- Consumers that need freshness explicitly opt into a provider call (`POST …/refresh`) and the resulting `statusCheckedAt` tells them how stale the persisted value is.
- No client can write `status` or `statusCheckedAt` directly — only the server's refresh path writes them.

---

## User Stories

### US-1: Persisted `status` + new `statusCheckedAt` column

**As a** system operator
**I want** each VPS row to durably store the last provider status check and when it was performed
**So that** list/detail reads are cheap and callers can reason about freshness without re-hitting every provider

**Acceptance Criteria**:

- A new column `statusCheckedAt` is added to the `vps` table via the project's incremental migration pattern:
  ```sql
  ALTER TABLE vps ADD COLUMN statusCheckedAt TIMESTAMP WITH TIME ZONE DEFAULT NULL;
  ```
  Executed as `ensureColumn('vps', 'statusCheckedAt', 'ALTER TABLE vps ADD COLUMN statusCheckedAt TIMESTAMP WITH TIME ZONE DEFAULT NULL')` in `src/db/db.js`, consistent with the existing `status` migration. Using `ensureColumn` keeps deploys safe against an already-migrated database. PostgreSQL stores the identifier lowercased (`statuscheckedat`); the application restores camelCase with an `AS "statusCheckedAt"` alias in SELECTs.
- Column semantics:
  - `statusCheckedAt = NULL` means the VPS has never had its status refreshed from the provider (initial state after `POST /api/v1/vps`).
  - On every refresh attempt (success or mapped failure), `statusCheckedAt` is set to the current server time (`new Date().toISOString()` / `CURRENT_TIMESTAMP`). Transient provider failures that map to `UNKNOWN` still advance the timestamp — the timestamp records "when we last asked", not "when we last succeeded".
  - `statusCheckedAt` is `NULL`-able and has no default beyond `NULL`; it is only written by the refresh path (US-2/US-3/US-4).
- `status` column semantics are unchanged from LAB-011 (`JSONB DEFAULT NULL`, holds the full normalized entry when populated, `null` otherwise). The persisted shape is exactly the object returned by `credential-status-service.finalizeEntry` / the provider checker result merged with local state:
  ```json
  {
    "provider": "codespaces",
    "credential": "vm-manager232.json",
    "credentialFingerprint": "sha256:...",
    "status": "AVAILABLE",
    "checkedAt": "2026-09-03T10:00:00.000Z",
    "expiresAt": null,
    "quotas": [
      { "quotaUnit": "core-hours", "quotaPeriod": "month", "usage": 13.6, "limit": 120, "remaining": 106.4 },
      { "quotaUnit": "GB-month", "quotaPeriod": "month", "usage": 0.4, "limit": 15, "remaining": 14.6 }
    ],
    "details": {
      "validated": true,
      "limitations": [],
      "localActiveSessions": 0,
      "referenceLimits": { "computeCoreHoursPerMonth": 120, "storageGbMonth": 15 }
    }
  }
  ```
  The dispatcher already redacts long token-like runs and never includes raw `token` / `privateKey` material; the persisted JSON inherits that property.
- Both columns are included in `VPS_SAFE_COLUMNS` and returned in all read responses:
  - `GET /api/v1/vps` — each element in `vps[]` carries `status` (object|null) and `statusCheckedAt` (ISO 8601 string|null).
  - `GET /api/v1/vps/:id` — same two fields on the single object, alongside the existing `sessionActive` / `createdAt` / `updatedAt`.
- `status` and `statusCheckedAt` are **not writable** through `POST /api/v1/vps` or `PUT /api/v1/vps/:id`. If a caller includes either field in a create/update body, the field is silently ignored (same pattern LAB-011 already uses for `status`). Only the refresh endpoints (US-3/US-4) write them.
- `updatedAt` is **not** bumped when `status`/`statusCheckedAt` are refreshed. The refresh is a telemetry update, not a mutation of the credential identity; bumping `updatedAt` would conflate "credential rotated" with "quota re-checked" and break `sortBy=updatedAt` expectations. If the team prefers `updatedAt` to track every write, document the choice explicitly and keep it consistent across single and bulk refresh.

**Example — VPS that has never been checked**:

```json
{
  "id": "abc-123",
  "provider": "codespaces",
  "name": "vm-manager232",
  "credentialFileName": "vm-manager232.json",
  "credentialFingerprint": "sha256:...",
  "status": null,
  "statusCheckedAt": null,
  "sessionActive": false,
  "createdAt": "2026-08-01T10:00:00Z",
  "updatedAt": "2026-08-01T10:00:00Z"
}
```

**Example — VPS after a successful refresh**:

```json
{
  "id": "abc-123",
  "provider": "codespaces",
  "name": "vm-manager232",
  "credentialFileName": "vm-manager232.json",
  "credentialFingerprint": "sha256:...",
  "status": {
    "provider": "codespaces",
    "credential": "vm-manager232.json",
    "credentialFingerprint": "sha256:...",
    "status": "AVAILABLE",
    "checkedAt": "2026-09-03T10:12:00.000Z",
    "expiresAt": null,
    "quotas": [
      { "quotaUnit": "core-hours", "quotaPeriod": "month", "usage": 13.6, "limit": 120, "remaining": 106.4 },
      { "quotaUnit": "GB-month", "quotaPeriod": "month", "usage": 0.4, "limit": 15, "remaining": 14.6 }
    ],
    "details": { "validated": true, "limitations": [], "localActiveSessions": 0 }
  },
  "statusCheckedAt": "2026-09-03T10:12:00.000Z",
  "sessionActive": true,
  "createdAt": "2026-08-01T10:00:00Z",
  "updatedAt": "2026-08-01T10:00:00Z"
}
```

---

### US-2: Status refresh service (check → persist)

**As a** VPS operator
**I want** a server-side operation that re-checks a VPS credential against its provider API and persists the normalized result
**So that** the stored `status` stays aligned with the real provider state without clients needing to understand per-provider validation calls

**Acceptance Criteria**:

- A new or extended service module (e.g. `src/services/vps-status-service.js`, or methods added to `src/services/credential-status-service.js`) exposes:
  ```js
  // Refresh one VPS row by id — resolves credential, checks provider, persists.
  async function refreshVpsStatus(vpsId, { force } = {}) -> updatedVpsRow

  // Refresh many VPS rows — used by the bulk endpoint.
  async function refreshAllVpsStatuses({ provider, concurrency } = {}) -> { total, succeeded, failed, results[] }
  ```
- **Resolution** — credential material is resolved from the database row itself, not from filesystem/S3. For a given `vps` row the service uses `vps.provider` + `vps.name` (or the row's `credentialContent` directly) to build the `loadedCredential` object expected by `provider.getCredentialStatus`:
  - `codesandbox` / `codespaces`: `{ token, credentialRef: vps.name, credentialFingerprint: vps.credentialFingerprint }` (token extracted from `credentialContent` using the same per-provider parsing as `vps-credential-utils.validateAndFingerprintContent` / `db-credentials-loader`).
  - `gcs`: `{ credentialsPath, credentialRef: vps.name, credentialFingerprint: vps.credentialFingerprint }` (content is written to a temp file as `db-credentials-loader` already does for GCS; reuse that helper rather than re-implementing).
  - If the row's `credentialContent` is malformed or the token cannot be extracted, the refresh still persists an `UNKNOWN` entry with a limitation explaining the parse failure, rather than throwing a 500.
- **Checking** — the service delegates to the existing dispatcher:
  ```js
  const provider = getProvider(vps.provider);
  const checkerResult = await provider.getCredentialStatus(loaded);
  // or via credential-status-service.getCredentialStatus(vps.provider, { credentialRef: vps.name })
  // which already handles localActiveSessions counting + LIMITED precedence + token redaction.
  ```
  The service **reuses** the existing error-to-status mapping inside each provider's `getCredentialStatus` (GCS `mapGoogleError`, CodeSandbox `rate_limits` handling + `INVALID`/`QUOTA_EXHAUSTED`, Codespaces `validateToken` + `listCodespaces` + `getBillingUsageSummary` with `null` billing fallback). No new mapping logic is introduced.
- **Caching** — the refresh path respects the shared `status-cache.js` TTL by default (a recently-cached checker result is returned without re-hitting the provider). A `force: true` / `nocache` option bypasses the cache for operator-initiated refreshes that must see the current provider state. The cache key remains `provider:credentialFingerprint` as in PR #9; `LIMITED` (derived from local `countActiveSessions`) is never cached, and `UNKNOWN` is never cached.
- **Persistence** — after the dispatcher returns a finalized entry `entry`, the service executes a single parameterized update:
  ```sql
  UPDATE vps
  SET status = $1::jsonb,
      statusCheckedAt = CURRENT_TIMESTAMP
  WHERE id = $2
  RETURNING
    id,
    provider,
    name,
    credentialfilename    AS "credentialFileName",
    credentialfingerprint AS "credentialFingerprint",
    status,
    statuscheckedat       AS "statusCheckedAt",
    createdat             AS "createdAt",
    updatedat             AS "updatedAt"
  ```
  `status` is `JSON.stringify(entry)` (or `JSON.stringify(entry)::jsonb`). `statusCheckedAt` is set to the server's current time in the same statement (no two-step read-then-write). The returned row is the API response for single-refresh.
- **Precedence with local state** — the `LIMITED` status that PR #9 adds when `localActiveSessions > 0` for `codesandbox` / `codespaces` (one-session-per-token constraint via the partial unique indexes `idx_sessions_*_active_token`) is preserved in the persisted `status`. GCS never contributes a `LIMITED` candidate because its session rows lack a canonical fingerprint and the index does not exist.
- **Error handling** — any error thrown by `provider.getCredentialStatus` that the dispatcher would normally convert to a `buildUnknownEntry` is **persisted** as an `UNKNOWN` entry (with `details.errorCode` / `details.limitations`) and a fresh `statusCheckedAt`, rather than bubbling as a 500. Only truly unexpected errors (DB write failure, missing `vpsId` → 404 `VPS_NOT_FOUND`) surface as HTTP errors.
- **Concurrency** — bulk refresh fans out with the same `mapWithConcurrency(4)` helper used by `listCredentialStatuses` in PR #9. Each item's provider call is isolated; one credential's failure does not abort the batch.
- **Secrets** — at no point is `credentialContent`, `token`, or `privateKey` written into `status`, logs, or error responses. Log lines redact token-like runs (`/[A-Za-z0-9_\-]{20,}/ → [REDACTED]`) as the existing services already do.

---

### US-3: Single VPS status refresh endpoint

**As an** API consumer
**I want** to trigger a provider check for one VPS and get back the updated record
**So that** I can force a fresh availability read without polling every VPS

**Acceptance Criteria**:

- **Route**: `POST /api/v1/vps/:id/status/refresh`
  - Alternative name `POST /api/v1/vps/:id/check-status` is acceptable; pick one and document it. The `refresh` verb is used here because the operation has a side effect (DB write). `GET` is not appropriate — this is not idempotent in the HTTP sense when `force` is used (cache bypass may re-hit the provider).
  - Auth: requires the standard `x-server-token` / `Authorization: Bearer` header (same as all `/api/v1/vps` routes).
- **Behaviour**:
  - Looks up the VPS row by `id`. If not found → `404 Not Found`, code `VPS_NOT_FOUND`.
  - Calls `refreshVpsStatus(id, { force })`, where `force` is derived from query param `?force=true` (case-insensitive `true`/`false`, default `false`). When `force=true`, the in-memory status cache is bypassed for this check. When omitted or `false`, a cached non-`UNKNOWN` checker result may be reused.
  - Persists `status` + `statusCheckedAt` in a single `UPDATE` (US-2).
  - Returns `200 OK` with the updated VPS object (same shape as `GET /api/v1/vps/:id`, now including fresh `status`, `statusCheckedAt`, and current `sessionActive`):
    ```json
    {
      "id": "abc-123",
      "provider": "codesandbox",
      "name": "vm-manager123",
      "credentialFileName": "vm-manager123.json",
      "credentialFingerprint": "sha256:...",
      "status": {
        "provider": "codesandbox",
        "credential": "vm-manager123.json",
        "credentialFingerprint": "sha256:...",
        "status": "AVAILABLE",
        "checkedAt": "2026-09-03T10:15:00.000Z",
        "expiresAt": null,
        "quotas": [
          { "quotaUnit": "count", "quotaPeriod": "hourly-window", "usage": 10, "limit": 50, "remaining": 40, "resetAt": 1234567890 },
          { "quotaUnit": "count", "quotaPeriod": null, "usage": 2, "limit": 10, "remaining": 8 },
          { "quotaUnit": "credits", "quotaPeriod": "billing-cycle", "usage": null, "limit": null, "remaining": null }
        ],
        "details": {
          "validated": true,
          "limitations": [{ "field": "quotas[2].usage", "reason": "The CodeSandbox API does not expose credit balance. ..." }],
          "localActiveSessions": 0,
          "referencePricing": { "Nano": { "creditsPerHour": 10 } }
        }
      },
      "statusCheckedAt": "2026-09-03T10:15:00.000Z",
      "sessionActive": false,
      "createdAt": "2026-08-01T10:00:00Z",
      "updatedAt": "2026-08-01T10:00:00Z"
    }
    ```
- **Validation**:
  - `force` accepts only `true` / `false` (case-insensitive). Any other value → `400 Bad Request`, code `VPS_INVALID_PARAM`.
  - The `status` / `statusCheckedAt` fields in the request body, if present, are ignored (same as US-1).
- **Provider errors that map to `UNKNOWN`** still return `200` with `status.status === "UNKNOWN"` and a fresh `statusCheckedAt` (the check was performed, it just could not determine availability). Only missing-row and DB-write failures are non-200.
- **Keep-alive interaction** — the refresh does not start, stop, or reset keep-alive timers. Keep-alive state remains driven by `sessions` lifecycle, not by VPS status checks.

---

### US-4: Bulk VPS status refresh endpoint

**As a** system operator
**I want** to refresh the persisted status of all VPS (or all VPS for one provider) in a single call
**So that** I can reconcile the inventory after a billing cycle rollover or after rotating many credentials

**Acceptance Criteria**:

- **Route**: `POST /api/v1/vps/status/refresh`
  - Auth: same `x-server-token` / `Bearer` requirement.
  - Query parameters (all optional):
    | Parameter | Type | Default | Constraints |
    |:---|:---|:---|:---|
    | `provider` | string | — | Must be `gcs`, `codesandbox`, or `codespaces`; any other value → `400 VPS_INVALID_PARAM` |
    | `force` | boolean | `false` | `true`/`false` case-insensitive; controls cache bypass for every item in the batch (same semantics as US-3) |
  - When `provider` is supplied, only VPS rows with that provider are refreshed. When omitted, all VPS rows are refreshed.
  - The route selects the target `vps.id` set with a single `SELECT id FROM vps WHERE ($1::text IS NULL OR provider = $1)` before fanning out, so the batch is bounded to the filtered set at call time.
- **Behaviour**:
  - Fans out with `mapWithConcurrency(4)` (same limit as `listCredentialStatuses` in PR #9) to avoid provider rate-limit bursts. Each item calls the same single-refresh service (US-2) with the requested `force` flag.
  - Partial failures are tolerated: one VPS's provider returning `UNKNOWN` or throwing does not abort the batch. Each item's result is either a persisted `AVAILABLE`/`QUOTA_EXHAUSTED`/`LIMITED`/`INVALID` entry or an `UNKNOWN` entry, always with a fresh `statusCheckedAt`.
  - Response `200 OK`:
    ```json
    {
      "summary": {
        "total": 12,
        "succeeded": 10,
        "failed": 2
      },
      "results": [
        { "id": "abc-123", "provider": "codesandbox", "status": "AVAILABLE", "statusCheckedAt": "2026-09-03T10:20:00.000Z", "error": null },
        { "id": "def-456", "provider": "gcs", "status": "UNKNOWN", "statusCheckedAt": "2026-09-03T10:20:01.000Z", "error": { "code": "UNKNOWN_ERROR", "message": "Credential status could not be determined." } }
      ]
    }
    ```
    - `succeeded` counts items whose persisted `status.status !== "UNKNOWN"`; `failed` counts `UNKNOWN`. Both counts advance `statusCheckedAt` — the distinction is only for operator visibility.
    - `results` order matches the `SELECT id FROM vps WHERE … ORDER BY createdat DESC, id ASC` enumeration order, so callers can correlate with `GET /api/v1/vps`.
    - Each `results[]` element includes at minimum `id`, `provider`, persisted `status.status` (the top-level enum string), `statusCheckedAt`, and an `error` object (or `null`) when the underlying check produced `UNKNOWN`.
  - If the filtered set is empty (no VPS rows match), returns `200` with `{ summary: { total: 0, succeeded: 0, failed: 0 }, results: [] }`.
- **Performance**: bulk refresh completes with at most `ceil(N / 4)` concurrent upstream calls. The endpoint does not create VM sessions or run arbitrary commands. A large inventory (50+ VPS) completes within the existing pool `statement_timeout` (60 s) per row; the HTTP response timeout should be set generously (e.g., 120 s) or the route should stream progress if the inventory grows significantly — document the expected latency.

---

### US-5: Read path serves persisted status (no implicit provider calls)

**As an** API consumer
**I want** `GET /api/v1/vps` and `GET /api/v1/vps/:id` to return the persisted `status` and `statusCheckedAt` without re-hitting any provider API
**So that** inventory views stay cheap and the only way to incur a provider call is an explicit refresh (US-3/US-4)

**Acceptance Criteria**:

- `GET /api/v1/vps` (list) and `GET /api/v1/vps/:id` (detail) return `status` and `statusCheckedAt` directly from the `vps` row, with no provider API call and no status-cache lookup. The existing `sessionActive` correlated sub-query (`EXISTS (SELECT 1 FROM sessions …)`) continues to be computed in the same SQL statement — no N+1 lookups.
- The response shape for list and detail is additive only (two new fields on every VPS object). Callers that do not request `status`/`statusCheckedAt` still receive them (as `null` when never refreshed). No existing field is renamed or removed.
- `GET /api/v1/vps` pagination, sorting, and filtering (LAB-011: `provider`, `sessionActive`, `limit`/`offset`, `sortBy`/`sortOrder`) are unchanged. `statusCheckedAt` is **not** added to `sortBy` in this ticket — sorting by freshness is a future enhancement that requires explicit `NULLS LAST` handling (most rows start as `NULL`). `sortBy=status` remains unsupported because `status` is JSONB. `sortBy=statusCheckedAt` may be added in a follow-up once the column's null-heavy initial distribution is considered.
- Filtering by `status` (e.g., `?status=AVAILABLE`) is **not** added in this ticket — `status` is JSONB and filtering requires `status->>'status'` path queries with a GIN index. A future ticket may add `?status=AVAILABLE` once the team agrees on the JSON path and indexing strategy.
- `POST /api/v1/vps` (create) leaves `status = NULL` and `statusCheckedAt = NULL` on the newly inserted row. An initial refresh is not performed automatically — the caller triggers it with `POST /:id/status/refresh` when they need it. A fire-and-forget background refresh after creation is explicitly out of scope (it would add latency and error-handling complexity to the create path).

---

## Non-Functional Requirements

### NFR-1: No N+1 queries

- `sessionActive` remains a single correlated `EXISTS` sub-query in the list/detail SELECTs (LAB-011 pattern). No per-row session lookups in application code.
- `status` and `statusCheckedAt` are plain columns on the same `vps` row — no join required.
- Bulk refresh performs one `UPDATE … WHERE id = $n` per VPS row (the minimal write set) plus the provider check's own reads. No extra `SELECT` per row beyond the initial `SELECT id FROM vps …` enumeration.

### NFR-2: No breaking changes

- Existing VPS fields (`id`, `provider`, `name`, `credentialFileName`, `credentialFingerprint`, `createdAt`, `updatedAt`, `sessionActive`) are unchanged in name, type, or casing.
- The only additive changes are the two new fields (`status`, `statusCheckedAt`) and the two new POST refresh routes. The list envelope (`{ vps, total, limit, offset }`) and single-object shape are otherwise identical.
- Callers that never call the refresh endpoints see `status: null, statusCheckedAt: null` — a safe default that matches LAB-011's current behaviour.

### NFR-3: Input sanitisation

- `provider` query param on bulk refresh is validated against an allowlist (`gcs`, `codesandbox`, `codespaces`) before interpolation — no dynamic string concatenation of unvalidated input into SQL.
- `force` is validated as strict `true`/`false` (case-insensitive). Any other value → `400 VPS_INVALID_PARAM`.
- `VPS_SAFE_COLUMNS` continues to exclude `credentialcontent` — it is never selected in any API-facing query, including the refresh path (which reads it only as an internal step to build `loadedCredential`).

### NFR-4: Secrets hygiene

- `credentialContent` / `token` / `privateKey` never appear in API responses, `status` JSON, logs, or error messages. The existing `redactTokensFromMessage` helper and `buildUnknownEntry` stable message ("Credential status could not be determined.") are reused.
- `status` persists only the normalized dispatcher output, which already excludes raw credentials. `credentialFingerprint` (`sha256:<hex>`) is safe to persist and return.

### NFR-5: Resilience to partial failures

- Single refresh: provider-side failures map to `UNKNOWN` and are persisted with a fresh `statusCheckedAt`; they do not surface as 500.
- Bulk refresh: one failing credential does not abort the batch. The summary distinguishes `succeeded` vs `failed` (`UNKNOWN`) and every item gets a fresh timestamp.

### NFR-6: Cache discipline

- The in-memory `status-cache.js` TTL (`CREDENTIAL_STATUS_CACHE_TTL_MS`, default 5 min) and rules from PR #9 are preserved: only non-`UNKNOWN` checker results are cached; `LIMITED` is never cached; concurrent checks for the same `provider:fingerprint` share one in-flight promise.
- Refresh endpoints bypass the cache only when `?force=true`. Otherwise they benefit from the cache, keeping bulk refresh of many VPS that share no fingerprints (the common case after LAB-010's fingerprint uniqueness per provider) at one upstream call per VPS at most.

---

## API Changes

### `GET /api/v1/vps` (modified — read path)

No new query parameters in this ticket. Response gains two fields per VPS element:

```json
{
  "vps": [
    {
      "id": "string",
      "provider": "string",
      "name": "string",
      "credentialFileName": "string",
      "credentialFingerprint": "string",
      "status": "object | null",
      "statusCheckedAt": "ISO 8601 string | null",
      "sessionActive": true,
      "createdAt": "ISO 8601",
      "updatedAt": "ISO 8601"
    }
  ],
  "total": 87,
  "limit": 20,
  "offset": 0
}
```

`status` is the full normalized entry (or `null`). `statusCheckedAt` is an ISO 8601 timestamp (or `null`). Both are read directly from the row.

### `GET /api/v1/vps/:id` (modified — read path)

No new query parameters. Response gains the same two fields:

```json
{
  "id": "string",
  "provider": "string",
  "name": "string",
  "credentialFileName": "string",
  "credentialFingerprint": "string",
  "status": "object | null",
  "statusCheckedAt": "ISO 8601 string | null",
  "sessionActive": false,
  "createdAt": "ISO 8601",
  "updatedAt": "ISO 8601"
}
```

### `POST /api/v1/vps/:id/status/refresh` (new — single refresh)

| Property | Value |
|:---|:---|
| Auth | `x-server-token` / `Authorization: Bearer` |
| Query | `force` (optional): `true`/`false` case-insensitive, default `false` |
| Body | none (any body field is ignored; `status`/`statusCheckedAt` in body are silently dropped) |

**Response `200 OK`** — updated VPS object (same shape as `GET /:id`, with fresh `status` + `statusCheckedAt`).

**Response `404 Not Found`** — code `VPS_NOT_FOUND` when `id` does not exist.

**Response `400 Bad Request`** — code `VPS_INVALID_PARAM` when `force` has an invalid value.

Provider-side failures that map to `UNKNOWN` still return `200` with `status.status === "UNKNOWN"` and a fresh `statusCheckedAt`.

### `POST /api/v1/vps/status/refresh` (new — bulk refresh)

| Property | Value |
|:---|:---|
| Auth | `x-server-token` / `Authorization: Bearer` |
| Query | `provider` (optional): `gcs`/`codesandbox`/`codespaces`; `force` (optional): `true`/`false` default `false` |

**Response `200 OK`**:

```json
{
  "summary": { "total": 12, "succeeded": 10, "failed": 2 },
  "results": [
    { "id": "string", "provider": "string", "status": "AVAILABLE", "statusCheckedAt": "ISO 8601", "error": null },
    { "id": "string", "provider": "string", "status": "UNKNOWN", "statusCheckedAt": "ISO 8601", "error": { "code": "UNKNOWN_ERROR", "message": "Credential status could not be determined." } }
  ]
}
```

`status` in each `results[]` element is the top-level enum string from the persisted entry (`AVAILABLE` / `QUOTA_EXHAUSTED` / `LIMITED` / `INVALID` / `UNKNOWN` etc.). `failed` counts `UNKNOWN` entries.

**Response `400 Bad Request`** — code `VPS_INVALID_PARAM` for invalid `provider` or `force`.

**Response `200` with `total: 0`** — when the filter matches no rows.

> **Route ordering note**: `POST /api/v1/vps/status/refresh` must be registered **before** `POST /api/v1/vps/:id/status/refresh` (and before `GET /:id`) in the Express router, otherwise `status` would be captured as `:id`. The same ordering concern already exists for `GET /` vs `GET /:id` and the LAB-011 pagination routes.

---

## Data Model Changes

### `vps` table — new column

```sql
ALTER TABLE vps ADD COLUMN statusCheckedAt TIMESTAMP WITH TIME ZONE DEFAULT NULL;
```

Executed via `ensureColumn('vps', 'statusCheckedAt', 'ALTER TABLE vps ADD COLUMN statusCheckedAt TIMESTAMP WITH TIME ZONE DEFAULT NULL')` in `src/db/db.js`, immediately after the existing `ensureColumn('vps', 'status', ...)` call. `statusCheckedAt` is intentionally `TIMESTAMP WITH TIME ZONE` (not `TEXT`) so it supports native range queries and `ORDER BY` in the future.

The existing `status` column (LAB-011) is not re-declared here:

```sql
-- Already present from LAB-011:
-- ALTER TABLE vps ADD COLUMN status JSONB DEFAULT NULL;
```

Optional follow-up index (not in this ticket, but worth noting): `CREATE INDEX IF NOT EXISTS idx_vps_status_checked_at ON vps (statusCheckedAt DESC)` if future `sortBy=statusCheckedAt` or staleness queries (`WHERE statusCheckedAt < NOW() - INTERVAL '1 hour'`) become common.

### Column summary after this story

| Column | Type | Nullable | Default | Written by |
|:---|:---|:---:|:---|:---|
| `id` | `TEXT PRIMARY KEY` | no | — | `POST /api/v1/vps` |
| `provider` | `TEXT NOT NULL` | no | — | `POST /api/v1/vps` |
| `name` | `TEXT NOT NULL` | no | — | `POST /api/v1/vps` |
| `credentialFileName` | `TEXT NOT NULL` | no | — | `POST` / `PUT` |
| `credentialContent` | `TEXT NOT NULL` | no | — | `POST` / `PUT` |
| `credentialFingerprint` | `TEXT NOT NULL` | no | — | `POST` / `PUT` (via `validateAndFingerprintContent`) |
| `status` | `JSONB` | yes | `NULL` | `POST /:id/status/refresh`, `POST /status/refresh` |
| `statusCheckedAt` | `TIMESTAMP WITH TIME ZONE` | yes | `NULL` | `POST /:id/status/refresh`, `POST /status/refresh` |
| `createdAt` | `TIMESTAMP WITH TIME ZONE` | no | `CURRENT_TIMESTAMP` | DB default |
| `updatedAt` | `TIMESTAMP WITH TIME ZONE` | no | `CURRENT_TIMESTAMP` | `PUT /:id` |

---

## SQL Reference

### VPS read query (illustrative — exact parameterisation in implementation)

Extends the LAB-011 list query with `statusCheckedAt`:

```sql
SELECT
  v.id,
  v.provider,
  v.name,
  v.credentialfilename    AS "credentialFileName",
  v.credentialfingerprint AS "credentialFingerprint",
  v.status,
  v.statuscheckedat       AS "statusCheckedAt",
  v.createdat             AS "createdAt",
  v.updatedat             AS "updatedAt",
  EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.credentialfingerprint = v.credentialfingerprint
      AND s.provider              = v.provider
      AND COALESCE(s.status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED')
  ) AS "sessionActive"
FROM vps v
WHERE
  (v.provider = $1 OR $1 IS NULL)
  AND (
    $2 IS NULL
    OR ($2 = TRUE  AND EXISTS (SELECT 1 FROM sessions s WHERE s.credentialfingerprint = v.credentialfingerprint AND s.provider = v.provider AND COALESCE(s.status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED')))
    OR ($2 = FALSE AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.credentialfingerprint = v.credentialfingerprint AND s.provider = v.provider AND COALESCE(s.status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED')))
  )
ORDER BY v.createdat DESC, v.id ASC
LIMIT $3 OFFSET $4;
```

`NULLS LAST` is not required for `statusCheckedAt` in this ticket because the column is excluded from `sortBy`. When `sortBy=statusCheckedAt` is added in the future, use `ORDER BY v.statuscheckedat DESC NULLS LAST, v.id ASC`.

### Single refresh — persist

```sql
UPDATE vps
SET status            = $1::jsonb,
    statusCheckedAt   = CURRENT_TIMESTAMP
WHERE id = $2
RETURNING
  v.id,
  v.provider,
  v.name,
  v.credentialfilename    AS "credentialFileName",
  v.credentialfingerprint AS "credentialFingerprint",
  v.status,
  v.statuscheckedat       AS "statusCheckedAt",
  v.createdat             AS "createdAt",
  v.updatedat             AS "updatedAt",
  EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.credentialfingerprint = v.credentialfingerprint
      AND s.provider              = v.provider
      AND COALESCE(s.status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED')
  ) AS "sessionActive";
```

`$1` is `JSON.stringify(entry)` where `entry` is the dispatcher-finalized normalized status entry (including `checkedAt`, `quotas`, `details`). `$2` is the `vps.id`. The `RETURNING` clause avoids a second `SELECT`.

### Bulk refresh — enumeration

```sql
SELECT id FROM vps
WHERE ($1::text IS NULL OR provider = $1)
ORDER BY createdat DESC, id ASC;
```

`$1` is the optional `provider` filter (or `NULL` for all). Each enumerated `id` is then refreshed via the single-refresh statement above with concurrency 4.

---

## Affected Files

| File | Change |
|:---|:---|
| `src/db/db.js` | Add `ensureColumn('vps', 'statusCheckedAt', ...)` migration call after the existing `status` column migration |
| `src/services/vps-status-service.js` | **New** — `refreshVpsStatus` / `refreshAllVpsStatuses` service (or extend `src/services/credential-status-service.js` with the same two functions; either location is acceptable — document the choice) |
| `src/services/credential-status-service.js` | **Reuse** — single and bulk refresh call through the existing `getCredentialStatus` dispatcher and `status-cache.js` (`force` bypasses `getOrCheckStatus` when true); no change to the normalized entry shape or per-provider `getCredentialStatus` implementations |
| `src/services/providers/base-provider.js` | No change — `getCredentialStatus` hook from PR #9 is reused as-is |
| `src/services/providers/gcs-provider.js` | No change — `getCredentialStatus` from PR #9 is reused |
| `src/services/providers/codesandbox-provider.js` | No change — `getCredentialStatus` from PR #9 is reused |
| `src/services/providers/codespaces-provider.js` | No change — `getCredentialStatus` from PR #9 is reused |
| `src/services/db-credentials-loader.js` | **Reuse** — single-refresh resolves the row's credential via the DB-first loader path (or direct `credentialContent` parsing) to build `loadedCredential` for the provider checker |
| `src/routes/vps.js` | Extend `VPS_SAFE_COLUMNS` to include `v.statuscheckedat AS "statusCheckedAt"`; register `POST /status/refresh` (bulk) and `POST /:id/status/refresh` (single) handlers; keep existing list/detail/create/update/delete handlers serving the persisted values |
| `src/services/status-cache.js` | No change — `force` refresh bypasses `getOrCheckStatus` at the call site; cache implementation is untouched |

> **No new provider-specific code** is required. The entire `hours` / `core-hours` / `credits` / `count` quota model, the `referencePricing` / `referenceLimits` details, and the `UNKNOWN` mapping for missing billing permissions are all inherited from PR #9 unchanged.

---

## Error Codes

| Code | HTTP | Description |
|:---|:---:|:---|
| `VPS_NOT_FOUND` | 404 | No `vps` row matches the given `id` (single refresh) |
| `VPS_INVALID_PARAM` | 400 | `provider` or `force` query param has an invalid value (bulk or single refresh) |

Existing codes (`VPS_ALREADY_EXISTS`, `VPS_DUPLICATE_TOKEN`, `VPS_IN_USE`, `VPS_CONTENT_INVALID`, `VPS_NAME_INVALID`, `VPS_INVALID_PROVIDER`) are unchanged. Provider-side credential errors (`CODESPACES_TOKEN_INVALID`, `CODESANDBOX_CREDENTIALS_MISSING`, etc.) are mapped to `UNKNOWN` entries inside the persisted `status` and do not surface as HTTP error codes on the refresh endpoints — only missing-row and bad-param cases are HTTP errors.

---

## Out of Scope

- Writing `status` / `statusCheckedAt` via `POST /api/v1/vps` or `PUT /api/v1/vps/:id` (reserved for the refresh path; client-supplied values are ignored).
- Sorting by `statusCheckedAt` (`sortBy=statusCheckedAt`) — deferred until the null-heavy initial distribution is considered and `NULLS LAST` handling is added.
- Filtering by `status` (e.g., `?status=AVAILABLE`) — requires `status->>'status'` path queries and a GIN index; deferred to a follow-up once the JSON shape is considered stable.
- `sortBy=status` — still unsupported; `status` is JSONB and has no meaningful total order (same as LAB-011).
- Automatic background polling / cron that keeps `status` fresh without an explicit API call. The only writer in this ticket is the on-demand refresh endpoints; a scheduled reconciler is a future enhancement.
- Encrypting `credentialContent` at rest, rotating credentials, or expiring `status` entries (future tickets).
- Changing the LAB-009 `checkedAt` field inside the persisted JSON (it remains the checker's own timestamp) — `statusCheckedAt` is the DB-level timestamp that mirrors it for cheap SQL access; the two values will be equal at write time but diverge if the JSON is ever re-written without a fresh check (which this spec does not do).
- Creating or deleting VPS rows as part of a status check — refresh is read-only with respect to the VPS inventory (one `UPDATE` per row, no inserts/deletes).

---

## Relationship to LAB-009 (PR #9) and LAB-011

| Concern | LAB-009 (PR #9) | LAB-011 | LAB-012 (this story) |
|:---|:---|:---|:---|
| Normalized status contract | Introduces it (`provider.getCredentialStatus` + dispatcher + `quotas[]` + `status` enum) | — | Reuses it unchanged |
| `vps.status` column | — | Adds `status JSONB DEFAULT NULL` + exposes it in reads | Writes it (check → persist) |
| `vps.statusCheckedAt` column | — | — | Adds it + exposes it in reads |
| Provider check | On every API call (with short in-memory cache) | No check | On explicit `POST …/refresh` only |
| List read cost | Fan-out to every provider | Single DB query | Single DB query (unchanged) |
| Freshness signal | `entry.checkedAt` inside JSON (transient) | `status = null` (never checked) | `status` + `statusCheckedAt` (durable, sortable in future) |
