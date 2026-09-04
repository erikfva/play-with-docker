'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { mapErrorToHttp } = require('../utils/http-helpers');
const { invalidateCache } = require('../services/db-credentials-loader');
const {
  validateProvider,
  validateName,
  validateAndFingerprintContent
} = require('../services/vps-credential-utils');
const { ProviderError } = require('../services/errors/provider-errors');
const { refreshVpsStatus, refreshAllVpsStatuses, mergeCodesandboxBilling } = require('../services/vps-status-service');

const router = express.Router();

// ---------------------------------------------------------------------------
// Sorting allowlist — maps lowercased query param value → actual DB column.
// Only values present here are accepted; anything else → 400 VPS_INVALID_PARAM.
// ---------------------------------------------------------------------------
const SORT_FIELD_MAP = {
  name:      'name',
  provider:  'provider',
  createdat: 'createdat',
  updatedat: 'updatedat',
};
const VALID_SORT_ORDERS = new Set(['asc', 'desc']);

// Correlated EXISTS sub-query used in both the SELECT list and the
// sessionActive WHERE filter. Contains no ? placeholders so it never
// disturbs convertSql's $n index rewriting.
const SESSION_ACTIVE_SUBQUERY = `EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.credentialfingerprint = v.credentialfingerprint
      AND s.provider              = v.provider
      AND COALESCE(s.status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED')
  )`;

// ---------------------------------------------------------------------------
// Safe column list — credentialcontent is intentionally excluded from all
// SELECT queries that feed API responses.
// PostgreSQL lowercases unquoted identifiers, so we use explicit AS aliases
// to restore camelCase in the returned rows.
// All columns are v.-prefixed; every query using this list must alias the
// vps table as v (i.e., FROM vps v).
// ---------------------------------------------------------------------------
const VPS_SAFE_COLUMNS = `
  v.id,
  v.provider,
  v.name,
  v.credentialfilename    AS "credentialFileName",
  v.credentialfingerprint AS "credentialFingerprint",
  v.status,
  v.statuscheckedat       AS "statusCheckedAt",
  v.createdat             AS "createdAt",
  v.updatedat             AS "updatedAt",
  ${SESSION_ACTIVE_SUBQUERY} AS "sessionActive"
`;

