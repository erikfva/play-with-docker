# LAB-011: Implementation Plan

## Scope

Two files change. Everything else is read-only context.

| File | Change |
|:---|:---|
| `src/db/db.js` | Add `ensureColumn('vps', 'status', ...)` migration |
| `src/routes/vps.js` | Rewrite `GET /` and `GET /:id` handlers; update `VPS_SAFE_COLUMNS` |

No new modules. No changes to provider loaders, sessions route, or DB schema beyond the single column migration.

---

## Reuse Map

| Need | Source |
|:---|:---|
| `db.run` / `db.all` / `db.get` | `src/db/db.js` — use `?` placeholders, same as every existing caller |
| `ensureColumn` idempotent migration | `src/db/db.js` — already used for `sessions` columns |
| `ProviderError` + `mapErrorToHttp` | `src/services/errors/provider-errors.js` + `src/utils/http-helpers.js` |
| `validateProvider` | `src/services/vps-credential-utils.js` — reuse for `?provider=` validation |
| `VPS_SAFE_COLUMNS` constant | `src/routes/vps.js` — extend in place |
| `?` placeholder syntax | All existing `db.*` callers — `convertSql` in `db.js` handles `?→$N` |

---

## Step 1 — `src/db/db.js`: Add `status` column migration

Add one `ensureColumn` call inside `db.ready`, immediately after the existing `vps` table block (the `console.log('[DB] ✓ vps table ready')` line):

```js
await ensureColumn('vps', 'status', 'ALTER TABLE vps ADD COLUMN status JSONB DEFAULT NULL');
```

This is idempotent — safe against an existing deployed database. `ensureColumn` already checks `information_schema.columns` before running the DDL. `JSONB` is used instead of `TEXT` so the column supports `->>`/`@>` operators and GIN indexing for future LAB-009 queries without a schema change.

**No other changes to `db.js`.**

---

## Step 2 — `src/routes/vps.js`: Update `VPS_SAFE_COLUMNS` and both read handlers

### 2a. Constants to add at the top of the file

```js
// Allowlist for sortBy — maps camelCase query param values to actual DB column names.
// All lookups use the lowercased query value as the key.
// status is excluded: the column is JSONB and PostgreSQL cannot sort by an entire
// JSON object. Add sortBy=status.<field> in a future ticket once the LAB-009 shape
// is stabilised.
const SORT_FIELD_MAP = {
  name:       'name',
  provider:   'provider',
  createdat:  'createdat',
  updatedat:  'updatedat',
};
const DEFAULT_SORT_BY    = 'createdat';
const DEFAULT_SORT_ORDER = 'DESC';

const VALID_SORT_ORDERS = new Set(['asc', 'desc']);

// sessionActive EXISTS sub-query — identical fragment reused in GET / and GET /:id
const SESSION_ACTIVE_EXPR = `
  EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.credentialfingerprint = v.credentialfingerprint
      AND s.provider = v.provider
      AND COALESCE(s.status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED')
  ) AS "sessionActive"
`;
```

### 2b. Updated `VPS_SAFE_COLUMNS`

Replace the existing `VPS_SAFE_COLUMNS` constant with:

```js
// credentialcontent is intentionally excluded from all SELECT queries.
// status and sessionActive are new in LAB-011.
const VPS_SAFE_COLUMNS = `
  v.id,
  v.provider,
  v.name,
  v.credentialfilename    AS "credentialFileName",
  v.credentialfingerprint AS "credentialFingerprint",
  v.status,
  v.createdat             AS "createdAt",
  v.updatedat             AS "updatedAt",
  ${SESSION_ACTIVE_EXPR}
`;
```

> **Important:** The existing handlers use `vps` (unaliased) in their queries. When `VPS_SAFE_COLUMNS` gains `v.`-prefixed columns, every query that references these columns must use the `vps v` alias. All updated queries below use `FROM vps v` or `FROM vps v WHERE v.id = ?`. The `POST`, `PUT`, and `DELETE` handlers fetch only a few specific columns by name (`id`, `provider`, `name`, `credentialFingerprint`) and do **not** use `VPS_SAFE_COLUMNS` — they must be updated to use the table alias as well, or rewritten to use unaliased column names in their individual SELECT lists.
>
> Simplest safe approach: update only the two `GET` handlers to use `FROM vps v` with the updated `VPS_SAFE_COLUMNS`. Leave the other handlers' bespoke SELECTs unchanged (they already name exact columns without the macro).

