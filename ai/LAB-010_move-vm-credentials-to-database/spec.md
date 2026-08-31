# LAB-010: Move VM Credentials to Database

**Issue Type**: Improvement  
**Priority**: High  
**Component**: Credential Management, Database, Provider System  
**Labels**: credentials, database, refactor, security  
**Epic**: Multi-Provider VM Orchestration  

---

## Summary

Introduce a `vps` table that stores provider credential records directly in PostgreSQL. This replaces the current filesystem/S3 credential loading mechanism at request time. Credential files are registered once (via a new CRUD API) and thereafter resolved by name from the database, eliminating the dependency on `S3_MOUNT_DIR`, `S3FS_ENABLED`, and S3 SDK calls during session operations.

---

## Background

Currently, every session create/command/refresh request must resolve a `credentialRef` string (a filename, S3 key, or `s3://` URL) into actual token bytes by reading from the local filesystem, an s3fs FUSE mount, or the AWS S3 API. This introduces three separate resolution paths (`local`, `s3fs`, `s3-api`) whose behaviour differs depending on environment variables, and it couples the runtime API to external storage infrastructure that may not be available (e.g., Render does not support FUSE mounts).

The credential files already live in local `credentials/` directories alongside the project and are loaded into a per-process in-memory cache today. Persisting them in the database moves the single source of truth to PostgreSQL, which is already the persistence layer, and makes all three storage modes optional for runtime credential access.

---

## Business Value

- **Simplified operations**: Credential files no longer need to be present on disk or in S3 at request time; they are seeded once into the database.
- **Consistent behaviour across deploy targets**: Render, Docker, and local development all use the same database-backed resolution path.
- **Auditable credential inventory**: All registered credentials are queryable, with fingerprints for uniqueness checks, without scanning buckets or directories.
- **Reduced attack surface**: Credential content is confined to the database rather than passed around as file paths through multiple resolution layers.
- **Foundation for rotation**: A future rotation workflow can update a single row rather than replacing files in S3 or mounted volumes.

---

## Functional Requirements

### FR-1: `vps` Table
**As a** system operator  
**I want** a dedicated database table to store VM credential records  
**So that** credentials are managed centrally and independently of storage infrastructure

**Acceptance Criteria**:
- Table `vps` is created automatically during schema bootstrap in `src/db/db.js`.
- Schema columns:

  | Column | Type | Notes |
  |---|---|---|
  | `id` | `TEXT PRIMARY KEY` | UUID v4 generated on insert |
  | `provider` | `TEXT NOT NULL` | One of `gcs`, `codesandbox`, `codespaces` |
  | `name` | `TEXT NOT NULL` | Human-readable label, e.g. `vm-manager232` |
  | `credentialFileName` | `TEXT NOT NULL` | Original filename, e.g. `vm-manager232.json` |
  | `credentialContent` | `TEXT NOT NULL` | Full file content (JSON string or plain-text PAT) |
  | `credentialFingerprint` | `TEXT NOT NULL` | `sha256:<hex>` of the extracted token/key material |
  | `createdAt` | `TIMESTAMP WITH TIME ZONE` | Default `CURRENT_TIMESTAMP` |
  | `updatedAt` | `TIMESTAMP WITH TIME ZONE` | Updated on every write |

- A unique index enforces `(provider, name)` — one record per provider + name combination.
- A unique index enforces `(provider, credentialFingerprint)` — no duplicate token content per provider.
- `credentialContent` is stored as-is (the raw bytes of the file) so both JSON and plain-text formats are supported without re-encoding.

---

### FR-2: VPS Management API
**As a** system operator  
**I want** REST endpoints to register, list, retrieve, update, and delete VPS records  
**So that** I can manage the VPS inventory without direct database access

All endpoints require the standard `x-server-token` / `Authorization: Bearer` header.

#### `POST /api/v1/vps`

Register a new VPS record.

**Request body**:
```json
{
  "provider": "codespaces",
  "name": "vm-manager232",
  "credentialFileName": "vm-manager232.json",
  "credentialContent": "{\"token\":\"ghp_...\"}"
}
```

