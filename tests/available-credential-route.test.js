'use strict';

const assert = require('assert');
const express = require('express');
const { Readable, Writable } = require('stream');
const { test } = require('node:test');

// ---------------------------------------------------------------------------
// Same stubbing helpers as tests/vps-list.test.js
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

async function withVpsRouter({ select = null, selectError = null } = {}) {
  const routePath       = require.resolve('../src/routes/vps');
  const dbPath          = require.resolve('../src/db/db');
  const vpsUtilsPath    = require.resolve('../src/services/vps-credential-utils');
  const dbCredsPath     = require.resolve('../src/services/db-credentials-loader');
  const statusPath      = require.resolve('../src/services/vps-status-service');
  const availPath       = require.resolve('../src/services/available-credential-service');

  delete require.cache[routePath];

  stubModule(dbPath, {
    get: async () => null,
    all: async () => [],
    run: async () => {},
    pool: { end: async () => {} },
    ready: Promise.resolve()
  });

  stubModule(vpsUtilsPath, {
    validateProvider: (provider) => {
      if (!['gcs', 'codesandbox', 'codespaces'].includes(provider)) {
        const { ProviderError } = require('../src/services/errors/provider-errors');
        throw new ProviderError(`Invalid provider: "${provider}"`, {
          code: 'VPS_INVALID_PROVIDER',
          statusCode: 400
        });
      }
    },
    validateName: () => {},
    validateAndFingerprintContent: () => ({ fingerprint: 'sha256:test' }),
    SUPPORTED_PROVIDERS: ['gcs', 'codesandbox', 'codespaces']
  });

  stubModule(dbCredsPath, { loadCredentialByRef: async () => null, invalidateCache: () => {} });
  stubModule(statusPath, {
    refreshVpsStatus: async () => null,
    refreshAllVpsStatuses: async () => [],
    mergeCodesandboxBilling: async () => null
  });

  const seen = [];
  stubModule(availPath, {
    getAvailableCredential: async (provider) => {
      seen.push(provider);
      if (selectError) throw selectError;
      return select;
    }
  });

  const router = require('../src/routes/vps');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/vps', router);

  return {
    seen,
    get: (url) => requestApp(app, 'GET', url)
  };
}


// ---------------------------------------------------------------------------
// R-01: 200 with the selection payload
// ---------------------------------------------------------------------------
test('R-01: GET /available-credential?provider=codespaces returns the selection', async () => {
  const selection = {
    provider: 'codespaces',
    strategy: 'max-core-hours',
    credentialRef: 'codespaces/high.json',
    credential: 'high.json',
    credentialFingerprint: 'sha256:high',
    status: 'AVAILABLE',
    inUse: false,
    inUseKnown: true,
    statusCheckedAt: '2026-01-01T00:00:00Z',
    coreHoursRemaining: 75
  };
  const { get, seen } = await withVpsRouter({ select: selection });
  const res = await get('/api/v1/vps/available-credential?provider=codespaces');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, selection);
  assert.deepEqual(seen, ['codespaces']);
});

// ---------------------------------------------------------------------------
// R-02: missing provider → 400 VPS_INVALID_PARAM
// ---------------------------------------------------------------------------
test('R-02: GET /available-credential without provider returns 400', async () => {
  const { get, seen } = await withVpsRouter({ select: {} });
  const res = await get('/api/v1/vps/available-credential');

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VPS_INVALID_PARAM');
  assert.deepEqual(seen, []);
});

// ---------------------------------------------------------------------------
// R-03: invalid provider → 400 VPS_INVALID_PARAM (route-level validation,
//       same code as the other GET routes of this router)
// ---------------------------------------------------------------------------
test('R-03: GET /available-credential?provider=bogus returns 400 VPS_INVALID_PARAM', async () => {
  const { get, seen } = await withVpsRouter({ select: { provider: 'gcs' } });
  const res = await get('/api/v1/vps/available-credential?provider=bogus');

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VPS_INVALID_PARAM');
  // The service is never reached for an unsupported provider.
  assert.deepEqual(seen, []);
});

// ---------------------------------------------------------------------------
// R-04: no eligible credential → 409 NO_AVAILABLE_CREDENTIAL
// ---------------------------------------------------------------------------
test('R-04: GET /available-credential returns 409 when nothing is eligible', async () => {
  const { ProviderError } = require('../src/services/errors/provider-errors');
  const { get } = await withVpsRouter({
    selectError: new ProviderError("No available credential for provider 'codesandbox'", {
      code: 'NO_AVAILABLE_CREDENTIAL',
      statusCode: 409,
      details: { provider: 'codesandbox', considered: 2 }
    })
  });
  const res = await get('/api/v1/vps/available-credential?provider=codesandbox');

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'NO_AVAILABLE_CREDENTIAL');
});

// ---------------------------------------------------------------------------
// R-05: the literal route is not swallowed by GET /:id
// ---------------------------------------------------------------------------
test('R-05: /available-credential is matched before the /:id route', async () => {
  const { get } = await withVpsRouter({ select: { provider: 'gcs' } });
  const res = await get('/api/v1/vps/available-credential?provider=gcs');
  assert.equal(res.status, 200);
  assert.equal(res.body.provider, 'gcs');
});
