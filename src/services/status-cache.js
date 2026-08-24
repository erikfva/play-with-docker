function parsePositiveInteger(val, defaultVal) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultVal;
}

const DEFAULT_TTL_MS = parsePositiveInteger(
  process.env.CREDENTIAL_STATUS_CACHE_TTL_MS,
  5 * 60 * 1000
);

const cache = new Map();
const inFlight = new Map();

function cacheKey(provider, credentialFingerprint) {
  return `${provider}:${credentialFingerprint}`;
}

function getCachedStatus(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function putCachedStatus(key, value, ttlMs = DEFAULT_TTL_MS) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/**
 * Return a cached checker result or share one in-progress upstream check.
 * UNKNOWN results and rejected checks are deliberately not cached.
 */
async function getOrCheckStatus(key, checker) {
  const cached = getCachedStatus(key);
  if (cached) return cached;

  let pending = inFlight.get(key);
  if (!pending) {
    pending = Promise.resolve()
      .then(checker)
      .then((result) => {
        if (result?.status !== 'UNKNOWN') putCachedStatus(key, result);
        return result;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

function clearCache() {
  cache.clear();
}

module.exports = { cacheKey, getOrCheckStatus, clearCache, getCachedStatus, putCachedStatus, DEFAULT_TTL_MS };
