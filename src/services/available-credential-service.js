'use strict';

const { ProviderError } = require('./errors/provider-errors');

/**
 * Available-credential selection.
 *
 * The vps table is the canonical credential registry (LAB-010): every managed
 * credential has a row with its provider, name, fingerprint and the last
 * persisted status envelope (including quotas).
 *
 * Selection rules:
 *   - A credential that currently backs a live session is "in use" and is
 *     skipped for every provider.
 *   - A credential whose status is INVALID / EXPIRED / QUOTA_EXHAUSTED /
 *     UNAVAILABLE is unusable and is skipped.
 *   - Default strategy: the first eligible credential in registration order.
 *   - Codespaces strategy: the eligible credential with the most remaining
 *     core-hours (compute capacity) — for that provider the first-eligible
 *     rule would routinely hand out an account that is about to run out.
 */

const SUPPORTED_PROVIDERS = new Set(['gcs', 'codesandbox', 'codespaces']);

/** Session statuses that no longer count as "in use". */
const TERMINAL_SESSION_STATUSES = {
  gcs: ['TERMINATED', 'DELETED', 'FAILED'],
  codesandbox: ['TERMINATED', 'DELETED', 'FAILED'],
  codespaces: ['TERMINATED', 'FAILED']
};

/** Statuses that make a credential unusable. */
const UNUSABLE_STATUSES = new Set([
  'INVALID',
  'EXPIRED',
  'QUOTA_EXHAUSTED',
  'UNAVAILABLE'
]);

/**
 * LIMITED is persisted by the status service when a credential currently
 * backs an active session. It is treated as "in use" rather than "unusable"
 * so the credential becomes eligible again once the session ends and the
 * status is refreshed.
 */
const LIMITED_STATUS = 'LIMITED';

/**
 * Key on the sessions table that identifies the credential a session consumes.
 * Codesandbox/Codespaces persist a credential fingerprint; GCS does not, so its
 * sessions are matched on the stored credential reference (the registry name).
 * Pre-LAB-010 GCS sessions may store a credential file path instead, which will
 * not match a registry name and therefore will not be detected as in use.
 * Every provider is subject to the in-use rule.
 */
const IN_USE_KEY = {
  gcs: 'credentialRef',
  codesandbox: 'credentialFingerprint',
  codespaces: 'credentialFingerprint'
};

const NO_AVAILABLE_CREDENTIAL = 'NO_AVAILABLE_CREDENTIAL';
const NO_REGISTERED_CREDENTIALS = 'NO_REGISTERED_CREDENTIALS';
const ALL_IN_USE_OR_UNUSABLE = 'ALL_IN_USE_OR_UNUSABLE';

function asStatusObject(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (_) { return null; }
  }
  return null;
}

/** True when the quota row describes compute capacity in core-hours. */
function isComputeQuota(q) {
  if (!q || typeof q !== 'object') return false;
  return String(q.quotaUnit ?? '').trim().toLowerCase() === 'core-hours';
}

/**
 * Remaining core-hours for a codespaces credential.
 * Returns null when the provider did not report a compute quota.
 */
function extractCoreHoursRemaining(quotas) {
  if (!Array.isArray(quotas)) return null;
  const quota = quotas.find(isComputeQuota);
  if (!quota) return null;

  if (typeof quota.remaining === 'number' && Number.isFinite(quota.remaining)) {
    return quota.remaining;
  }
  if (typeof quota.limit === 'number' && Number.isFinite(quota.limit)
      && typeof quota.usage === 'number' && Number.isFinite(quota.usage)) {
    return Math.max(0, quota.limit - quota.usage);
  }
  return null;
}

function isUsableStatus(status) {
  if (!status) return true; // unknown status — do not exclude on a guess
  return !UNUSABLE_STATUSES.has(status);
}

/**
 * Build the candidate list for a provider from the vps registry.
 * Ordering is registration order (createdAt ASC, id ASC) — the "first
 * eligible credential" default strategy relies on it.
 */
async function listDbCandidates(providerName) {
  // Lazy require: keeps this module importable (and unit-testable) without a
  // live database driver.
  const db = require('../db/db');
  const rows = await db.all(
    `SELECT v.id,
            v.name,
            v.credentialfingerprint AS "credentialFingerprint",
            v.status,
            v.statuscheckedat       AS "statusCheckedAt",
            v.createdat             AS "createdAt"
     FROM vps v
     WHERE v.provider = ?
     ORDER BY v.createdat ASC, v.id ASC`,
    [providerName]
  );
  return (rows || []).map((row) => ({
    id: row.id,
    provider: providerName,
    credentialRef: row.name,
    displayName: row.name,
    credentialFingerprint: row['credentialFingerprint'] || null,
    status: row.status ?? null,
    statusCheckedAt: row['statusCheckedAt'] ?? null,
    createdAt: row['createdAt'] ?? null
  }));
}