### 2c. Input validation helper (inline in the route file)

```js
/**
 * Parse and validate GET /api/v1/vps query parameters.
 * Returns { provider, sessionActiveFilter, limit, offset, sortCol, sortDir }
 * or throws ProviderError with code VPS_INVALID_PARAM.
 */
function parseListParams(query) {
  const { provider, sessionActive, limit, offset, sortBy, sortOrder } = query;

  // --- provider ---
  let providerFilter = null;
  if (provider !== undefined) {
    // Reuse validateProvider but rethrow as VPS_INVALID_PARAM for this route
    try {
      validateProvider(provider);
    } catch {
      throw new ProviderError(
        `Invalid provider: "${provider}". Must be one of: gcs, codesandbox, codespaces`,
        { code: 'VPS_INVALID_PARAM', statusCode: 400 }
      );
    }
    providerFilter = provider;
  }

  // --- sessionActive ---
  let sessionActiveFilter = null; // null = no filter
  if (sessionActive !== undefined) {
    const lower = sessionActive.toLowerCase();
    if (lower === 'true')       sessionActiveFilter = true;
    else if (lower === 'false') sessionActiveFilter = false;
    else throw new ProviderError(
      `Invalid sessionActive value: "${sessionActive}". Must be "true" or "false"`,
      { code: 'VPS_INVALID_PARAM', statusCode: 400 }
    );
  }

  // --- limit ---
  let limitVal = 20;
  if (limit !== undefined) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      throw new ProviderError(
        `Invalid limit: "${limit}". Must be an integer between 1 and 100`,
        { code: 'VPS_INVALID_PARAM', statusCode: 400 }
      );
    }
    limitVal = n;
  }

  // --- offset ---
  let offsetVal = 0;
  if (offset !== undefined) {
    const n = Number(offset);
    if (!Number.isInteger(n) || n < 0) {
      throw new ProviderError(
        `Invalid offset: "${offset}". Must be a non-negative integer`,
        { code: 'VPS_INVALID_PARAM', statusCode: 400 }
      );
    }
    offsetVal = n;
  }

  // --- sortBy ---
  const sortByKey = (sortBy || 'createdAt').toLowerCase();
  const sortCol = SORT_FIELD_MAP[sortByKey];
  if (!sortCol) {
    throw new ProviderError(
      `Invalid sortBy: "${sortBy}". Must be one of: name, provider, createdAt, updatedAt`,
      { code: 'VPS_INVALID_PARAM', statusCode: 400 }
    );
  }

  // --- sortOrder ---
  const sortOrderKey = (sortOrder || 'desc').toLowerCase();
  if (!VALID_SORT_ORDERS.has(sortOrderKey)) {
    throw new ProviderError(
      `Invalid sortOrder: "${sortOrder}". Must be "asc" or "desc"`,
      { code: 'VPS_INVALID_PARAM', statusCode: 400 }
    );
  }
  const sortDir = sortOrderKey.toUpperCase(); // 'ASC' or 'DESC'

  return { providerFilter, sessionActiveFilter, limitVal, offsetVal, sortCol, sortDir };
}
```

### 2d. Updated `GET /` handler

Replace the existing `GET /` handler body:

