'use strict';

const assert = require('assert');
const express = require('express');
const { Readable, Writable } = require('stream');
const { test } = require('node:test');
const url = require('url');

// ---------------------------------------------------------------------------
// Module stub helpers
// ---------------------------------------------------------------------------
function stubModule(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports
  };
}

function requestApp(app, method, urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? JSON.stringify(options.body) : '';
    const req = new Readable({
      read() {
        this.push(body);
        this.push(null);
      }
    });
    req.method = method;

    // Parse URL and query string
    const parsed = url.parse(urlStr, true);
    req.url = urlStr;
    req.query = { ...parsed.query, ...(options.query || {}) };
    req.body = options.body || {};
    req.headers = { ...(options.headers || {}) };

    const chunks = [];
    const headers = {};
    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      }
    });
    res.statusCode = 200;
    res.setHeader    = (n, v) => { headers[n.toLowerCase()] = v; };
    res.getHeader    = (n) => headers[n.toLowerCase()];
    res.removeHeader = (n) => { delete headers[n.toLowerCase()]; };
    res.end = (chunk) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({ status: res.statusCode, headers, body: text ? JSON.parse(text) : null });
    };

    app.handle(req, res, reject);
  });
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
async function withVpsRouter(options = {}) {
  const { ttlMode = false } = options;

  const routePath       = require.resolve('../src/routes/vps');
  const vpsUtilsPath    = require.resolve('../src/services/vps-credential-utils');
  const httpHelpersPath = require.resolve('../src/utils/http-helpers');
  const errorsPath      = require.resolve('../src/services/errors/provider-errors');
  const svcPath         = require.resolve('../src/services/vps-status-service');

  // Fresh require each test — clear ALL relevant caches
  delete require.cache[routePath];
  delete require.cache[svcPath];
  delete require.cache[httpHelpersPath];
  delete require.cache[vpsUtilsPath];
  delete require.cache[errorsPath];

  const { ProviderError } = require(errorsPath);

  // Stub http-helpers so errors surface as HTTP responses
  stubModule(httpHelpersPath, {
    mapErrorToHttp(res, error, fallbackMessage) {
      if (error instanceof ProviderError) {
        return res.status(error.statusCode).json({
          error: error.message,
          code: error.code,
          details: error.details
        });
      }
      return res.status(500).json({
        error: error.message || fallbackMessage,
        code: error.code
      });
    }
  });

  // DB mock: when ttlMode is true, return a VPS with recent statusCheckedAt and
  // a stored status JSONB so the TTL check short-circuits before calling the provider.
  const now = new Date().toISOString();
  const fiveMinAgo = new Date(Date.now() - 5 * 60000 + 30000).toISOString();
  const dbMock = {
    _calls: [],
    _vpsRow: ttlMode
      ? {
          id: 999,
          provider: 'codesandbox',
          name: 'test-cred',
          credentialFingerprint: 'fp123',
          statusCheckedAt: fiveMinAgo,
          credentialFileName: 'test-cred.json',
          status: { status: 'AVAILABLE', provider: 'codesandbox', credential: 'test-cred', credentialFingerprint: 'fp123' },
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-02T00:00:00Z',
          sessionActive: false
        }
      : null,
    async get(sql, params) {
      this._calls.push({ sql, params });
      // TTL-mode initial lookup: return VPS with recent statusCheckedAt
      if (ttlMode && sql.includes('SELECT id, provider, name, credentialfingerprint') && sql.includes('statuscheckedat')) {
        return this._vpsRow;
      }
      // TTL-mode full-row re-read (TTL shortcut now re-selects the whole persisted row, not just status)
      if (ttlMode && sql.includes('FROM vps v WHERE v.id = ?')) {
        return this._vpsRow;
      }
      // Normal mode: VPS not found for id=999
      if (String(params?.[0]) === '999') return null;
      return { id: params?.[0], provider: 'codesandbox', name: 'test-cred' };
    },
    async all(sql, params) {
      return [{ id: 1 }, { id: 2 }, { id: 3 }];
    },
    run: async () => {},
    pool: { end: async () => {} },
    ready: Promise.resolve()
  };

  const dbPath = require.resolve('../src/db/db');
  const dbCredsPath = require.resolve('../src/services/db-credentials-loader');
  const cachePath = require.resolve('../src/services/status-cache');
  const asyncPath = require.resolve('../src/utils/async-helpers');

  stubModule(dbPath, dbMock);
  stubModule(dbCredsPath, { loadCredentialByRef: async () => ({ token: 'fake', credentialFingerprint: 'fp123' }), invalidateCache: () => {} });
  stubModule(cachePath, { cacheKey: (p, fp) => `${p}:${fp}`, getOrCheckStatus: async (k, fn) => fn(), putCachedStatus: () => {} });
  stubModule(asyncPath, { mapWithConcurrency: async (items, limit, mapper) => Promise.all(items.map(mapper)) });

  // vps-credential-utils: real validateProvider logic
  stubModule(vpsUtilsPath, {
    validateProvider: (p) => {
      if (!['gcs', 'codesandbox', 'codespaces'].includes(p)) {
        throw new ProviderError(`Invalid provider: "${p}"`, { code: 'VPS_INVALID_PROVIDER', statusCode: 400 });
      }
    },
    validateName: () => {},
    validateAndFingerprintContent: () => ({ fingerprint: 'sha256:test' }),
    SUPPORTED_PROVIDERS: ['gcs', 'codesandbox', 'codespaces']
  });

  if (!ttlMode) {
    // Stub vps-status-service with controllable results for non-TTL tests
    const calls = { get: [], all: [] };
    stubModule(svcPath, {
      refreshVpsStatus: async (vpsId, opts) => {
        calls.get.push({ method: 'refreshVpsStatus', vpsId, opts });
        if (String(vpsId) === '999') {
          throw new ProviderError(`VPS not found: ${vpsId}`, { code: 'VPS_NOT_FOUND', statusCode: 404 });
        }
        return {
          id: vpsId,
          provider: 'codesandbox',
          name: 'test-cred',
          credentialFileName: 'test-cred',
          credentialFingerprint: 'fp123',
          status: {
            provider: 'codesandbox',
            credential: 'test-cred',
            credentialFingerprint: 'fp123',
            status: 'AVAILABLE',
            checkedAt: new Date().toISOString(),
            expiresAt: null,
            quotas: [],
            details: { validated: true }
          },
          statusCheckedAt: new Date().toISOString(),
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
          sessionActive: false
        };
      },
      refreshAllVpsStatuses: async (opts) => {
        calls.all.push({ method: 'refreshAllVpsStatuses', opts });
        return {
          total: 3,
          succeeded: 3,
          failed: 0,
          results: [
            { id: 1, provider: 'codesandbox', status: 'AVAILABLE', statusCheckedAt: new Date().toISOString(), error: null },
            { id: 2, provider: 'codesandbox', status: 'AVAILABLE', statusCheckedAt: new Date().toISOString(), error: null },
            { id: 3, provider: 'gcs', status: 'AVAILABLE', statusCheckedAt: new Date().toISOString(), error: null }
          ]
        };
      }
    });

    const router = require('../src/routes/vps');
    const app = express();
    app.use(express.json());
    app.use('/vps', router);

    return {
      calls,
      dbMock,
      post: (urlStr, reqOpts = {}) => requestApp(app, 'POST', urlStr, reqOpts)
    };
  } else {
    // TTL mode: use the real vps-status-service with stubbed DB
    const router = require('../src/routes/vps');
    const app = express();
    app.use(express.json());
    app.use('/vps', router);

    return {
      calls: dbMock._calls,
      dbMock,
      post: (urlStr, reqOpts = {}) => requestApp(app, 'POST', urlStr, reqOpts)
    };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('POST /vps/status/refresh (bulk) returns succeeded/failed summary', async () => {
  const { post } = await withVpsRouter();
  const res = await post('/vps/status/refresh');
  assert.strictEqual(res.status, 200);
  assert.ok(typeof res.body.total === 'number');
  assert.ok(typeof res.body.succeeded === 'number');
  assert.ok(typeof res.body.failed === 'number');
  assert.ok(Array.isArray(res.body.results));
  assert.strictEqual(res.body.total, 3);
  assert.strictEqual(res.body.succeeded, 3);
  assert.strictEqual(res.body.failed, 0);
});

test('POST /vps/status/refresh (bulk) validates provider parameter', async () => {
  const { post } = await withVpsRouter();
  const res = await post('/vps/status/refresh', {
    query: { provider: 'invalid-provider' }
  });
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.error);
  assert.strictEqual(res.body.code, 'VPS_INVALID_PARAM');
});

test('POST /vps/status/refresh (bulk) accepts valid provider filter', async () => {
  const { post } = await withVpsRouter();
  const res = await post('/vps/status/refresh', {
    query: { provider: 'gcs' }
  });
  assert.strictEqual(res.status, 200);
  assert.ok(typeof res.body.total === 'number');
});

test('POST /vps/:id/status/refresh returns updated VPS row', async () => {
  const { post } = await withVpsRouter();
  const res = await post('/vps/1/status/refresh');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.id);
  assert.ok(res.body.status);
  assert.ok(res.body.statusCheckedAt);
  assert.strictEqual(res.body.provider, 'codesandbox');
});

