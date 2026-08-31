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

const router = express.Router();

// ---------------------------------------------------------------------------
// Safe column list — credentialcontent is intentionally excluded from all
// SELECT queries that feed API responses.
// PostgreSQL lowercases unquoted identifiers, so we use explicit AS aliases
// to restore camelCase in the returned rows.
// ---------------------------------------------------------------------------
const VPS_SAFE_COLUMNS = `
  id,
  provider,
  name,
  credentialfilename    AS "credentialFileName",
  credentialfingerprint AS "credentialFingerprint",
  createdat             AS "createdAt",
  updatedat             AS "updatedAt"
`;

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
      `SELECT ${VPS_SAFE_COLUMNS} FROM vps WHERE id = ?`,
      [id]
    );

    return res.status(201).json(row);
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to register VPS');
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/vps — list all VPS records (optional ?provider= filter)
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { provider } = req.query;

    if (provider !== undefined) {
      validateProvider(provider);
    }

    let sql = `SELECT ${VPS_SAFE_COLUMNS} FROM vps`;
    const params = [];

    if (provider) {
      sql += ' WHERE provider = ?';
      params.push(provider);
    }

    sql += ' ORDER BY createdat DESC';

    const rows = await db.all(sql, params);
    return res.json({ vps: rows });
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to list VPS records');
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/vps/:id — retrieve a single VPS record
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const row = await db.get(
      `SELECT ${VPS_SAFE_COLUMNS} FROM vps WHERE id = ?`,
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
      `SELECT ${VPS_SAFE_COLUMNS} FROM vps WHERE id = ?`,
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
