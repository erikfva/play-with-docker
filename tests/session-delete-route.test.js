const assert = require('assert');
const express = require('express');
const { Readable, Writable } = require('stream');
const { test } = require('node:test');
const { ProviderError } = require('../src/services/errors/provider-errors');

function stubModule(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports
  };
}

async function withSessionRouter({ row, rows, terminateSession, initGoogleCredentialsFromS3IfNeeded }) {
  const calls = {
    dbRun: [],
    stoppedKeepAlive: []
  };

  const routePath = require.resolve('../src/routes/sessions');
  const dbPath = require.resolve('../src/db/db');
  const providerFactoryPath = require.resolve('../src/services/provider-factory');
  const keepAlivePath = require.resolve('../src/services/keep-alive-service');
  const credentialsListerPath = require.resolve('../src/services/credentials-lister');
  const googleLoaderPath = require.resolve('../src/services/google-credentials-loader');

  delete require.cache[routePath];

  stubModule(dbPath, {
    get: async () => row,
    run: async (sql, params) => {
      calls.dbRun.push({ sql, params });
    },
    all: async () => rows || [],
    pool: { end: async () => undefined },
    ready: Promise.resolve()
  });
  stubModule(providerFactoryPath, {
    getProvider: () => ({ terminateSession }),
    listProviders: () => [],
    normalizeProviderName: (provider) => provider
  });
  stubModule(keepAlivePath, {
    stopKeepAlive: (id) => calls.stoppedKeepAlive.push(id),
    stopAllKeepAlives: () => undefined,
    getKeepAliveStats: () => null,
    startKeepAlive: () => undefined
  });
  stubModule(credentialsListerPath, {
    listAvailableCredentials: async () => ({ credentials: [] })
  });
  stubModule(googleLoaderPath, {
    initGoogleCredentialsFromS3IfNeeded: initGoogleCredentialsFromS3IfNeeded || (async () => undefined)
  });

  const router = require('../src/routes/sessions');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/sessions', router);

  return {
    calls,
    request: (method, url, options) => requestApp(app, method, url, options)
  };
}

function requestApp(app, method, url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = new Readable({
      read() {
        this.push(null);
      }
    });
    req.method = method;
    req.url = url;
    req.headers = options.headers || {};

    const chunks = [];
    const headers = {};
    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      }
    });

    res.statusCode = 200;
    res.setHeader = (name, value) => {
      headers[name.toLowerCase()] = value;
    };
    res.getHeader = (name) => headers[name.toLowerCase()];
    res.removeHeader = (name) => {
      delete headers[name.toLowerCase()];
    };
    res.end = (chunk) => {
      if (chunk) {
        chunks.push(Buffer.from(chunk));
      }
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({
        status: res.statusCode,
        headers,
        body: text ? JSON.parse(text) : null
      });
    };

    app.handle(req, res, reject);
  });
}

test('CodeSandbox delete keeps local row and returns error when provider cleanup fails', async () => {
  const harness = await withSessionRouter({
    row: { id: 'session-1', provider: 'codesandbox' },
    terminateSession: async () => {
      throw new ProviderError('CodeSandbox delete failed', {
        code: 'CODESANDBOX_DELETE_FAILED',
        statusCode: 502
      });
    }
  });

  const response = await harness.request('DELETE', '/api/v1/sessions/session-1');

  assert.equal(response.status, 502);
  assert.equal(response.body.code, 'CODESANDBOX_DELETE_FAILED');
  assert.equal(harness.calls.dbRun.length, 0);
  assert.deepEqual(harness.calls.stoppedKeepAlive, ['session-1']);
});

test('CodeSandbox delete removes local row only after provider cleanup succeeds', async () => {
  const harness = await withSessionRouter({
    row: { id: 'session-1', provider: 'codesandbox' },
    terminateSession: async () => undefined
  });

  const response = await harness.request('DELETE', '/api/v1/sessions/session-1');

  assert.equal(response.status, 200);
  assert.equal(response.body.providerCleanup, 'deleted');
  assert.equal(harness.calls.dbRun.length, 1);
  assert.match(harness.calls.dbRun[0].sql, /DELETE FROM sessions/);
  assert.deepEqual(harness.calls.dbRun[0].params, ['session-1']);
});

test('GCS delete prefers the stored session credential over request credentials', async () => {
  let credentialRefUsed;
  const harness = await withSessionRouter({
    row: {
      id: 'session-1',
      provider: 'gcs',
      credentialRef: 'gcloud/original.json',
      metadata: JSON.stringify({ credentialRef: 'gcloud/metadata.json' })
    },
    terminateSession: async (row) => {
      credentialRefUsed = row.credentialRef;
    }
  });

  const response = await harness.request('DELETE', '/api/v1/sessions/session-1', {
    headers: { 'x-google-credentials': 'gcloud/wrong-account.json' }
  });

  assert.equal(response.status, 200);
  assert.equal(credentialRefUsed, 'gcloud/original.json');
});

test('GCS delete keeps local row when stored credentials cannot be loaded', async () => {
  let terminateCalled = false;
  const harness = await withSessionRouter({
    row: {
      id: 'session-1',
      provider: 'gcs',
      credentialRef: 'gcloud/missing.json'
    },
    initGoogleCredentialsFromS3IfNeeded: async () => {
      throw new Error('Failed to read mounted credentials from /mnt/gcloud/missing.json');
    },
    terminateSession: async () => {
      terminateCalled = true;
    }
  });

  const response = await harness.request('DELETE', '/api/v1/sessions/session-1');

  assert.equal(response.status, 500);
  assert.match(response.body.error, /Failed to read mounted credentials/);
  assert.equal(terminateCalled, false);
  assert.equal(harness.calls.dbRun.length, 0);
  assert.deepEqual(harness.calls.stoppedKeepAlive, []);
});

test('terminate-all preserves CodeSandbox local rows when provider cleanup fails', async () => {
  const harness = await withSessionRouter({
    row: null,
    rows: [{ id: 'session-1', provider: 'codesandbox' }],
    terminateSession: async () => {
      throw new ProviderError('CodeSandbox delete failed', {
        code: 'CODESANDBOX_DELETE_FAILED',
        statusCode: 502
      });
    }
  });

  const response = await harness.request('POST', '/api/v1/sessions/terminate-all');

  assert.equal(response.status, 200);
  assert.equal(response.body.summary.total, 1);
  assert.equal(response.body.summary.deleted, 0);
  assert.equal(response.body.summary.errors, 1);
  assert.equal(harness.calls.dbRun.length, 0);
});