- `provider`: required. Must be one of `gcs`, `codesandbox`, `codespaces`.
- `name`: required. Must be unique per provider. Validated: non-empty, no path separators.
- `credentialFileName`: required. Original filename for reference; not used for resolution.
- `credentialContent`: required. Raw file content. Validated per provider (see FR-3).

**Response `201 Created`**:
```json
{
  "id": "<uuid>",
  "provider": "codespaces",
  "name": "vm-manager232",
  "credentialFileName": "vm-manager232.json",
  "credentialFingerprint": "sha256:<hex>",
  "createdAt": "<iso8601>",
  "updatedAt": "<iso8601>"
}
```

- `credentialContent` is **never** returned in any response.
- On duplicate `(provider, name)` → `409 Conflict`, code `VPS_ALREADY_EXISTS`.
- On duplicate `(provider, credentialFingerprint)` → `409 Conflict`, code `VPS_DUPLICATE_TOKEN`.

#### `GET /api/v1/vps`

List all registered VPS. Supports optional `?provider=codespaces` query filter.

**Response `200 OK`**:
```json
{
  "vps": [
    {
      "id": "<uuid>",
      "provider": "codespaces",
      "name": "vm-manager232",
      "credentialFileName": "vm-manager232.json",
      "credentialFingerprint": "sha256:<hex>",
      "createdAt": "<iso8601>",
      "updatedAt": "<iso8601>"
    }
  ]
}
```

#### `GET /api/v1/vps/:id`

Retrieve a single VPS record by ID (no `credentialContent`).

**Response `200 OK`**: same shape as one entry from the list.  
**Response `404 Not Found`**: code `VPS_NOT_FOUND`.

#### `PUT /api/v1/vps/:id`

Replace the VPS credential content for an existing record.

**Request body** (all fields optional; at least one required):
```json
{
  "credentialContent": "{\"token\":\"ghp_new_...\"}",
  "credentialFileName": "vm-manager232-v2.json"
}
```

- Re-validates and re-fingerprints `credentialContent` if provided.
- Updates `updatedAt` timestamp.
- Returns the same shape as `GET /api/v1/vps/:id`.

#### `DELETE /api/v1/vps/:id`

Remove a VPS record.

- **Blocked** if one or more non-terminal sessions (`status NOT IN ('TERMINATED','DELETED','FAILED')`) reference this VPS's fingerprint for the same provider. Returns `409 Conflict`, code `VPS_IN_USE`, listing the blocking session IDs.
- On success: `204 No Content`.

---

### FR-3: Content Validation Per Provider

When `credentialContent` is submitted (on `POST` or `PUT`), the server validates it according to provider rules:

| Provider | Accepted formats | Extracted token/key material for fingerprinting |
|---|---|---|
| `gcs` | JSON object with at minimum a `type` field (Google service account JSON) | Full JSON string (stable after `JSON.stringify(JSON.parse(...))`) |
| `codesandbox` | JSON object with a non-empty `token` string field | `credentialData.token` |
| `codespaces` | JSON object with a non-empty `token` string field, **or** plain text containing only the token | Trimmed token string |

Validation errors return `400 Bad Request` with a descriptive message and a provider-specific error code (e.g., `CODESANDBOX_CREDENTIALS_INVALID`, `CODESPACES_NO_CREDENTIAL`, `GCS_CREDENTIALS_INVALID`).

---

### FR-4: Database-Backed Credential Resolution

**As a** provider credential loader  
**I want** to resolve a credential reference by querying the database  
**So that** filesystem and S3 lookups are no longer required at request time

**Acceptance Criteria**:
- A new module `src/services/db-credentials-loader.js` exposes a unified `loadCredentialByRef(provider, credentialRef)` function.
- `credentialRef` is the `name` field of a `vps` row (e.g., `vm-manager232`). Legacy `s3://`, absolute path, or filename references are **not** accepted by this loader; they are handled only by the legacy loaders (see FR-6).
- The function queries `vps WHERE provider = $1 AND name = $2`, parses `credentialContent` using the same per-provider logic as FR-3, and returns the same shape as the existing provider credential loaders:
  ```js
  { token, credentialRef, credentialFingerprint }  // codesandbox / codespaces
  // or
  { keyFilePath, credentialRef, credentialFingerprint }  // gcs (writes content to a temp file)
  ```
