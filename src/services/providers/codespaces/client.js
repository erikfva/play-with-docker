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

    return new ProviderError('GitHub token lacks the required codespace scope', {
      code: 'CODESPACES_TOKEN_INSUFFICIENT_SCOPE',
      statusCode: 403
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

  if (res.status === 429 && attempt <= MAX_RETRIES) {
    const delay = RETRY_DELAYS_MS[attempt - 1];
    await new Promise((resolve) => setTimeout(resolve, delay));
    return githubGet(path, token, attempt + 1);
  }

  const body = await parseResponseBody(res);

  if (!res.ok) {
    throw buildError(res, body);
  }

  return body;
}

async function githubRequest(method, path, token, body) {
  const options = {
    method,
    headers: githubHeaders(token)
  };

  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const res = await fetch(`${BASE_URL}${path}`, options);
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
  invalidateCodespace
};