/** Values on the sessions table that currently back a live session for this provider. */
async function listInUseKeys(providerName) {
  const db = require('../db/db');
  const keyColumn = IN_USE_KEY[providerName] || 'credentialFingerprint';
  const terminal = TERMINAL_SESSION_STATUSES[providerName] || ['TERMINATED', 'DELETED', 'FAILED'];
  const placeholders = terminal.map(() => '?').join(', ');
  const rows = await db.all(
    `SELECT DISTINCT ${keyColumn} AS "inUseKey"
     FROM sessions
     WHERE provider = ?
       AND ${keyColumn} IS NOT NULL
       AND COALESCE(status, '') NOT IN (${placeholders})`,
    [providerName, ...terminal]
  );
  return new Set((rows || []).map((r) => r['inUseKey']).filter(Boolean));
}

/** Annotate candidates with in-use / usability / core-hours information. */
function annotateCandidates(candidates, providerName, inUseKeys) {
  const keyField = IN_USE_KEY[providerName] || 'credentialFingerprint';

  return candidates.map((candidate) => {
    const statusObject = asStatusObject(candidate.status);
    const status = statusObject?.status || null;
    const identity = candidate[keyField] || null;

    const inUse = (identity ? inUseKeys.has(identity) : false) || status === LIMITED_STATUS;
    const usable = isUsableStatus(status);

    return {
      ...candidate,
      status,
      statusObject,
      inUse,
      inUseKnown: Boolean(IN_USE_KEY[providerName]),
      usable,
      coreHoursRemaining: extractCoreHoursRemaining(statusObject?.quotas)
    };
  });
}

/**
 * Choose the best eligible candidate.
 *   - codespaces: highest remaining core-hours wins (null counts as 0).
 *   - everything else: first eligible candidate in the given order.
 */
function selectCandidate(candidates, providerName) {
  const eligible = candidates.filter((c) => !c.inUse && c.usable);
  if (eligible.length === 0) return null;

  if (providerName === 'codespaces') {
    let best = null;
    let bestScore = -Infinity;
    for (const candidate of eligible) {
      const score = typeof candidate.coreHoursRemaining === 'number'
        && Number.isFinite(candidate.coreHoursRemaining)
        ? candidate.coreHoursRemaining
        : 0;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best || eligible[0];
  }

  return eligible[0];
}

/**
 * Select the best credential available for a provider.
 *
 * @param {string} providerName - gcs | codesandbox | codespaces
 * @param {object} [options]
 * @param {Array}  [options.candidates] - pre-built candidates (testing / injection)
 * @param {Array}  [options.inUseKeys] - keys currently in use
 * @returns {Promise<object>} selection descriptor
 * @throws {ProviderError} NO_AVAILABLE_CREDENTIAL (409) when nothing is eligible
 */
async function getAvailableCredential(providerName, options = {}) {
  if (!providerName || !SUPPORTED_PROVIDERS.has(providerName)) {
    throw new ProviderError(
      `Invalid provider: "${providerName}". Must be one of: ${[...SUPPORTED_PROVIDERS].join(', ')}`,
      { code: 'VPS_INVALID_PROVIDER', statusCode: 400 }
    );
  }

  const {
    candidates: injectedCandidates = null,
    inUseKeys: injectedInUseKeys = null
  } = options;

  let candidates = injectedCandidates;
  if (!candidates) {
    candidates = await listDbCandidates(providerName);
  }

  const inUseKeys = injectedInUseKeys ? new Set(injectedInUseKeys) : await listInUseKeys(providerName);

  const annotated = annotateCandidates(candidates, providerName, inUseKeys);
  const selected = selectCandidate(annotated, providerName);

  if (annotated.length === 0) {
    throw new ProviderError(
      `No available credential for provider '${providerName}'`,
      {
        code: NO_AVAILABLE_CREDENTIAL,
        statusCode: 409,
        details: {
          provider: providerName,
          reason: NO_REGISTERED_CREDENTIALS,
          considered: 0,
          inUse: 0,
          unusable: 0
        }
      }
    );
  }

  if (!selected) {
    throw new ProviderError(
      `No available credential for provider '${providerName}'`,
      {
        code: NO_AVAILABLE_CREDENTIAL,
        statusCode: 409,
        details: {
          provider: providerName,
          reason: ALL_IN_USE_OR_UNUSABLE,
          considered: annotated.length,
          inUse: annotated.filter((c) => c.inUse).length,
          unusable: annotated.filter((c) => !c.usable).length
        }
      }
    );
  }

  return {
    provider: providerName,
    strategy: providerName === 'codespaces' ? 'max-core-hours' : 'first-available',
    credentialRef: selected.credentialRef,
    credential: selected.displayName || selected.credentialRef,
    credentialFingerprint: selected.credentialFingerprint || null,
    status: selected.status,
    statusCheckedAt: selected.statusCheckedAt || null,
    inUse: selected.inUse,
    inUseKnown: selected.inUseKnown,
    coreHoursRemaining: selected.coreHoursRemaining
  };
}

module.exports = {
  getAvailableCredential,
  // exported for testing
  listDbCandidates,
  listInUseKeys,
  annotateCandidates,
  selectCandidate,
  extractCoreHoursRemaining,
  isComputeQuota,
  isUsableStatus,
  asStatusObject,
  NO_AVAILABLE_CREDENTIAL,
  NO_REGISTERED_CREDENTIALS,
  ALL_IN_USE_OR_UNUSABLE,
  IN_USE_KEY,
  UNUSABLE_STATUSES,
  SUPPORTED_PROVIDERS
};
