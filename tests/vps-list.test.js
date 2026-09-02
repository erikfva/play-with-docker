'use strict';

const assert = require('assert');
const express = require('express');
const { Readable, Writable } = require('stream');
const { test } = require('node:test');

// ---------------------------------------------------------------------------
// Module stub helpers (same pattern as other route tests in this project)
// ---------------------------------------------------------------------------
function stubModule(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports
  };
}

function requestApp(app, method, url, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? JSON.stringify(options.body) : '';
    const req = new Readable({
      read() {
        this.push(body);
        this.push(null);
      }
    });
    req.method = method;
    req.url = url;
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
// Test harness factory
//
// dbStub shape:
//   { countTotal, rows, getRow }
//   countTotal  — number returned by COUNT(*) query
//   rows        — array returned by SELECT list query
//   getRow      — object or null returned by SELECT /:id query
// ---------------------------------------------------------------------------
async function withVpsRouter(dbStub = {}) {
  const { countTotal = 0, rows = [], getRow = null } = dbStub;

  const routePath       = require.resolve('../src/routes/vps');
  const dbPath          = require.resolve('../src/db/db');
  const vpsUtilsPath    = require.resolve('../src/services/vps-credential-utils');
  const dbCredsPath     = require.resolve('../src/services/db-credentials-loader');
  const httpHelpersPath = require.resolve('../src/utils/http-helpers');
  const errorsPath      = require.resolve('../src/services/errors/provider-errors');

  // Fresh require each test
  delete require.cache[routePath];

  // Capture SQL calls for assertion
  const calls = { get: [], all: [] };

  stubModule(dbPath, {
    get: async (sql, params) => {
      calls.get.push({ sql, params });
      // COUNT query
      if (/COUNT\(\*\)/i.test(sql)) return { total: String(countTotal) };
      // Single-row SELECT (GET /:id, POST, PUT)
      return getRow;
    },
    all: async (sql, params) => {
      calls.all.push({ sql, params });
      return rows;
    },
    run:   async () => {},
    pool:  { end: async () => {} },
    ready: Promise.resolve()
  });

  // vps-credential-utils: real validateProvider logic (no DB needed)
  const { ProviderError } = require(errorsPath);
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

  stubModule(dbCredsPath, { loadCredentialByRef: async () => null, invalidateCache: () => {} });

  const router = require('../src/routes/vps');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/vps', router);

  return {
    calls,
    get: (url) => requestApp(app, 'GET', url)
  };
}

// ---------------------------------------------------------------------------
// T-01: Default params — envelope shape with defaults
// ---------------------------------------------------------------------------
test('T-01: default params return {vps, total, limit:20, offset:0} envelope', async () => {
  const { get } = await withVpsRouter({ countTotal: 5, rows: [{ id: 'a' }] });
  const res = await get('/api/v1/vps');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['limit', 'offset', 'total', 'vps']);
  assert.equal(res.body.total, 5);
  assert.equal(res.body.limit, 20);
  assert.equal(res.body.offset, 0);
  assert.deepEqual(res.body.vps, [{ id: 'a' }]);
});

// ---------------------------------------------------------------------------
// T-02: Custom limit and offset reflected in response
// ---------------------------------------------------------------------------
test('T-02: ?limit=5&offset=10 reflected in response envelope', async () => {
  const { get } = await withVpsRouter({ countTotal: 50, rows: [] });
  const res = await get('/api/v1/vps?limit=5&offset=10');
  assert.equal(res.status, 200);
  assert.equal(res.body.limit, 5);
  assert.equal(res.body.offset, 10);
  assert.equal(res.body.total, 50);
});

// ---------------------------------------------------------------------------
// T-03: limit=0 → 400
// ---------------------------------------------------------------------------
test('T-03: ?limit=0 returns 400 VPS_INVALID_PARAM', async () => {
  const { get } = await withVpsRouter();
  const res = await get('/api/v1/vps?limit=0');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VPS_INVALID_PARAM');
});

// ---------------------------------------------------------------------------
// T-04: limit=101 → 400
// ---------------------------------------------------------------------------
test('T-04: ?limit=101 returns 400 VPS_INVALID_PARAM', async () => {
  const { get } = await withVpsRouter();
  const res = await get('/api/v1/vps?limit=101');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VPS_INVALID_PARAM');
});

// ---------------------------------------------------------------------------
// T-05: limit=abc → 400
// ---------------------------------------------------------------------------
test('T-05: ?limit=abc returns 400 VPS_INVALID_PARAM', async () => {
  const { get } = await withVpsRouter();
  const res = await get('/api/v1/vps?limit=abc');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VPS_INVALID_PARAM');
});

