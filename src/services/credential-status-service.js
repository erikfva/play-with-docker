const crypto = require('crypto');
const { getProvider } = require('./provider-factory');
const { ProviderError } = require('./errors/provider-errors');
const db = require('../db/db');
const { listAvailableCredentials } = require('./credentials-lister');
const { cacheKey, getOrCheckStatus } = require('./status-cache');
const { initGoogleCredentialsFromS3IfNeeded } = require('./google-credentials-loader');
const { loadCodeSandboxCredentials } = require('./providers/codesandbox/credentials-loader');
const { loadCodespacesCredentials } = require('./providers/codespaces/credentials-loader');

const PROVIDER_PREFIXES = {
  gcs: 'gcloud',
  codesandbox: 'codesandbox',
  codespaces: 'codespaces'
};

const ENFORCES_TOKEN_UNIQUENESS = new Set(['codesandbox', 'codespaces']);

const LOADERS = {
  gcs: async (ref) => ({
    credentialsPath: await initGoogleCredentialsFromS3IfNeeded(ref),
    credentialRef: ref,
    credentialFingerprint: `sha256:${crypto.createHash('sha256').update(ref).digest('hex')}`
  }),
  codesandbox: (ref) => loadCodeSandboxCredentials(ref),
  codespaces: (ref) => loadCodespacesCredentials(ref)
};

function limitation(field, reason) { return { field, reason }; }

function quotaEntry({ quotaUnit, quotaPeriod, usage = null, limit = null, remaining = null, extra = {} }) {
  return { quotaUnit, quotaPeriod, usage, limit, remaining, ...extra };
}

function redactTokensFromMessage(msg) {
  return String(msg || '').replace(/\b[A-Za-z0-9_\-]{20,}\b/g, '[REDACTED]');
}

function buildEntry({ provider, credentialRef, displayName, fingerprint }) {
  return {
    provider,
    credential: displayName || credentialRef,
    credentialFingerprint: fingerprint || null,
    status: 'UNKNOWN',
    checkedAt: new Date().toISOString(),
    expiresAt: null,
    quotas: [],
    details: { validated: false, limitations: [] }
  };
}

function buildUnknownEntry(raw, error) {
  const entry = buildEntry({
    provider: raw.provider || null,
    credentialRef: raw.credentialRef || null,
    displayName: raw.displayName || null,
    fingerprint: raw.credentialFingerprint || null
  });
  if (error) {
    entry.details.errorCode = error.code || null;
    entry.details.errorMessage = 'Credential status could not be determined.';
  }
  return entry;
}

const PRECEDENCE = [
  'INVALID', 'EXPIRED', 'QUOTA_EXHAUSTED', 'UNAVAILABLE', 'LIMITED', 'AVAILABLE'
];

function resolveStatus(candidates) {
  return PRECEDENCE.find((s) => candidates.includes(s)) || 'UNKNOWN';
}

async function countActiveSessions(dbInstance, provider, fingerprint) {
  if (provider === 'gcs') return null;
  if (!fingerprint) return 0;

  const TERMINAL_SETS = {
    codesandbox: ['TERMINATED', 'DELETED', 'FAILED'],
    codespaces: ['TERMINATED', 'FAILED']
  };
  const terminalStatuses = TERMINAL_SETS[provider] || ['TERMINATED', 'DELETED', 'FAILED'];
  const placeholders = terminalStatuses.map(() => '?').join(', ');
  const sql = `
    SELECT COUNT(*)::int AS count FROM sessions
    WHERE provider = ?
      AND credentialFingerprint = ?
      AND COALESCE(status, '') NOT IN (${placeholders})
  `;
  const row = await dbInstance.get(sql, [provider, fingerprint, ...terminalStatuses]);
  return row?.count ?? 0;
}

async function loadForStatus(providerName, credentialRef) {
  if (!credentialRef) {
    throw new ProviderError(
      'credentialRef query parameter is required',
      { code: 'CREDENTIAL_REF_REQUIRED', statusCode: 400 }
    );
  }
  const loader = LOADERS[providerName];
  if (!loader) {
    throw new ProviderError(
      `Provider '${providerName}' does not support credential status checks`,
      { code: 'CREDENTIAL_STATUS_UNSUPPORTED', statusCode: 404 }
    );
  }
  return loader(credentialRef);
}

