const { ProviderError } = require('../../errors/provider-errors');
const {
  DEFAULT_TTL_MS,
  getCachedCodespace,
  putCachedCodespace,
  invalidateCodespace
} = require('./read-cache');

const BASE_URL = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const RATE_LIMIT_ERROR_CODE = 'CODESPACES_RATE_LIMIT_EXCEEDED';
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const MAX_RETRIES = RETRY_DELAYS_MS.length;

function shouldRetry(status) {
  // Retry on 429 (rate limit) and transient 5xx (GitHub infrastructure blips).
  // Do not retry 4xx auth/not-found — they will not resolve on retry.
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Compute the delay to wait before the next retry attempt.
 * Respects the Retry-After header when GitHub provides it (seconds or HTTP date).
 * Falls back to exponential backoff from RETRY_DELAYS_MS.
 */
function retryDelayMs(res, attempt) {
  const retryAfter = res?.headers?.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, 60_000); // cap at 60s
    }
    // HTTP-date format
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      const wait = date - Date.now();
      if (wait > 0) return Math.min(wait, 60_000);
    }
  }
  return RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION
  };
}

async function parseResponseBody(res) {
  const text = await res.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

function isRateLimited(res) {
  return res.headers.get('x-ratelimit-remaining') === '0';
}

function buildError(res, body) {
  const statusCode = res.status;

  if (statusCode === 401) {
    return new ProviderError('GitHub token is invalid or expired', {
      code: 'CODESPACES_TOKEN_INVALID',
      statusCode: 401
    });
  }

  if (statusCode === 403) {
    if (isRateLimited(res)) {
      return new ProviderError('GitHub API rate limit exceeded', {
        code: RATE_LIMIT_ERROR_CODE,
        statusCode: 429
      });
    }

    // Surface the real GitHub message (e.g. "Sorry. Your account was suspended")
    // rather than always blaming scope. Fall back to the scope message only when
    // GitHub gives no body message of its own.
    const githubMessage = body && typeof body === 'object' && body.message
      ? body.message
      : typeof body === 'string' && body.trim()
        ? body.trim()
        : null;

    if (githubMessage && /suspend/i.test(githubMessage)) {
      return new ProviderError(`GitHub account is suspended: ${githubMessage}`, {
        code: 'CODESPACES_ACCOUNT_SUSPENDED',
        statusCode: 403
      });
    }

    return new ProviderError(
      githubMessage || 'GitHub token lacks the required codespace scope',
      {
        code: 'CODESPACES_TOKEN_INSUFFICIENT_SCOPE',
        statusCode: 403
      }
    );
  }

  if (statusCode === 402) {
    // Billing issue — quota exhausted or payment required.
    // GitHub returns the reason in body.message (e.g. "There is a billing issue
    // that is preventing you from starting this codespace.")
    const billingMessage = body && typeof body === 'object' && body.message
      ? body.message
      : typeof body === 'string' && body.trim()
        ? body.trim()
        : 'Codespace cannot be started due to a billing issue on the GitHub account';

    return new ProviderError(billingMessage, {
      code: 'CODESPACES_BILLING_ERROR',
      statusCode: 402
    });
  }

  if (statusCode === 404) {
    return new ProviderError('Codespace not found', {
      code: 'CODESPACES_NOT_FOUND',
      statusCode: 404
    });
  }

  if (statusCode === 429) {
    return new ProviderError('GitHub API rate limit exceeded', {
      code: RATE_LIMIT_ERROR_CODE,
      statusCode: 429
    });
  }

  const message = body && typeof body === 'object' && body.message
    ? body.message
    : `GitHub API request failed with status ${statusCode}`;

  return new ProviderError(message, {
    code: 'CODESPACES_API_ERROR',
    statusCode: statusCode || 502
  });
}

async function githubGet(path, token, attempt = 1) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: githubHeaders(token)
  });

  if (shouldRetry(res.status) && attempt <= MAX_RETRIES) {
    const delay = retryDelayMs(res, attempt);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return githubGet(path, token, attempt + 1);
  }

  const body = await parseResponseBody(res);

  if (!res.ok) {
    throw buildError(res, body);
  }

  return body;
}

