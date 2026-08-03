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

async function withSessionRouter({ row, rows, getProvider, initGoogleCredentialsFromS3IfNeeded }) {
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
    all: async (sql) => {
      const allRows = rows || [];
      if (/status IS NULL OR status NOT IN \('TERMINATED', 'FAILED', 'DELETED'\)/.test(sql)) {
        return allRows.filter((sessionRow) => !['TERMINATED', 'FAILED', 'DELETED'].includes(sessionRow.status));
      }
      return allRows;
    },
    pool: { end: async () => undefined },
    ready: Promise.resolve()
  });
  stubModule(providerFactoryPath, {
    getProvider,
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

const baseGetProvider = (terminateSession) => (providerName) => ({ terminateSession });

test('Codespaces delete calls terminateSession then UPDATE (not DELETE)', async () => {
  const harness = await withSessionRouter({
    row: { id: 'cs-1', provider: 'codespaces' },
    getProvider: baseGetProvider(async () => undefined)
  });

  const response = await harness.request('DELETE', '/api/v1/sessions/cs-1');

  assert.equal(response.status, 200);
  assert.equal(harness.calls.dbRun.length, 1);
  assert.match(harness.calls.dbRun[0].sql, /UPDATE sessions SET status = 'TERMINATED'/);
  assert.deepEqual(harness.calls.dbRun[0].params, ['cs-1']);
});

test('Codespaces delete preserves the row when provider cleanup fails', async () => {
  const harness = await withSessionRouter({
    row: { id: 'cs-1', provider: 'codespaces' },
    getProvider: baseGetProvider(async () => {
      throw new ProviderError('Codespaces delete failed', {
        code: 'CODESPACES_DELETE_FAILED',
        statusCode: 502
      });
    })
  });

  const response = await harness.request('DELETE', '/api/v1/sessions/cs-1');

  assert.equal(response.status, 502);
  assert.equal(response.body.code, 'CODESPACES_DELETE_FAILED');
  assert.equal(harness.calls.dbRun.length, 0);
});

test('Non-codespaces delete keeps existing hard-delete behavior', async () => {
  const harness = await withSessionRouter({
    row: { id: 'gcs-1', provider: 'gcs', credentialRef: 'gcloud/account.json' },
    getProvider: baseGetProvider(async () => undefined)
  });

  const response = await harness.request('DELETE', '/api/v1/sessions/gcs-1');

  assert.equal(response.status, 200);
  assert.equal(harness.calls.dbRun.length, 1);
  assert.match(harness.calls.dbRun[0].sql, /DELETE FROM sessions/);
  assert.deepEqual(harness.calls.dbRun[0].params, ['gcs-1']);
});

test('terminate-all with a mix of codespaces and gcs sessions: codespaces updated, gcs deleted', async () => {
  const terminateCalls = [];
  const harness = await withSessionRouter({
    row: null,
    rows: [
      { id: 'cs-1', provider: 'codespaces' },
      { id: 'gcs-1', provider: 'gcs', credentialRef: 'gcloud/account.json' }
    ],
    getProvider: (providerName) => ({
      terminateSession: async () => {
        terminateCalls.push(providerName);
      }
    })
  });

  const response = await harness.request('POST', '/api/v1/sessions/terminate-all');

  assert.equal(response.status, 200);
  assert.deepEqual(terminateCalls, ['codespaces', 'gcs']);
  assert.equal(response.body.summary.total, 2);
  assert.equal(response.body.summary.terminated, 2);
  assert.equal(response.body.summary.deleted, 2);
  assert.equal(response.body.summary.errors, 0);

  const updateCalls = harness.calls.dbRun.filter((call) => /UPDATE sessions SET status = 'TERMINATED'/.test(call.sql));
  const deleteCalls = harness.calls.dbRun.filter((call) => /DELETE FROM sessions/.test(call.sql));

  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0].params, ['cs-1']);
  assert.equal(deleteCalls.length, 1);
  assert.deepEqual(deleteCalls[0].params, ['gcs-1']);
});

test('terminate-all skips terminal codespaces rows', async () => {
  const terminateCalls = [];
  const harness = await withSessionRouter({
    row: null,
    rows: [
      { id: 'cs-terminated', provider: 'codespaces', status: 'TERMINATED' },
      { id: 'cs-running', provider: 'codespaces', status: 'RUNNING' }
    ],
    getProvider: (providerName) => ({
      terminateSession: async () => {
        terminateCalls.push(providerName);
      }
    })
  });

  const response = await harness.request('POST', '/api/v1/sessions/terminate-all');

  assert.equal(response.status, 200);
  assert.equal(response.body.summary.total, 1);
  assert.equal(response.body.summary.terminated, 1);
  assert.equal(response.body.summary.deleted, 1);
  assert.deepEqual(terminateCalls, ['codespaces']);
  const updateCalls = harness.calls.dbRun.filter((call) => /UPDATE sessions SET status = 'TERMINATED'/.test(call.sql));
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0].params, ['cs-running']);
});