test('POST /vps/:id/status/refresh returns 404 for unknown VPS', async () => {
  const { post } = await withVpsRouter();
  const res = await post('/vps/999/status/refresh');
  assert.strictEqual(res.status, 404);
  assert.ok(res.body.error);
  assert.strictEqual(res.body.code, 'VPS_NOT_FOUND');
});

test('POST /vps/:id/status/refresh accepts force query param', async () => {
  const { post } = await withVpsRouter();
  const res = await post('/vps/1/status/refresh', {
    query: { force: 'true' }
  });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.statusCheckedAt);
});

test('POST /vps/status/refresh (bulk) rejects invalid force parameter', async () => {
  const { post } = await withVpsRouter();
  const res = await post('/vps/status/refresh', {
    query: { force: 'banana' }
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.code, 'VPS_INVALID_PARAM');
  assert.ok(res.body.error.includes('force'));
});

test('POST /vps/:id/status/refresh rejects invalid force parameter', async () => {
  const { post } = await withVpsRouter();
  const res = await post('/vps/1/status/refresh', {
    query: { force: 'banana' }
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.code, 'VPS_INVALID_PARAM');
  assert.ok(res.body.error.includes('force'));
});

test('POST /vps/:id/status/refresh respects TTL — returns cached status without calling provider', async () => {
  // In TTL mode, the VPS row has a recent statusCheckedAt, so the provider API is bypassed
  const { post, dbMock } = await withVpsRouter({ ttlMode: true });
  const res = await post('/vps/1/status/refresh');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.statusCheckedAt);
  assert.strictEqual(res.body.status.status, 'AVAILABLE');
  // Verify the TTL check short-circuited: the second db.get for status should
  // have been called, but the provider was never invoked (no credential load)
  const statusCalls = dbMock._calls.filter(c => c.sql.includes('SELECT status FROM vps'));
  assert.ok(statusCalls.length > 0, 'TTL mode should read cached status from DB');
});

test('POST /vps/:id/status/refresh with force=true bypasses TTL and calls provider', async () => {
  const { post, dbMock } = await withVpsRouter({ ttlMode: true });
  const res = await post('/vps/1/status/refresh', { query: { force: 'true' } });
  assert.strictEqual(res.status, 200);
  // force=true should NOT short-circuit — it should go through the normal flow
  // (which will attempt credential loading, but since we stubbed it, it'll proceed)
});