async function githubRequest(method, path, token, body, attempt = 1) {
  const options = {
    method,
    headers: githubHeaders(token)
  };

  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const res = await fetch(`${BASE_URL}${path}`, options);

  // Retry transient 5xx and 429 for mutating requests too.
  // Safe because Codespaces start/stop are idempotent: starting an already
  // running codespace or stopping an already stopped one is a no-op on GitHub's
  // side. DELETE is also safe to retry — a 404 on the second attempt is caught
  // downstream as CODESPACES_NOT_FOUND and ignored.
  if (shouldRetry(res.status) && attempt <= MAX_RETRIES) {
    const delay = retryDelayMs(res, attempt);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return githubRequest(method, path, token, body, attempt + 1);
  }

  const bodyText = await parseResponseBody(res);

  if (!res.ok) {
    throw buildError(res, bodyText);
  }

  return { status: res.status, body: bodyText };
}

async function createCodespace(token, params) {
  const result = await githubRequest('POST', '/user/codespaces', token, params);

  // The GitHub API contract accepts 201 (created) or 202 (accepted). Reject
  // any other 2xx so a future API shape change surfaces as an explicit error.
  if (result.status !== 201 && result.status !== 202) {
    throw new ProviderError('Codespace creation returned an unexpected status', {
      code: 'CODESPACES_API_ERROR',
      statusCode: result.status || 502
    });
  }

  // The new codespace has no cached entry yet, but clear any residual entry
  // for the returned name in case of reuse.
  if (result.body?.name) {
    invalidateCodespace(token, result.body.name);
  }

  return result.body;
}

/**
 * Fetch a codespace, optionally serving a cached value.
 *
 * Reads are the dominant GitHub API cost for a session (idle polling and
 * keep-alive both call this). Successful reads are cached in-process for
 * `DEFAULT_TTL_MS`; callers that need fresh state for control-flow decisions
 * (boot polling, immediately after a write) pass `{ nocache: true }`.
 *
 * Errors and rate-limit responses are never cached, so a stalled token still
 * surfaces the real error on every call.
 *
 * @param {string} token
 * @param {string} name - codespace name
 * @param {{ nocache?: boolean, ttlMs?: number }} [options]
 */
async function getCodespace(token, name, options = {}) {
  if (!options.nocache) {
    const cached = getCachedCodespace(token, name);
    if (cached) {
      return cached;
    }
  }

  const codespace = await githubGet(`/user/codespaces/${encodeURIComponent(name)}`, token);
  putCachedCodespace(token, name, codespace, options.ttlMs || DEFAULT_TTL_MS);
  return codespace;
}

async function deleteCodespace(token, name) {
  try {
    await githubRequest('DELETE', `/user/codespaces/${encodeURIComponent(name)}`, token);
  } catch (error) {
    if (error.code === 'CODESPACES_NOT_FOUND') {
      return;
    }
    throw error;
  } finally {
    invalidateCodespace(token, name);
  }
}

async function startCodespace(token, name) {
  const result = await githubRequest('POST', `/user/codespaces/${encodeURIComponent(name)}/start`, token);
  invalidateCodespace(token, name);
  return result.body;
}

async function validateToken(token) {
  return githubGet('/user', token);
}

/**
 * Daily billing summary for one account + day.
 * The endpoint REQUIRES year/month/day query params — it returns a single
 * day's usage, never month-to-date. Callers that omit the date get today's
 * UTC date (still a single day); use getMonthlyCodespacesUsage for the
 * month-to-date total.
 */
