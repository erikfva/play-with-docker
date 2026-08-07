const crypto = require('crypto');

/**
 * Minimal in-process TTL cache for Codespaces API reads.
 *
 * Purpose: reading Codespaces status is the dominant GitHub API cost for a
 * session — the UI polls the backend, and each idle poll triggers a
 * `getCodespace` GitHub call per session. These reads are cheap to serve stale
 * because Codespaces has long, provider-managed hibernation intervals, so a
 * short-lived cache cuts GitHub quota consumption substantially without
 * meaningfully affecting freshness.
 *
 * Keyed by a fingerprint of the token combined with the codespace name, so
 * different credentials never share cache entries. Only successful reads are
 * cached; errors and rate-limit responses are never stored.
 */

const DEFAULT_TTL_MS = 30_000;

const store = new Map();

function fingerprintToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function cacheKey(token, name) {
  return `${fingerprintToken(token)}|${name}`;
}

/**
 * Read a cached codespace payload if it is still within the TTL.
 * @param {string} token
 * @param {string} name
 * @returns {object|null} cached value, or null when absent or expired
 */
function getCachedCodespace(token, name) {
  const key = cacheKey(token, name);
  const entry = store.get(key);
  if (!entry) {
    return null;
  }

  const now = Date.now();
  if (now - entry.cachedAt >= entry.ttlMs) {
    store.delete(key);
    return null;
  }

  return entry.value;
}

/**
 * Store a successful codespace read, replacing any prior entry.
 * @param {string} token
 * @param {string} name
 * @param {object} value - the codespace object returned by GitHub
 * @param {number} [ttlMs] - cache lifetime in ms
 */
function putCachedCodespace(token, name, value, ttlMs = DEFAULT_TTL_MS) {
  const key = cacheKey(token, name);
  store.set(key, {
    value,
    ttlMs,
    cachedAt: Date.now()
  });
}

/**
 * Remove any cached codespace for this token+name. Called whenever the
 * codespace state changes (create, start, delete) so the next read refetches.
 * @param {string} token
 * @param {string} name
 */
function invalidateCodespace(token, name) {
  if (!name) {
    return;
  }
  store.delete(cacheKey(token, name));
}

/**
 * Clear the entire cache. Intended for tests and restart boundaries.
 */
function clearCache() {
  store.clear();
}

module.exports = {
  DEFAULT_TTL_MS,
  getCachedCodespace,
  putCachedCodespace,
  invalidateCodespace,
  clearCache
};