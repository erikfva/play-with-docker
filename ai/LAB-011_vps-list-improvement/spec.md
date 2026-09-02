# LAB-011: VPS List Endpoint — Sorting, Pagination, and Session Activity Status

**Issue Type**: Improvement
**Priority**: Medium
**Component**: VPS Management API, Routes
**Labels**: api, pagination, sorting, vps
**Epic**: Multi-Provider VM Orchestration

---

## Summary

Enhance the `GET /api/v1/vps` list endpoint with:
1. **Sorting** — allow callers to control field and direction.
2. **Pagination** — cursor-free offset/limit page controls with total count in the response envelope.
3. **Session activity field** — a calculated `sessionActive` boolean per VPS row that reflects whether the credential currently has a non-terminal session running on any provider.
4. **VPS `status` field** — a persisted `status` column on the `vps` table that carries the availability/quota information produced by the LAB-009 credential-status feature (PR #9), so consumers can surface provider-level availability alongside session-level activity in a single call.
5. **Filtering** — allow callers to filter records by `provider` and by `sessionActive` state.

---

## Background

The `GET /api/v1/vps` endpoint introduced in LAB-010 returns all registered VPS records with a fixed `ORDER BY createdat DESC`. As the VPS inventory grows, clients need:

- **Pagination** to avoid loading the full table on every request.
- **Sorting** by name, provider, creation date, or last-updated date to match different UI requirements.
- **Session activity** (`ON`/`OFF`) as a quick signal showing whether a credential is already being consumed by an active session, so operators can tell at a glance which VPS are idle and which are in use.
- **Filtering** by `provider` (already partially present) and by `sessionActive` state, so clients can fetch only idle VPS or only VPS with running sessions in a single request.
- **Provider status** as a persisted field so the credential-status information fetched in LAB-009 (quota headroom, availability state) can be stored once and read cheaply by list clients without an extra round-trip.

---

## User Stories

### US-1: Paginated VPS List

**As an** API consumer  
**I want** to retrieve a page of VPS records using `limit` and `offset` query parameters  
**So that** I can build paginated UIs or scripts without loading every record at once

**Acceptance Criteria**:
- `GET /api/v1/vps?limit=20&offset=40` returns records 41–60.
- `limit` must be an integer in the range `[1, 100]`. Default: `20`. Values outside the range return `400 Bad Request`, code `VPS_INVALID_PARAM`.
- `offset` must be a non-negative integer. Default: `0`. Negative values return `400 Bad Request`, code `VPS_INVALID_PARAM`.
- The response envelope includes a `total` field with the count of all matching rows (after applying all active filters — `provider`, `sessionActive` — but before applying `limit`/`offset`).

**Response shape**:
```json
{
  "vps": [ { ... } ],
  "total": 87,
  "limit": 20,
  "offset": 40
}
```

---

### US-2: Sortable VPS List

**As an** API consumer  
**I want** to control the sort field and direction of the VPS list  
**So that** I can present records ordered by name, recency, or provider without client-side sorting

**Acceptance Criteria**:
- Supported `sortBy` values: `name`, `provider`, `createdAt`, `updatedAt`. Default: `createdAt`.
- Supported `sortOrder` values: `asc`, `desc`. Default: `desc`.
- Unknown `sortBy` or `sortOrder` values return `400 Bad Request`, code `VPS_INVALID_PARAM`.
- Sort is applied before pagination. Combined example: `GET /api/v1/vps?sortBy=name&sortOrder=asc&limit=10&offset=0`.
- Sort field names in the query are **case-insensitive** (`CREATEDAT`, `createdat`, and `createdAt` are equivalent).
- The `sortBy` field is mapped to the actual database column internally (e.g., `createdAt` → `createdat`, `updatedAt` → `updatedat`). This mapping is encapsulated in the route handler and not exposed to the caller.
- `status` is intentionally **excluded** from `sortBy` because the column is `JSONB` — sorting by an entire JSON object is undefined in PostgreSQL. A future ticket may add `sortBy=status.<field>` once the LAB-009 status shape is stabilised.

---

### US-3: Session Activity Field (`sessionActive`)

**As an** API consumer  
**I want** each VPS record in the list to include a `sessionActive` boolean  
**So that** I can tell at a glance whether a credential is currently consumed by a running session

**Acceptance Criteria**:
- Each VPS object in the response includes `"sessionActive": true | false`.
- `sessionActive` is `true` when at least one row exists in the `sessions` table matching:
  - `credentialfingerprint = vps.credentialfingerprint`
  - `provider = vps.provider`
  - `COALESCE(status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED')`
- `sessionActive` is `false` otherwise (no matching session, or only terminal sessions).
- The value is computed in the database layer with a single correlated sub-query or `LEFT JOIN` — **no** N+1 application-level lookups.
- `GET /api/v1/vps/:id` also returns `sessionActive` on the single-record response.

**Example** — VPS with a running session:
```json
{
  "id": "abc-123",
  "provider": "codespaces",
  "name": "vm-manager232",
  "credentialFileName": "vm-manager232.json",
  "credentialFingerprint": "sha256:...",
  "status": null,
  "sessionActive": true,
  "createdAt": "2026-08-01T10:00:00Z",
  "updatedAt": "2026-08-01T10:00:00Z"
}
```

**Example** — VPS with no active session:
```json
{
  "id": "def-456",
  "provider": "gcs",
  "name": "gcs-primary",
  "credentialFileName": "gcs-primary.json",
  "credentialFingerprint": "sha256:...",
  "status": null,
  "sessionActive": false,
  "createdAt": "2026-07-15T08:00:00Z",
  "updatedAt": "2026-07-15T08:00:00Z"
}
```

---

### US-4: VPS `status` Column

**As a** system operator  
**I want** the VPS record to carry a `status` field that reflects provider-level availability information  
**So that** the LAB-009 credential-status feature can persist quota/availability state in one place and list consumers can read it without an extra API round-trip

**Acceptance Criteria**:
- A new `status` column is added to the `vps` table via `ensureColumn` migration, so the schema change is safe to deploy against an existing database.
- Column definition: `status JSONB DEFAULT NULL`. Absence of a status value is represented as `null` (not written until LAB-009 populates it). Using JSONB allows future queries on individual fields (e.g., `WHERE status->>'availability' = 'available'`) and indexing on specific paths without a schema change.
- `status` is included in `VPS_SAFE_COLUMNS` and returned in all read responses (`GET /api/v1/vps`, `GET /api/v1/vps/:id`). The value is serialised as a JSON object (or `null`) in the response body.
- `status` is **not** writable through `POST /api/v1/vps` or `PUT /api/v1/vps/:id` in this ticket — it is reserved for internal update by the credential-status subsystem (LAB-009). Callers who include `status` in a create/update request body have the field silently ignored.
- `sortBy=status` is **not supported** — JSONB columns are not directly sortable by PostgreSQL. Sorting by a specific status path (e.g., `status->>'availability'`) may be added in a future ticket once the LAB-009 shape is finalised.

**Schema addition**:
```sql
ALTER TABLE vps ADD COLUMN status JSONB DEFAULT NULL;
```

---

### US-5: Filter VPS List by Provider and Session Activity

**As an** API consumer  
**I want** to filter the VPS list by `provider` and by `sessionActive` state  
**So that** I can retrieve only idle VPS or only VPS currently in use without client-side filtering

**Acceptance Criteria**:

**`provider` filter** (already exists; behaviour clarified here):
- `GET /api/v1/vps?provider=codespaces` returns only VPS records whose `provider` column equals `codespaces`.
- Accepted values: `gcs`, `codesandbox`, `codespaces`. Any other value returns `400 Bad Request`, code `VPS_INVALID_PARAM`.
- Combining with other filters is supported: `GET /api/v1/vps?provider=gcs&sessionActive=false`.

**`sessionActive` filter** (new):
- `GET /api/v1/vps?sessionActive=true` returns only VPS records where at least one non-terminal session matches the VPS credential.
- `GET /api/v1/vps?sessionActive=false` returns only VPS records with no matching non-terminal session.
- Omitting `sessionActive` (default) returns all records regardless of session state.
- Accepted values: `true`, `false` (case-insensitive: `True`, `TRUE`, `False`, `FALSE` are also valid). Any other value returns `400 Bad Request`, code `VPS_INVALID_PARAM`.
- The filter is applied in the SQL query — **not** by post-processing the full result set in application code.
- `total` in the pagination envelope reflects the filtered count (i.e., the number of rows matching all active filters before `limit`/`offset`).

**Combined example**:
```
GET /api/v1/vps?provider=codespaces&sessionActive=false&sortBy=name&sortOrder=asc&limit=10&offset=0
```
Returns the first 10 Codespaces VPS that currently have no active session, sorted A→Z by name.

---

## Non-Functional Requirements

### NFR-1: No N+1 Queries
`sessionActive` must be computed in a single SQL statement using a correlated sub-query or `EXISTS` clause. Application-level per-row session lookups are not acceptable.

### NFR-2: No Breaking Changes
- Existing response fields are unchanged.
- The only shape change is the addition of `sessionActive`, `status`, and the pagination envelope (`total`, `limit`, `offset`) to the list response. The `GET /api/v1/vps/:id` single-record response gains `sessionActive` and `status`.
- Callers that do not pass `limit`/`offset`/`sortBy`/`sortOrder` receive the same records they received before, now wrapped in the pagination envelope.

### NFR-3: Input Sanitisation
`sortBy` and `sortOrder` values are validated against an explicit allowlist before being interpolated into the SQL query — **no dynamic string concatenation** of unvalidated user input into queries.

### NFR-4: Consistent Casing
All camelCase field names in responses (e.g., `sessionActive`, `credentialFingerprint`, `createdAt`) are produced via SQL `AS` aliases, consistent with the existing `VPS_SAFE_COLUMNS` pattern in `src/routes/vps.js`.

---

## API Changes

### `GET /api/v1/vps`

**Query parameters** (all optional):

| Parameter | Type | Default | Constraints |
|:---|:---|:---|:---|
| `provider` | string | — | Must be `gcs`, `codesandbox`, or `codespaces` |
| `sessionActive` | boolean | — | `true` or `false` (case-insensitive); omit for no filter |
| `limit` | integer | `20` | `1`–`100` |
| `offset` | integer | `0` | `>= 0` |
| `sortBy` | string | `createdAt` | `name`, `provider`, `createdAt`, `updatedAt` |
| `sortOrder` | string | `desc` | `asc`, `desc` |

**Response `200 OK`**:
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

### `GET /api/v1/vps/:id`

No new query parameters. Response gains `status` and `sessionActive`:

```json
{
  "id": "string",
  "provider": "string",
  "name": "string",
  "credentialFileName": "string",
  "credentialFingerprint": "string",
  "status": "string | null",
  "sessionActive": false,
  "createdAt": "ISO 8601",
  "updatedAt": "ISO 8601"
}
```

---

## Data Model Changes

### `vps` table — new column

```sql
ALTER TABLE vps ADD COLUMN status JSONB DEFAULT NULL;
```

Added via `ensureColumn('vps', 'status', 'ALTER TABLE vps ADD COLUMN status JSONB DEFAULT NULL')` in `src/db/db.js`, consistent with the incremental migration pattern already used in the project. Using `JSONB` rather than `TEXT` allows PostgreSQL to validate JSON structure on write, supports `->>`/`@>` operators for future filtering, and enables GIN indexing on specific paths without a schema change.

---

## SQL Reference

### VPS list query (illustrative — exact parameterisation in implementation)

> **`NULLS LAST` requirement:** Not applicable for `status` — the column is `JSONB` and is excluded from `sortBy`. For the remaining sortable columns (`name`, `provider`, `createdAt`, `updatedAt`), none are nullable, so PostgreSQL's default `NULLS LAST` for `ASC` and `NULLS FIRST` for `DESC` is acceptable. No explicit `NULLS LAST` clause is required.
>
> **Tiebreaker:** Append `, v.id ASC` as a secondary sort to guarantee stable, deterministic page boundaries when multiple rows share the same primary sort value (e.g., identical `createdAt` timestamps).

```sql
SELECT
  v.id,
  v.provider,
  v.name,
  v.credentialfilename    AS "credentialFileName",
  v.credentialfingerprint AS "credentialFingerprint",
  v.status,
  v.createdat             AS "createdAt",
  v.updatedat             AS "updatedAt",
  EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.credentialfingerprint = v.credentialfingerprint
      AND s.provider = v.provider
      AND COALESCE(s.status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED')
  ) AS "sessionActive"
FROM vps v
WHERE
  (v.provider = $1 OR $1 IS NULL)             -- only if ?provider= filter is set
  AND (
    $2 IS NULL                                 -- no ?sessionActive= filter
    OR (
      $2 = TRUE AND EXISTS (                   -- ?sessionActive=true
        SELECT 1 FROM sessions s
        WHERE s.credentialfingerprint = v.credentialfingerprint
          AND s.provider = v.provider
          AND COALESCE(s.status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED')
      )
    )
    OR (
      $2 = FALSE AND NOT EXISTS (              -- ?sessionActive=false
        SELECT 1 FROM sessions s
        WHERE s.credentialfingerprint = v.credentialfingerprint
          AND s.provider = v.provider
          AND COALESCE(s.status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED')
      )
    )
  )
ORDER BY v.createdat DESC, v.id ASC  -- sortCol/sortDir from allowlist; v.id ASC tiebreaker
LIMIT $3 OFFSET $4;
```

Total count query (same WHERE clause, runs before the paginated query):
```sql
SELECT COUNT(*)
FROM vps v
WHERE
  (v.provider = $1 OR $1 IS NULL)
  AND (
    $2 IS NULL
    OR ($2 = TRUE  AND EXISTS (SELECT 1 FROM sessions s WHERE s.credentialfingerprint = v.credentialfingerprint AND s.provider = v.provider AND COALESCE(s.status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED')))
    OR ($2 = FALSE AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.credentialfingerprint = v.credentialfingerprint AND s.provider = v.provider AND COALESCE(s.status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED')))
  );
```

---

## Affected Files

| File | Change |
|:---|:---|
| `src/db/db.js` | Add `ensureColumn('vps', 'status', ...)` migration call |
| `src/routes/vps.js` | Update `VPS_SAFE_COLUMNS`, add pagination/sort query handling, add `sessionActive` sub-query, update `GET /` and `GET /:id` handlers |

---

## Error Codes (additions)

| Code | HTTP | Description |
|:---|:---:|:---|
| `VPS_INVALID_PARAM` | 400 | `limit`, `offset`, `sortBy`, `sortOrder`, `provider`, or `sessionActive` has an invalid value |

---

## Out of Scope

- Writing `status` via the VPS CRUD API (reserved for LAB-009 credential-status subsystem).
- Cursor-based or keyset pagination (offset/limit is sufficient for this inventory size).
- Real-time push updates when `sessionActive` changes.