```js
router.get('/', async (req, res) => {
  try {
    const { providerFilter, sessionActiveFilter, limitVal, offsetVal, sortCol, sortDir }
      = parseListParams(req.query);

    // Build WHERE clauses. Uses parameterized bindings — sortCol is allowlist-resolved,
    // sortDir is 'ASC' or 'DESC' (not user input). Never interpolate raw query values.
    const whereClauses = [];
    const params = [];

    if (providerFilter !== null) {
      whereClauses.push('v.provider = ?');
      params.push(providerFilter);
    }

    if (sessionActiveFilter === true) {
      whereClauses.push(`EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.credentialfingerprint = v.credentialfingerprint
          AND s.provider = v.provider
          AND COALESCE(s.status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED')
      )`);
    } else if (sessionActiveFilter === false) {
      whereClauses.push(`NOT EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.credentialfingerprint = v.credentialfingerprint
          AND s.provider = v.provider
          AND COALESCE(s.status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED')
      )`);
    }

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // COUNT query — same WHERE, no limit/offset
    const countSql = `SELECT COUNT(*) AS total FROM vps v ${whereStr}`;
    const countRow = await db.get(countSql, params);
    const total = parseInt(countRow.total, 10);

    // status is JSONB — not in SORT_FIELD_MAP, so nullsClause is always ''.
    // None of the sortable columns are nullable.
    const nullsClause = '';

    // Data query — ORDER BY uses allowlist-resolved column name; sortDir is 'ASC'/'DESC' literal
    const dataSql = `
      SELECT ${VPS_SAFE_COLUMNS}
      FROM vps v
      ${whereStr}
      ORDER BY v.${sortCol} ${sortDir}${nullsClause}
      LIMIT ? OFFSET ?
    `;
    const rows = await db.all(dataSql, [...params, limitVal, offsetVal]);

    return res.json({ vps: rows, total, limit: limitVal, offset: offsetVal });
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to list VPS records');
  }
});
```

**Security note on `ORDER BY` interpolation:** `sortCol` is looked up from `SORT_FIELD_MAP` using the lowercased user input as a key. If the key is not in the map, `parseListParams` throws before reaching the query. `sortDir` is `'ASC'` or `'DESC'` — produced by `toUpperCase()` on a value that has already been validated against the `VALID_SORT_ORDERS` set. Neither value can be influenced by arbitrary user input. This satisfies NFR-3.

### 2e. Updated `GET /:id` handler

Replace the existing body:

```js
router.get('/:id', async (req, res) => {
  try {
    const row = await db.get(
      `SELECT ${VPS_SAFE_COLUMNS} FROM vps v WHERE v.id = ?`,
      [req.params.id]
    );

    if (!row) {
      return res.status(404).json({ error: 'VPS not found', code: 'VPS_NOT_FOUND' });
    }

    return res.json(row);
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to retrieve VPS record');
  }
});
```

### 2f. No changes to `POST`, `PUT`, `DELETE` handlers

These handlers use their own bespoke `SELECT` statements that name explicit columns (not `VPS_SAFE_COLUMNS`) and do not need `sessionActive` or `status`. They are untouched.

The `POST` and `PUT` handlers destructure only known fields (`credentialContent`, `credentialFileName`, etc.) from `req.body`, so a caller sending `status` in the body already has it silently ignored — no code change needed to satisfy the spec's "silently ignored" AC.

---

## Step 3 — Tests: `tests/vps-list.test.js`

New test file. Uses the same stub-module pattern as `tests/codespaces-session-create-route.test.js` — no external test framework, Node built-in `--test`.

### Test cases