// ---------------------------------------------------------------------------
// parseListParams — validate and normalise all GET / query parameters.
// Throws ProviderError(VPS_INVALID_PARAM, 400) on any violation.
// Returns { providerFilter, sessionActiveFilter, limitVal, offsetVal,
//           sortCol, sortDir, nullsClause }
// ---------------------------------------------------------------------------
function parseListParams(query) {
  const { provider, sessionActive, limit, offset, sortBy, sortOrder } = query;

  // --- provider ---
  let providerFilter = null;
  if (provider !== undefined) {
    try {
      validateProvider(provider);   // throws VPS_INVALID_PROVIDER on bad value
    } catch {
      // Re-throw with the correct code for query-param context (US-5)
      throw new ProviderError(
        `Invalid provider: "${provider}". Must be one of: gcs, codesandbox, codespaces`,
        { code: 'VPS_INVALID_PARAM', statusCode: 400 }
      );
    }
    providerFilter = provider;
  }

  // --- sessionActive ---
  let sessionActiveFilter = null;   // null = no filter
  if (sessionActive !== undefined) {
    const lower = String(sessionActive).toLowerCase();
    if (lower === 'true')        sessionActiveFilter = true;
    else if (lower === 'false')  sessionActiveFilter = false;
    else throw new ProviderError(
      `Invalid sessionActive: "${sessionActive}". Must be "true" or "false"`,
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

  // --- sortBy --- case-insensitive, allowlist-resolved
  const sortByKey = (sortBy || 'createdAt').toLowerCase();
  const sortCol = SORT_FIELD_MAP[sortByKey];
  if (!sortCol) {
    throw new ProviderError(
      `Invalid sortBy: "${sortBy}". Must be one of: name, provider, createdAt, updatedAt`,
      { code: 'VPS_INVALID_PARAM', statusCode: 400 }
    );
  }

  // --- sortOrder --- case-insensitive
  const sortOrderKey = (sortOrder || 'desc').toLowerCase();
  if (!VALID_SORT_ORDERS.has(sortOrderKey)) {
    throw new ProviderError(
      `Invalid sortOrder: "${sortOrder}". Must be "asc" or "desc"`,
      { code: 'VPS_INVALID_PARAM', statusCode: 400 }
    );
  }
  const sortDir = sortOrderKey.toUpperCase();   // 'ASC' or 'DESC'

  // status is JSONB and not directly sortable — it is not in SORT_FIELD_MAP.
  // nullsClause is unused now but kept as empty string for structural clarity.
  const nullsClause = '';

  return { providerFilter, sessionActiveFilter, limitVal, offsetVal, sortCol, sortDir, nullsClause };
}

// ---------------------------------------------------------------------------
// POST /api/v1/vps — register a new VPS credential record
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const { provider, name, credentialFileName, credentialContent } = req.body || {};

    // Validate required fields
    validateProvider(provider);
    validateName(name);

    if (!credentialFileName || typeof credentialFileName !== 'string' || !credentialFileName.trim()) {
      return res.status(400).json({
        error: 'credentialFileName is required',
        code: 'VPS_CONTENT_INVALID'
      });
    }

    if (!credentialContent || typeof credentialContent !== 'string' || !credentialContent.trim()) {
      return res.status(400).json({
        error: 'credentialContent is required',
        code: 'VPS_CONTENT_INVALID'
      });
    }

    const { fingerprint } = validateAndFingerprintContent(provider, credentialContent);

    const id = uuidv4();
    const now = new Date().toISOString();

    try {
      await db.run(
        `INSERT INTO vps (id, provider, name, credentialfilename, credentialcontent, credentialfingerprint, createdat, updatedat)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, provider, name.trim(), credentialFileName.trim(), credentialContent, fingerprint, now, now]
      );
    } catch (dbError) {
      if (dbError.code === '23505') {
        const isNameDupe = dbError.constraint === 'idx_vps_provider_name';
        return res.status(409).json({
          error: isNameDupe
            ? 'A VPS with this name already exists for this provider'
            : 'Duplicate credential token for this provider',
          code: isNameDupe ? 'VPS_ALREADY_EXISTS' : 'VPS_DUPLICATE_TOKEN'
        });
      }
      throw dbError;
    }

    const row = await db.get(
      `SELECT ${VPS_SAFE_COLUMNS} FROM vps v WHERE v.id = ?`,
      [id]
    );

    return res.status(201).json(row);
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to register VPS');
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/vps — list VPS records with filtering, sorting, and pagination
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { providerFilter, sessionActiveFilter, limitVal, offsetVal, sortCol, sortDir, nullsClause }
      = parseListParams(req.query);

    // Build WHERE clauses using only parameterized bindings.
    // sortCol is allowlist-resolved; sortDir is 'ASC'/'DESC' from VALID_SORT_ORDERS.
    // SESSION_ACTIVE_SUBQUERY contains no ? placeholders — safe to interpolate.
    const whereClauses = [];
    const filterParams = [];

    if (providerFilter !== null) {
      whereClauses.push('v.provider = ?');
      filterParams.push(providerFilter);
    }

    if (sessionActiveFilter === true) {
      whereClauses.push(SESSION_ACTIVE_SUBQUERY);
    } else if (sessionActiveFilter === false) {
      whereClauses.push(`NOT ${SESSION_ACTIVE_SUBQUERY}`);
    }

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // COUNT query — same WHERE, no LIMIT/OFFSET.
    // pg returns COUNT(*) as a string (bigint); parseInt is required.
    const countRow = await db.get(
      `SELECT COUNT(*) AS total FROM vps v ${whereStr}`,
      filterParams
    );
    const total = parseInt(countRow.total, 10);

    // Data query — ORDER BY uses allowlist-resolved sortCol and sortDir literals.
    // Tiebreaker v.id ASC ensures deterministic page boundaries.
    const rows = await db.all(
      `SELECT ${VPS_SAFE_COLUMNS}
       FROM vps v
       ${whereStr}
       ORDER BY v.${sortCol} ${sortDir}${nullsClause}, v.id ASC
       LIMIT ? OFFSET ?`,
      [...filterParams, limitVal, offsetVal]
    );

    return res.json({ vps: rows, total, limit: limitVal, offset: offsetVal });
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to list VPS records');
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/vps/status/refresh — bulk refresh (must be before /:id routes)
// ---------------------------------------------------------------------------
router.post('/status/refresh', async (req, res) => {
  try {
    const { provider, force } = req.query;

    let forceVal = false;
    if (force !== undefined) {
      const lower = String(force).toLowerCase();
      if (lower === 'true') forceVal = true;
      else if (lower === 'false') forceVal = false;
      else throw new ProviderError(`Invalid force: "${force}". Must be "true" or "false"`, { code: 'VPS_INVALID_PARAM', statusCode: 400 });
    }

    let providerFilter = null;
    if (provider !== undefined) {
      try {
        validateProvider(provider);
      } catch {
        throw new ProviderError(`Invalid provider: "${provider}". Must be one of: gcs, codesandbox, codespaces`, { code: 'VPS_INVALID_PARAM', statusCode: 400 });
      }
      providerFilter = provider;
    }

    const result = await refreshAllVpsStatuses({ provider: providerFilter, force: forceVal });
    return res.json(result);
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to refresh VPS statuses');
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/vps/:id/status/refresh — single VPS refresh
// ---------------------------------------------------------------------------
router.post('/:id/status/refresh', async (req, res) => {
  try {
    const { force } = req.query;
    let forceVal = false;
    if (force !== undefined) {
      const lower = String(force).toLowerCase();
      if (lower === 'true') forceVal = true;
      else if (lower === 'false') forceVal = false;
      else throw new ProviderError(`Invalid force: "${force}". Must be "true" or "false"`, { code: 'VPS_INVALID_PARAM', statusCode: 400 });
    }

    const updated = await refreshVpsStatus(req.params.id, { force: forceVal });
    if (!updated) {
      return res.status(404).json({ error: 'VPS not found', code: 'VPS_NOT_FOUND' });
    }
    return res.json(updated);
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to refresh VPS status');
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/vps/:id/status/billing — merge CodeSandbox dashboard billing
// into the persisted VPS status (called by scripts/get-codesandbox-credits.js).
// ---------------------------------------------------------------------------
router.patch('/:id/status/billing', async (req, res) => {
  try {
    const { billing } = req.body || {};
    if (!billing || typeof billing !== 'object') {
      return res.status(400).json({ error: 'billing object is required', code: 'VPS_INVALID_PARAM' });
    }
    const hasAny = billing.includedCredits != null || billing.usedCredits != null || billing.remainingCredits != null;
    if (!hasAny) {
      return res.status(400).json({ error: 'billing must include at least one of includedCredits, usedCredits, remainingCredits', code: 'VPS_INVALID_PARAM' });
    }
    const updated = await mergeCodesandboxBilling(req.params.id, billing);
    return res.json(updated);
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to merge billing into VPS status');
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/vps/:id — retrieve a single VPS record (includes sessionActive)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// PUT /api/v1/vps/:id — update credential content and/or filename
// ---------------------------------------------------------------------------
router.put('/:id', async (req, res) => {
  try {
    const { credentialContent, credentialFileName } = req.body || {};

    if (credentialContent === undefined && credentialFileName === undefined) {
      return res.status(400).json({
        error: 'At least one of credentialContent or credentialFileName must be provided',
        code: 'VPS_CONTENT_INVALID'
      });
    }

    // Fetch current row to get provider and name (needed for cache invalidation
    // and re-fingerprinting). Select only the columns we need.
    const current = await db.get(
      `SELECT id, provider, name, credentialfingerprint AS "credentialFingerprint"
       FROM vps WHERE id = ?`,
      [req.params.id]
    );

    if (!current) {
      return res.status(404).json({ error: 'VPS not found', code: 'VPS_NOT_FOUND' });
    }

    const setParts = ['updatedat = CURRENT_TIMESTAMP'];
    const params = [];

    let newFingerprint = null;

    if (credentialContent !== undefined) {
      if (typeof credentialContent !== 'string' || !credentialContent.trim()) {
        return res.status(400).json({
          error: 'credentialContent must be a non-empty string',
          code: 'VPS_CONTENT_INVALID'
        });
      }

      const { fingerprint } = validateAndFingerprintContent(current.provider, credentialContent);
      newFingerprint = fingerprint;
      setParts.push('credentialcontent = ?');
      params.push(credentialContent);
      setParts.push('credentialfingerprint = ?');
      params.push(fingerprint);
    }

    if (credentialFileName !== undefined) {
      if (typeof credentialFileName !== 'string' || !credentialFileName.trim()) {
        return res.status(400).json({
          error: 'credentialFileName must be a non-empty string',
          code: 'VPS_CONTENT_INVALID'
        });
      }
      setParts.push('credentialfilename = ?');
      params.push(credentialFileName.trim());
    }

    params.push(req.params.id);

    try {
      await db.run(
        `UPDATE vps SET ${setParts.join(', ')} WHERE id = ?`,
        params
      );
    } catch (dbError) {
      if (dbError.code === '23505') {
        // Only the fingerprint index can fire on PUT (name is not changed)
        return res.status(409).json({
          error: 'Duplicate credential token for this provider',
          code: 'VPS_DUPLICATE_TOKEN'
        });
      }
      throw dbError;
    }

    // Evict cache so the next loadCredentialByRef picks up the new content
    invalidateCache(current.provider, current.name);

    const updated = await db.get(
      `SELECT ${VPS_SAFE_COLUMNS} FROM vps v WHERE v.id = ?`,
      [req.params.id]
    );

    return res.json(updated);
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to update VPS record');
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/vps/:id — remove a VPS record (blocked if sessions are active)
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    // Fetch only what we need — never select credentialcontent here
    const row = await db.get(
      `SELECT id, provider, name, credentialfingerprint AS "credentialFingerprint"
       FROM vps WHERE id = ?`,
      [req.params.id]
    );

    if (!row) {
      return res.status(404).json({ error: 'VPS not found', code: 'VPS_NOT_FOUND' });
    }

    // Block deletion if any non-terminal session references this credential
    const blocking = await db.all(
      `SELECT id FROM sessions
       WHERE credentialfingerprint = ? AND provider = ?
       AND COALESCE(status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED')`,
      [row['credentialFingerprint'], row.provider]
    );

    if (blocking.length > 0) {
      return res.status(409).json({
        error: 'VPS is in use by active sessions',
        code: 'VPS_IN_USE',
        details: { blockingSessionIds: blocking.map(s => s.id) }
      });
    }

    await db.run('DELETE FROM vps WHERE id = ?', [req.params.id]);

    // Evict cache so no stale in-memory entry is served after the row is gone
    invalidateCache(row.provider, row.name);

    return res.status(204).send();
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to delete VPS record');
  }
});

module.exports = router;