async function getBillingUsageSummary(token, login, { year, month, day } = {}) {
  const now = new Date();
  const y = year ?? now.getUTCFullYear();
  const m = month ?? now.getUTCMonth() + 1;
  const d = day ?? now.getUTCDate();
  const qs = `year=${encodeURIComponent(y)}&month=${encodeURIComponent(m)}&day=${encodeURIComponent(d)}`;
  return githubGet(`/users/${encodeURIComponent(login)}/settings/billing/usage/summary?${qs}`, token);
}

/**
 * Month-to-date billing report for one account.
 * Unlike the daily summary above, this endpoint takes only year+month and
 * returns the whole month in a single call.
 */
async function getBillingUsageReport(token, login, { year, month } = {}) {
  const now = new Date();
  const y = year ?? now.getUTCFullYear();
  const m = month ?? now.getUTCMonth() + 1;
  const qs = `year=${encodeURIComponent(y)}&month=${encodeURIComponent(m)}`;
  return githubGet(`/users/${encodeURIComponent(login)}/settings/billing/usage?${qs}`, token);
}

/**
 * Month-to-date usageItems for the current UTC month.
 * Prefers the single-call usage report; falls back to aggregating one daily
 * summary per day (1..today) when the report endpoint is unavailable for the
 * token (e.g. older scopes returning 404). Returns `{ usageItems: [...] }`
 * in both paths so callers parse a single shape.
 */
async function getMonthlyCodespacesUsage(token, login, { now = new Date(), concurrency = 4 } = {}) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  try {
    const report = await getBillingUsageReport(token, login, { year, month });
    const items = Array.isArray(report?.usageItems) ? report.usageItems : Array.isArray(report) ? report : [];
    return { usageItems: items, billingSource: 'usage-report', billingPeriod: `${year}-${String(month).padStart(2, '0')}` };
  } catch (reportError) {
    // Only fall back when the report endpoint itself is unavailable for this
    // token (404/403). Auth errors and rate limits must surface, not be
    // hidden behind a partial daily aggregation.
    const retriable = reportError?.statusCode === 404 || reportError?.statusCode === 403;
    if (!retriable) {
      throw reportError;
    }
    const lastError = reportError;

    const today = now.getUTCDate();
    const days = Array.from({ length: today }, (_, i) => i + 1);
    const merged = [];
    // Bounded concurrency so a 31-day month does not fan out 31 requests.
    for (let i = 0; i < days.length; i += concurrency) {
      const chunk = days.slice(i, i + concurrency);
      const results = await Promise.all(
        chunk.map((day) => getBillingUsageSummary(token, login, { year, month, day }).catch(() => null))
      );
      for (const body of results) {
        if (!body) continue;
        const items = Array.isArray(body?.usageItems) ? body.usageItems : Array.isArray(body) ? body : [];
        merged.push(...items);
      }
    }

    if (merged.length === 0) {
      throw lastError;
    }
    return { usageItems: merged, billingSource: 'daily-summary-fallback', billingPeriod: `${year}-${String(month).padStart(2, '0')}` };
  }
}

/**
 * List codespaces for the authenticated account.
 * @param {string} token
 * @returns {Promise<Array>} array of codespace objects
 */
async function listCodespaces(token) {
  const body = await githubGet('/user/codespaces', token);
  return Array.isArray(body?.codespaces) ? body.codespaces : [];
}

/**
 * Stop a codespace without deleting it.
 * @param {string} token
 * @param {string} name
 * @returns {Promise<object>} stopped codespace object
 */
async function stopCodespace(token, name) {
  const result = await githubRequest('POST', `/user/codespaces/${encodeURIComponent(name)}/stop`, token);
  invalidateCodespace(token, name);
  return result.body;
}

module.exports = {
  BASE_URL,
  API_VERSION,
  createCodespace,
  listCodespaces,
  getCodespace,
  deleteCodespace,
  startCodespace,
  stopCodespace,
  validateToken,
  getBillingUsageSummary,
  getBillingUsageReport,
  getMonthlyCodespacesUsage,
  invalidateCodespace
};
