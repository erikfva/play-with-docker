'use strict';

const db = require('../db/db');
const { loadCredentialByRef } = require('./db-credentials-loader');
const { getProvider } = require('./provider-factory');
const { ProviderError } = require('./errors/provider-errors');
const { mapWithConcurrency } = require('../utils/async-helpers');
const { getOrCheckStatus, putCachedStatus, cacheKey } = require('./status-cache');

const STATUS_TTL_MINUTES = parseInt(process.env.VPS_STATUS_TTL_MINUTES, 10) || 5;

function limitation(field, reason) { return { field, reason }; }

function buildUnknownEntryForVps(provider, name, fingerprint, error) {
  const fp = fingerprint || null;
  return {
    provider,
    credential: name,
    credentialFingerprint: fp,
    status: 'UNKNOWN',
    checkedAt: new Date().toISOString(),
    expiresAt: null,
    quotas: [],
    details: {
      validated: false,
      limitations: [{ field: 'status', reason: 'Credential status could not be determined.' }],
      errorCode: error?.code || null,
      errorMessage: 'Credential status could not be determined.'
    }
  };
}

async function countActiveSessionsForVps(provider, fingerprint) {
  if (provider === 'gcs') return null;
  if (!fingerprint) return 0;
  const TERMINAL_SETS = {
    codesandbox: ['TERMINATED', 'DELETED', 'FAILED'],
    codespaces: ['TERMINATED', 'FAILED']
  };
  const terminalStatuses = TERMINAL_SETS[provider] || ['TERMINATED', 'DELETED', 'FAILED'];
  const placeholders = terminalStatuses.map(() => '?').join(', ');
  const sql = `SELECT COUNT(*)::int AS count FROM sessions WHERE provider = ? AND credentialFingerprint = ? AND COALESCE(status, '') NOT IN (${placeholders})`;
  const row = await db.get(sql, [provider, fingerprint, ...terminalStatuses]);
  return row?.count ?? 0;
}

async function buildLoadedCredential(vpsRow) {
  // Use db-credentials-loader which handles parsing + temp file for gcs
  return loadCredentialByRef(vpsRow.provider, vpsRow.name);
}

async function resolveCheckerResult(providerName, loaded) {
  const provider = getProvider(providerName);
  return provider.getCredentialStatus(loaded);
}

async function finalizeWithLocalState(providerName, rawLoaded, checkerResult) {
  const ENFORCES = new Set(['codesandbox', 'codespaces']);
  const fp = rawLoaded.credentialFingerprint || null;
  const PRECEDENCE = ['INVALID', 'EXPIRED', 'QUOTA_EXHAUSTED', 'UNAVAILABLE', 'LIMITED', 'AVAILABLE'];
  function resolveStatus(cands) { return PRECEDENCE.find(s => cands.includes(s)) || 'UNKNOWN'; }

  const localCount = await countActiveSessionsForVps(providerName, fp);
  const candidates = [checkerResult.status];
  if (localCount > 0 && ENFORCES.has(providerName)) candidates.push('LIMITED');
  const limitations = [...(checkerResult.limitations ?? [])];
  if (providerName === 'gcs') {
    limitations.push(limitation('details.localActiveSessions', 'Local active-session count is unavailable for GCS because existing session rows do not persist a canonical credential identity. GCS has no credential uniqueness constraint, so this does not affect availability.'));
  }
  const entry = {
    provider: providerName,
    credential: rawLoaded.credentialRef || rawLoaded.name || null,
    credentialFingerprint: fp,
    status: resolveStatus(candidates),
    checkedAt: new Date().toISOString(),
    expiresAt: checkerResult.expiresAt ?? null,
    quotas: checkerResult.quotas ?? [],
    details: { ...(checkerResult.details ?? {}), validated: checkerResult.validated ?? false, limitations, localActiveSessions: localCount }
  };
  return entry;
}

async function persistVpsStatus(vpsId, entry) {
  const json = JSON.stringify(entry);
  const row = await db.get(
    `WITH updated AS (
      UPDATE vps
      SET status = ?::jsonb,
          statuscheckedat = CURRENT_TIMESTAMP
      WHERE id = ?
      RETURNING id, provider, name, credentialfilename, credentialfingerprint,
                status, statuscheckedat, createdat, updatedat
    )
    SELECT
      u.id,
      u.provider,
      u.name,
      u.credentialfilename    AS "credentialFileName",
      u.credentialfingerprint AS "credentialFingerprint",
      u.status,
      u.statuscheckedat       AS "statusCheckedAt",
      u.createdat             AS "createdAt",
      u.updatedat             AS "updatedAt",
      EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.credentialfingerprint = u.credentialfingerprint
          AND s.provider = u.provider
          AND COALESCE(s.status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED')
      ) AS "sessionActive"
    FROM updated u`,
    [json, vpsId]
  );
  if (!row) {
    throw new ProviderError(`VPS not found during persist: ${vpsId}`, { code: 'VPS_NOT_FOUND', statusCode: 404 });
  }
  return row;
}