- Results are cached in-process with a 5-minute TTL (matching the Codespaces loader's existing TTL), keyed by `provider:name`. Cache is invalidated on `PUT /api/v1/vps/:id` for the affected record.
- If no row is found, a `ProviderError` is thrown with code `VPS_NOT_FOUND` and status `404`.

---

### FR-5: Route Integration — Database-First Resolution

**As a** route handler  
**I want** credential references to be resolved from the database first  
**So that** session create, command, and refresh flows work without file system dependencies

**Acceptance Criteria**:
- `POST /api/v1/sessions` — when `credentialRef` (or header `x-google-credentials` / `x-codesandbox-credentials` / `x-codespaces-credentials`) matches a `name` in `vps` for the requested provider, `db-credentials-loader.js` is used to resolve it. If no matching DB record is found, fall back to the legacy file/S3 loader (see FR-6).
- `POST /api/v1/sessions/:id/command` — same resolution order.
- `GET /api/v1/sessions/:id` (refresh) — same resolution order for providers that require credentials on refresh (GCS).
- `DELETE /api/v1/sessions/:id` — same resolution order for providers that require credentials on termination (GCS).
- No change to the public request interface: callers still send the same header/body fields.

---

### FR-6: Legacy Loader Fallback

**As a** operator running a mixed-migration environment  
**I want** the existing file/S3 credential loaders to remain active as a fallback  
**So that** existing integrations continue to work during and after migration

**Acceptance Criteria**:
- If `credentialRef` does not match any `vps.name` for the provider, the system falls back to the existing `google-credentials-loader.js` / `codesandbox/credentials-loader.js` / `codespaces/credentials-loader.js` resolution chain.
- The fallback path is logged at `warn` level: `[Credentials] DB lookup miss for <provider>/<ref>, falling back to legacy loader`.
- No environment variables are removed or renamed; `S3FS_ENABLED`, `S3_BUCKET`, `S3_MOUNT_DIR` remain valid.
- The legacy credential listing endpoints (`GET /api/v1/sessions/google-credentials`, `codesandbox-credentials`, `codespaces-credentials`) continue to work unchanged.

---

### FR-7: VPS Listing Consolidation (New Unified Endpoint)

**As a** API user  
**I want** a single endpoint to list all database-registered VPS  
**So that** I can inspect the full VPS inventory without per-provider calls

**Acceptance Criteria**:
- `GET /api/v1/vps` (defined in FR-2) serves this purpose.
- The existing per-provider listing endpoints (`/sessions/google-credentials`, `/sessions/codesandbox-credentials`, `/sessions/codespaces-credentials`) are **not removed** in this ticket; they continue to list from disk/S3.
- The new endpoint lists **only** DB-registered VPS records.

---

### FR-8: Seeding / Import Utility

**As a** operator with existing credential files  
**I want** a script to bulk-import credentials from the local `credentials/` directory into the database  
**So that** I can migrate from filesystem credentials without manual API calls

**Acceptance Criteria**:
- A script `scripts/seed-credentials.js` reads all credential files from subdirectories under a configurable base directory (default: `./credentials`).
- Directory layout convention:
  - `<base>/<provider-folder>/<name>.<ext>` — e.g., `credentials/codespaces/vm-manager232.json`
  - Provider folder names map to provider identifiers: `gcs`/`gcloud` → `gcs`, `codesandbox` → `codesandbox`, `codespaces` → `codespaces`.
- For each file the script calls `POST /api/v1/vps` (configurable base URL + server token from env).
- Skips files that already exist (`409 VPS_ALREADY_EXISTS`) with a log notice.
- Prints a summary: imported, skipped, failed.
- Runnable via `node scripts/seed-credentials.js` or `npm run seed-credentials`.

---

## Non-Functional Requirements

### NFR-1: Security
- `credentialContent` must **never** appear in API responses, application logs, or error messages.
- The `vps` table must be treated as sensitive; the same access restrictions that apply to the `sessions` table (which stores private keys) apply here.
- Fingerprints (`sha256:<hex>`) may be logged and returned in responses.

### NFR-2: Backwards Compatibility
- No breaking changes to existing session-creation or command-execution request shapes.
- Legacy credential loaders remain functional; the new DB loader is additive.

### NFR-3: Migration Safety
- Schema bootstrap adds the `vps` table using `CREATE TABLE IF NOT EXISTS` — safe to run against an existing database.
- No existing `sessions` columns are altered.

### NFR-4: Performance
- DB credential lookups must complete within the existing pool timeout (60 s statement timeout). In practice, a simple `WHERE provider = $1 AND name = $2` lookup on an indexed table should complete in < 5 ms.
- The 5-minute in-process TTL cache (FR-4) prevents redundant DB round trips under load.

---

## Data Model

### New Table: `vps`

```sql
CREATE TABLE IF NOT EXISTS vps (
  id                   TEXT PRIMARY KEY,
  provider             TEXT NOT NULL,
  name                 TEXT NOT NULL,
  credentialFileName   TEXT NOT NULL,
  credentialContent    TEXT NOT NULL,
  credentialFingerprint TEXT NOT NULL,
  createdAt            TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updatedAt            TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- One record per provider + name
CREATE UNIQUE INDEX IF NOT EXISTS idx_vps_provider_name
  ON vps (provider, name);

-- No duplicate token content per provider
CREATE UNIQUE INDEX IF NOT EXISTS idx_vps_provider_fingerprint
  ON vps (provider, credentialFingerprint);
```

---

## API Surface

New routes grouped under `/api/v1/vps`. All require server token auth.

| Method | Route | Description |
|:---|:---|:---|
| `POST` | `/api/v1/vps` | Register a new VPS |
| `GET` | `/api/v1/vps` | List all VPS (optional `?provider=`) |
| `GET` | `/api/v1/vps/:id` | Get a single VPS record |
| `PUT` | `/api/v1/vps/:id` | Update VPS credential content or filename |
| `DELETE` | `/api/v1/vps/:id` | Delete VPS (blocked if in use) |

Existing session routes are unchanged.

---

## Affected Files

| File | Change |
|:---|:---|
| `src/db/db.js` | Add `vps` table and indexes to schema bootstrap |
| `src/services/db-credentials-loader.js` | **New** — DB-backed credential resolution with TTL cache |
| `src/routes/vps.js` | **New** — CRUD routes for `vps` |
| `src/server.js` | Mount `vps.js` router at `/api/v1/vps` |
| `src/routes/sessions.js` | DB-first resolution with legacy fallback in credential helper functions |
| `src/services/providers/codesandbox/credentials-loader.js` | No change (fallback path) |
| `src/services/providers/codespaces/credentials-loader.js` | No change (fallback path) |
| `src/services/google-credentials-loader.js` | No change (fallback path) |
| `scripts/seed-credentials.js` | **New** — bulk import script |
| `package.json` | Add `seed-credentials` script entry |

---

## Error Codes

| Code | HTTP | Description |
|:---|:---:|:---|
| `VPS_NOT_FOUND` | 404 | No `vps` row matches the given `id` or `(provider, name)` |
| `VPS_ALREADY_EXISTS` | 409 | Duplicate `(provider, name)` on insert |
| `VPS_DUPLICATE_TOKEN` | 409 | Duplicate `(provider, credentialFingerprint)` on insert or update |
| `VPS_IN_USE` | 409 | Delete blocked by active sessions using this VPS |
| `VPS_INVALID_PROVIDER` | 400 | `provider` field is not one of the supported values |
| `VPS_CONTENT_INVALID` | 400 | `credentialContent` fails per-provider validation |
| `VPS_NAME_INVALID` | 400 | `name` is empty or contains path separators |

---

## Out of Scope

- Encrypting `credentialContent` at rest in the database (noted as a future improvement; out of scope for this ticket).
- Removing the existing per-provider credential listing endpoints (`/sessions/google-credentials` etc.).
- Automatic migration of all existing sessions' `credentialRef` values to DB names.
- Rotation workflows or credential expiry TTLs (future ticket).