async function finalizeEntry(providerName, raw, checkerResult) {
  const localCount = await countActiveSessions(
    db,
    providerName,
    raw.credentialFingerprint
  );

  const candidates = [checkerResult.status];
  if (localCount > 0 && ENFORCES_TOKEN_UNIQUENESS.has(providerName)) {
    candidates.push('LIMITED');
  }

  const limitations = [...(checkerResult.limitations ?? [])];
  if (providerName === 'gcs') {
    limitations.push(limitation(
      'details.localActiveSessions',
      'Local active-session count is unavailable for GCS because existing session rows do not persist a canonical credential identity. GCS has no credential uniqueness constraint, so this does not affect availability.'
    ));
  }

  const entry = buildEntry({
    provider: providerName,
    credentialRef: raw.credentialRef,
    displayName: raw.displayName,
    fingerprint: raw.credentialFingerprint
  });

  entry.status = resolveStatus(candidates);
  entry.checkedAt = new Date().toISOString();
  entry.expiresAt = checkerResult.expiresAt ?? null;
  entry.quotas = checkerResult.quotas ?? [];
  entry.details = {
    ...(checkerResult.details ?? {}),
    validated: checkerResult.validated ?? false,
    limitations,
    localActiveSessions: localCount
  };

  return entry;
}

async function getCredentialStatus(providerName, { credentialRef, displayName } = {}) {
  const SUPPORTED_FOR_STATUS = new Set(['gcs', 'codesandbox', 'codespaces']);
  if (!SUPPORTED_FOR_STATUS.has(providerName)) {
    throw new ProviderError(
      `Provider '${providerName}' does not support credential status checks`,
      { code: 'CREDENTIAL_STATUS_UNSUPPORTED', statusCode: 404 }
    );
  }

  const provider = getProvider(providerName);
  if (typeof provider.getCredentialStatus !== 'function') {
    throw new ProviderError(
      `Provider ${providerName} does not support credential status`,
      { code: 'CREDENTIAL_STATUS_UNSUPPORTED', statusCode: 400 }
    );
  }

  let raw;
  try {
    raw = await loadForStatus(providerName, credentialRef);
    raw.displayName = displayName || null;
  } catch (loadError) {
    return buildUnknownEntry(
      { provider: providerName, credentialRef, displayName, credentialFingerprint: null },
      loadError
    );
  }

  const key = raw.credentialFingerprint
    ? cacheKey(providerName, raw.credentialFingerprint)
    : null;

  let result;
  try {
    result = key
      ? await getOrCheckStatus(key, () => provider.getCredentialStatus(raw))
      : await provider.getCredentialStatus(raw);
  } catch (error) {
    return buildUnknownEntry(raw, error);
  }

  return finalizeEntry(providerName, raw, result);
}

async function listCredentialStatuses(providerName) {
  const prefix = PROVIDER_PREFIXES[providerName];
  if (!prefix) {
    throw new ProviderError(
      `Provider '${providerName}' does not support credential status checks`,
      { code: 'CREDENTIAL_STATUS_UNSUPPORTED', statusCode: 404 }
    );
  }
  const { credentials, mode } = await listAvailableCredentials(prefix);
  const settled = await mapWithConcurrency(
    credentials,
    4,
    (c) => getCredentialStatus(providerName, { credentialRef: c.key, displayName: c.displayName })
  );
  return {
    provider: providerName,
    mode,
    credentials: settled.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : buildUnknownEntry(
            { provider: providerName, credentialRef: credentials[i].key, displayName: credentials[i].displayName },
            r.reason
          )
    )
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: 'fulfilled', value: await mapper(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}

module.exports = {
  getCredentialStatus,
  listCredentialStatuses,
  // exported for testing
  buildEntry,
  buildUnknownEntry,
  resolveStatus,
  countActiveSessions,
  finalizeEntry,
  limitation,
  quotaEntry,
  redactTokensFromMessage
};