// ---------------------------------------------------------------------------
// T-06: offset=-1 → 400
// ---------------------------------------------------------------------------
test('T-06: ?offset=-1 returns 400 VPS_INVALID_PARAM', async () => {
  const { get } = await withVpsRouter();
  const res = await get('/api/v1/vps?offset=-1');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VPS_INVALID_PARAM');
});

// ---------------------------------------------------------------------------
// T-07: sortBy=name&sortOrder=asc — SQL ORDER BY contains name ASC
// ---------------------------------------------------------------------------
test('T-07: ?sortBy=name&sortOrder=asc — SQL contains ORDER BY v.name ASC', async () => {
  const { get, calls } = await withVpsRouter({ countTotal: 0, rows: [] });
  const res = await get('/api/v1/vps?sortBy=name&sortOrder=asc');
  assert.equal(res.status, 200);
  const dataSql = calls.all[0]?.sql || '';
  assert.ok(
    /ORDER BY v\.name ASC/i.test(dataSql),
    `Expected ORDER BY v.name ASC in: ${dataSql}`
  );
});

// ---------------------------------------------------------------------------
// T-08: sortBy=CREATEDAT (uppercase) — accepted
// ---------------------------------------------------------------------------
test('T-08: ?sortBy=CREATEDAT (uppercase) is accepted', async () => {
  const { get } = await withVpsRouter({ countTotal: 0, rows: [] });
  const res = await get('/api/v1/vps?sortBy=CREATEDAT');
  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------------------
// T-09: sortBy=invalid → 400
// ---------------------------------------------------------------------------
test('T-09: ?sortBy=invalid returns 400 VPS_INVALID_PARAM', async () => {
  const { get } = await withVpsRouter();
  const res = await get('/api/v1/vps?sortBy=invalid');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VPS_INVALID_PARAM');
});

// ---------------------------------------------------------------------------
// T-10: sortOrder=sideways → 400
// ---------------------------------------------------------------------------
test('T-10: ?sortOrder=sideways returns 400 VPS_INVALID_PARAM', async () => {
  const { get } = await withVpsRouter();
  const res = await get('/api/v1/vps?sortOrder=sideways');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VPS_INVALID_PARAM');
});

// ---------------------------------------------------------------------------
// T-11: sessionActive=true — EXISTS added to WHERE in both queries
// ---------------------------------------------------------------------------
test('T-11: ?sessionActive=true — EXISTS in WHERE clause of data + count queries', async () => {
  const { get, calls } = await withVpsRouter({ countTotal: 2, rows: [] });
  const res = await get('/api/v1/vps?sessionActive=true');
  assert.equal(res.status, 200);

  const countSql = calls.get[0]?.sql || '';
  const dataSql  = calls.all[0]?.sql || '';
  assert.ok(/EXISTS/i.test(countSql), `COUNT query missing EXISTS: ${countSql}`);
  assert.ok(/EXISTS/i.test(dataSql),  `Data query missing EXISTS: ${dataSql}`);
  assert.ok(!/NOT EXISTS/i.test(countSql), 'COUNT query should not have NOT EXISTS for true');
  assert.ok(!/NOT EXISTS/i.test(dataSql),  'Data query should not have NOT EXISTS for true');
});

// ---------------------------------------------------------------------------
// T-12: sessionActive=false — NOT EXISTS added to WHERE
// ---------------------------------------------------------------------------
test('T-12: ?sessionActive=false — NOT EXISTS in WHERE clause', async () => {
  const { get, calls } = await withVpsRouter({ countTotal: 3, rows: [] });
  const res = await get('/api/v1/vps?sessionActive=false');
  assert.equal(res.status, 200);

  const countSql = calls.get[0]?.sql || '';
  const dataSql  = calls.all[0]?.sql || '';
  assert.ok(/NOT EXISTS/i.test(countSql), `COUNT query missing NOT EXISTS: ${countSql}`);
  assert.ok(/NOT EXISTS/i.test(dataSql),  `Data query missing NOT EXISTS: ${dataSql}`);
});

// ---------------------------------------------------------------------------
// T-13: sessionActive=TRUE (uppercase) — accepted
// ---------------------------------------------------------------------------
test('T-13: ?sessionActive=TRUE (uppercase) is accepted', async () => {
  const { get } = await withVpsRouter({ countTotal: 0, rows: [] });
  const res = await get('/api/v1/vps?sessionActive=TRUE');
  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------------------
// T-14: sessionActive=1 → 400
// ---------------------------------------------------------------------------
test('T-14: ?sessionActive=1 returns 400 VPS_INVALID_PARAM', async () => {
  const { get } = await withVpsRouter();
  const res = await get('/api/v1/vps?sessionActive=1');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VPS_INVALID_PARAM');
});

// ---------------------------------------------------------------------------
// T-15: provider=codespaces — WHERE clause includes provider filter
// ---------------------------------------------------------------------------
test('T-15: ?provider=codespaces — WHERE includes provider bind param', async () => {
  const { get, calls } = await withVpsRouter({ countTotal: 1, rows: [] });
  const res = await get('/api/v1/vps?provider=codespaces');
  assert.equal(res.status, 200);

  const countParams = calls.get[0]?.params || [];
  const dataParams  = calls.all[0]?.params || [];
  assert.ok(countParams.includes('codespaces'), `COUNT params missing codespaces: ${JSON.stringify(countParams)}`);
  assert.ok(dataParams.includes('codespaces'),  `Data params missing codespaces: ${JSON.stringify(dataParams)}`);
});

// ---------------------------------------------------------------------------
// T-16: provider=bad → 400 VPS_INVALID_PARAM (not VPS_INVALID_PROVIDER)
// ---------------------------------------------------------------------------
test('T-16: ?provider=bad returns 400 VPS_INVALID_PARAM (not VPS_INVALID_PROVIDER)', async () => {
  const { get } = await withVpsRouter();
  const res = await get('/api/v1/vps?provider=bad');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VPS_INVALID_PARAM',
    `Expected VPS_INVALID_PARAM, got ${res.body.code}`);
});

// ---------------------------------------------------------------------------
// T-17: Combined filters — provider + sessionActive + sortBy + limit + offset
// ---------------------------------------------------------------------------
test('T-17: combined ?provider=gcs&sessionActive=false&sortBy=name&sortOrder=asc&limit=5&offset=0', async () => {
  const { get, calls } = await withVpsRouter({ countTotal: 7, rows: [] });
  const res = await get('/api/v1/vps?provider=gcs&sessionActive=false&sortBy=name&sortOrder=asc&limit=5&offset=0');
  assert.equal(res.status, 200);
  assert.equal(res.body.limit, 5);
  assert.equal(res.body.offset, 0);
  assert.equal(res.body.total, 7);

  const dataSql = calls.all[0]?.sql || '';
  assert.ok(/NOT EXISTS/i.test(dataSql),         'Data query should have NOT EXISTS');
  assert.ok(/ORDER BY v\.name ASC/i.test(dataSql), 'Data query should ORDER BY v.name ASC');

  const dataParams = calls.all[0]?.params || [];
  assert.ok(dataParams.includes('gcs'), 'Data params should include gcs');
  assert.equal(dataParams[dataParams.length - 2], 5,  'Second-to-last param should be limit=5');
  assert.equal(dataParams[dataParams.length - 1], 0,  'Last param should be offset=0');
});

// ---------------------------------------------------------------------------
// T-18: GET /:id — response includes sessionActive and status fields in SQL
// ---------------------------------------------------------------------------
test('T-18: GET /:id SQL includes sessionActive EXISTS and status columns', async () => {
  const vpsRow = {
    id: 'vps-1', provider: 'gcs', name: 'my-vps',
    credentialFileName: 'key.json', credentialFingerprint: 'sha256:abc',
    status: null, sessionActive: false,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z'
  };
  const { get, calls } = await withVpsRouter({ getRow: vpsRow });
  const res = await get('/api/v1/vps/vps-1');
  assert.equal(res.status, 200);

  const sql = calls.get[0]?.sql || '';
  assert.ok(/EXISTS/i.test(sql),         `GET /:id SQL missing EXISTS: ${sql}`);
  assert.ok(/v\.status/i.test(sql),      `GET /:id SQL missing v.status: ${sql}`);
  assert.ok(/sessionActive/i.test(sql),  `GET /:id SQL missing sessionActive alias: ${sql}`);
});

// ---------------------------------------------------------------------------
// T-19: total reflects filtered count (provider filter reduces total vs unfiltered)
// ---------------------------------------------------------------------------
test('T-19: total reflects filtered count (not global count)', async () => {
  // COUNT returns 3 when ?provider=gcs filter is active
  const { get, calls } = await withVpsRouter({ countTotal: 3, rows: [] });
  const res = await get('/api/v1/vps?provider=gcs');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 3);

  // Confirm the COUNT query also received the provider param (not a global count)
  const countParams = calls.get[0]?.params || [];
  assert.ok(countParams.includes('gcs'), 'COUNT query should be scoped to provider=gcs');
});

// ---------------------------------------------------------------------------
// T-20: sortBy=status → 400 (status is JSONB, not directly sortable)
// ---------------------------------------------------------------------------
test('T-20: ?sortBy=status returns 400 VPS_INVALID_PARAM (JSONB not sortable)', async () => {
  const { get } = await withVpsRouter();
  const res = await get('/api/v1/vps?sortBy=status');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VPS_INVALID_PARAM');
});