| # | Description |
|:--|:---|
| T-01 | Default params return `{vps, total, limit:20, offset:0}` envelope |
| T-02 | `?limit=5&offset=10` respected; `limit` and `offset` reflected in response |
| T-03 | `?limit=0` → 400 `VPS_INVALID_PARAM` |
| T-04 | `?limit=101` → 400 `VPS_INVALID_PARAM` |
| T-05 | `?limit=abc` → 400 `VPS_INVALID_PARAM` |
| T-06 | `?offset=-1` → 400 `VPS_INVALID_PARAM` |
| T-07 | `?sortBy=name&sortOrder=asc` — query includes `ORDER BY name ASC` |
| T-08 | `?sortBy=CREATEDAT` (uppercase) — accepted, resolves to `createdat` |
| T-09 | `?sortBy=invalid` → 400 `VPS_INVALID_PARAM` |
| T-10 | `?sortOrder=sideways` → 400 `VPS_INVALID_PARAM` |
| T-11 | `?sessionActive=true` — only rows where `sessionActive` is truthy returned |
| T-12 | `?sessionActive=false` — only rows where `sessionActive` is falsy returned |
| T-13 | `?sessionActive=TRUE` (uppercase) — accepted |
| T-14 | `?sessionActive=1` → 400 `VPS_INVALID_PARAM` |
| T-15 | `?provider=codespaces` — filtered rows returned; wrong provider → 400 |
| T-16 | `?provider=bad` → 400 `VPS_INVALID_PARAM` (not `VPS_INVALID_PROVIDER`) |
| T-17 | Combined: `?provider=gcs&sessionActive=false&sortBy=name&sortOrder=asc&limit=5&offset=0` |
| T-18 | `GET /:id` response includes `sessionActive` and `status` fields |
| T-19 | `total` reflects filtered count (provider filter reduces total) |
| T-20 | `sortBy=status` → `400 VPS_INVALID_PARAM` (`status` is JSONB, not directly sortable) |

### Stub shape for the VPS route test harness

```js
// db stub needs: all(), get(), run(), pool, ready
// db.get() for COUNT returns { total: N }
// db.all() for data returns array of VPS rows with sessionActive boolean
stubModule(dbPath, {
  get:   async (sql, params) => { ... },
  all:   async (sql, params) => { ... },
  run:   async () => {},
  pool:  { end: async () => {} },
  ready: Promise.resolve()
});

// vps-credential-utils stub (validateProvider)
stubModule(vpsUtilsPath, {
  validateProvider: (p) => {
    if (!['gcs', 'codesandbox', 'codespaces'].includes(p)) {
      const { ProviderError } = require(providerErrorsPath);
      throw new ProviderError(`Invalid provider: "${p}"`, { code: 'VPS_INVALID_PROVIDER', statusCode: 400 });
    }
  },
  validateName: () => {},
  validateAndFingerprintContent: () => {}
});
```

---

## Implementation Order

1. `src/db/db.js` — add the `ensureColumn` call. One line. Verify it's after the vps table block.
2. `src/routes/vps.js` — add constants, replace `VPS_SAFE_COLUMNS`, add `parseListParams`, replace `GET /` and `GET /:id` handlers.
3. `tests/vps-list.test.js` — write tests against the updated route using the stub pattern.
4. Run `node --test tests/vps-list.test.js` — fix any failures before closing.

---

## Risk Notes

- **`ORDER BY` injection:** `sortCol` must only ever come from `SORT_FIELD_MAP[lowercasedInput]`. If the key is absent, `parseListParams` throws a `400` before any SQL runs. Never use `req.query.sortBy` directly in a string template.
- **`NULLS LAST` for DESC:** Not applicable — `status` is `JSONB` and excluded from `sortBy`. All sortable columns (`name`, `provider`, `createdat`, `updatedat`) are `NOT NULL`, so PostgreSQL's default ordering behaviour is correct for all directions.
- **`convertSql` and `?` placeholders:** The `EXISTS` sub-queries inside `whereClauses` contain no `?` placeholders — they reference only `v.credentialfingerprint` and `v.provider` (columns already bound to the outer query's `FROM vps v`). Only the outer `WHERE` clauses push to `params`. Do not accidentally introduce `?` inside the subquery strings.
- **`VPS_SAFE_COLUMNS` and table alias:** All columns in the updated `VPS_SAFE_COLUMNS` are prefixed `v.`. Queries using this constant must use `FROM vps v` (or subquery with alias `v`). The bespoke SELECTs in `POST`/`PUT`/`DELETE` do not use `VPS_SAFE_COLUMNS` and are unaffected.
- **`total` field type:** `COUNT(*)` in PostgreSQL returns a `bigint` which `pg` delivers as a string. Parse with `parseInt(countRow.total, 10)` before including in the response to avoid returning `"87"` instead of `87`.
- **`status` on `POST`/`PUT`:** No code change needed — the handlers already ignore unknown body fields via destructuring. Document this explicitly in PR description so reviewers don't question the omission.