function isWithinTtl(statusCheckedAt, ttlMinutes) {
  if (!statusCheckedAt) return false;
  const lastCheck = new Date(statusCheckedAt);
  const now = new Date();
  const elapsedMinutes = (now - lastCheck) / 60000;
  return elapsedMinutes < ttlMinutes;
}

async function refreshVpsStatus(vpsId, { force = false } = {}) {
  const vpsRow = await db.get('SELECT id, provider, name, credentialfingerprint AS "credentialFingerprint", statuscheckedat AS "statusCheckedAt" FROM vps WHERE id = ?', [vpsId]);
  if (!vpsRow) {
    throw new ProviderError(`VPS not found: ${vpsId}`, { code: 'VPS_NOT_FOUND', statusCode: 404 });
  }
  const providerName = vpsRow.provider;
  const fingerprint = vpsRow['credentialFingerprint'];

  // TTL check: if not forced and last status check is within TTL, return cached status without calling provider API
  if (!force && isWithinTtl(vpsRow['statusCheckedAt'], STATUS_TTL_MINUTES)) {
    // Re-fetch the stored status JSONB from the VPS row
    const statusRow = await db.get('SELECT status FROM vps WHERE id = ?', [vpsId]);
    return {
      id: vpsId,
      provider: providerName,
      name: vpsRow.name,
      credentialFileName: vpsRow.name,
      credentialFingerprint: fingerprint,
      status: statusRow?.status || null,
      statusCheckedAt: vpsRow['statusCheckedAt'],
      createdAt: null,
      updatedAt: null,
      sessionActive: false
    };
  }

  let loaded;
  let entry;
  try {
    loaded = await buildLoadedCredential(vpsRow);
  } catch (loadError) {
    entry = buildUnknownEntryForVps(providerName, vpsRow.name, fingerprint, loadError);
    const persisted = await persistVpsStatus(vpsId, entry);
    return persisted;
  }

  try {
    let checkerResult;
    const key = fingerprint ? cacheKey(providerName, fingerprint) : null;
    if (key && !force) {
      checkerResult = await getOrCheckStatus(key, () => resolveCheckerResult(providerName, loaded));
    } else {
      // force bypass: skip cache read, but write back so subsequent non-forced calls benefit
      checkerResult = await resolveCheckerResult(providerName, loaded);
      if (key && checkerResult?.status !== 'UNKNOWN') {
        putCachedStatus(key, checkerResult);
      }
    }
    entry = await finalizeWithLocalState(providerName, loaded, checkerResult);
  } catch (checkerError) {
    entry = buildUnknownEntryForVps(providerName, vpsRow.name, fingerprint, checkerError);
    // ensure checkedAt reflects now (already set in builder)
  }

  const persisted = await persistVpsStatus(vpsId, entry);
  return persisted;
}

async function refreshAllVpsStatuses({ provider, force = false } = {}) {
  const rows = await db.all(
    'SELECT id FROM vps WHERE (? IS NULL OR provider = ?) ORDER BY createdat DESC, id ASC',
    [provider || null, provider || null]
  );
  const ids = rows.map(r => r.id);
  const total = ids.length;
  if (total === 0) {
    return { total: 0, succeeded: 0, failed: 0, results: [] };
  }

  const settled = await mapWithConcurrency(ids, 4, async (id) => {
    const updated = await refreshVpsStatus(id, { force });
    return updated;
  });

  const results = [];
  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < settled.length; i++) {
    const sid = ids[i];
    const r = settled[i];
    if (r.status === 'fulfilled') {
      const row = r.value;
      // row.status is JSONB object; extract entry.status string cleanly
      const statusStr = typeof row.status === 'object' && row.status !== null ? row.status.status : String(row.status || 'UNKNOWN');
      const isUnknown = statusStr === 'UNKNOWN';
      if (isUnknown) failed++; else succeeded++;
      // fetch provider + statusCheckedAt from row
      results.push({
        id: row.id,
        provider: row.provider,
        status: statusStr,
        statusCheckedAt: row['statusCheckedAt'] || row.statuscheckedat || null,
        error: isUnknown ? { code: row.status?.details?.errorCode || 'UNKNOWN_ERROR', message: row.status?.details?.errorMessage || 'Credential status could not be determined.' } : null
      });
    } else {
      failed++;
      // Try to get provider for this id (best-effort)
      let prov = provider || null;
      try {
        const vpsRow = await db.get('SELECT provider FROM vps WHERE id = ?', [sid]);
        prov = vpsRow?.provider || prov;
      } catch (_) {}
      results.push({
        id: sid,
        provider: prov,
        status: 'UNKNOWN',
        statusCheckedAt: new Date().toISOString(),
        error: { code: r.reason?.code || 'UNKNOWN_ERROR', message: 'Credential status could not be determined.' }
      });
    }
  }

  return { total, succeeded, failed, results };
}

module.exports = { refreshVpsStatus, refreshAllVpsStatuses };
