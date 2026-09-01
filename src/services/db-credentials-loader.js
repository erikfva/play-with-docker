'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/db');
const { ProviderError } = require('./errors/provider-errors');
const { validateAndFingerprintContent } = require('./vps-credential-utils');

// 5-minute TTL — matches the existing Codespaces credential loader TTL.
const CREDENTIAL_CACHE_TTL_MS = 5 * 60 * 1000;

// Map: cacheKey → { result, cachedAt }
const cache = new Map();

function _getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt >= CREDENTIAL_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

function _setCached(key, result) {
  cache.set(key, { result, cachedAt: Date.now() });
}

/**
 * Evict the in-process cache entry for a (provider, name) pair.
 * Call this from PUT and DELETE /api/v1/vps/:id so no stale entry is served.
 */
function invalidateCache(provider, name) {
  cache.delete(`vps:${provider}:${name}`);
}

/**
 * Resolve a credential by (provider, name) from the vps table.
 *
 * Returns the same shape as the existing per-provider loaders:
 *   codespaces / codesandbox → { token, credentialRef, credentialFingerprint }
 *   gcs                      → { keyFilePath, credentialRef, credentialFingerprint }
 *
 * Throws ProviderError VPS_NOT_FOUND (404) when no row matches.
 */
async function loadCredentialByRef(provider, name) {
  const cacheKey = `vps:${provider}:${name}`;
  const cached = _getCached(cacheKey);
  if (cached) return cached;

  // Select only the columns we need — never log credentialcontent.
  const row = await db.get(
    `SELECT provider, name, credentialcontent AS "credentialContent", credentialfingerprint AS "credentialFingerprint"
     FROM vps
     WHERE provider = ? AND name = ?`,
    [provider, name]
  );

  if (!row) {
    throw new ProviderError(`VPS not found: ${provider}/${name}`, {
      code: 'VPS_NOT_FOUND',
      statusCode: 404
    });
  }

  const result = await _parseContent(provider, name, row);
  _setCached(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// Internal: parse credentialContent into the provider-specific result shape
// ---------------------------------------------------------------------------

async function _parseContent(provider, name, row) {
  const content = row['credentialContent'];
  // Use the shared validator to extract the token/key and confirm the stored
  // content is still valid. This also re-derives the fingerprint from content,
  // which we cross-check against the stored value for consistency.
  const validated = validateAndFingerprintContent(provider, content);

  // Use the stored fingerprint (the authoritative value from the DB row) so
  // the returned fingerprint always matches what sessions were created with.
  const credentialFingerprint = row['credentialFingerprint'];

  if (provider === 'codespaces' || provider === 'codesandbox') {
    return {
      token: validated.token,
      credentialRef: name,
      credentialFingerprint
    };
  }

  if (provider === 'gcs') {
    const keyFilePath = await _writeGcsTempFile(validated.keyJson, credentialFingerprint);
    return {
      keyFilePath,
      credentialRef: name,
      credentialFingerprint
    };
  }

  throw new ProviderError(`Unsupported provider: ${provider}`, {
    code: 'VPS_INVALID_PROVIDER',
    statusCode: 400
  });
}

/**
 * Write GCS JSON content to a temp file, creating the directory if needed.
 *
 * Path: <os.tmpdir()>/gcs-credentials/<sha256-of-fingerprint-hex>.json
 *
 * Using the fingerprint (already a sha256 hex) as the filename ensures
 * content-addressable storage — different keys get different files, same
 * key always lands at the same path (idempotent writes).
 */
async function _writeGcsTempFile(keyJson, credentialFingerprint) {
  // Strip the "sha256:" prefix to get the raw hex for use as a filename.
  const hex = credentialFingerprint.replace(/^sha256:/, '');
  const dir = path.join(os.tmpdir(), 'gcs-credentials');
  const filePath = path.join(dir, `${hex}.json`);

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, keyJson, { mode: 0o600 });

  return filePath;
}

module.exports = {
  loadCredentialByRef,
  invalidateCache
};
