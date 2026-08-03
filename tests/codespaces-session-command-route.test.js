const assert = require('assert');
const express = require('express');
const { Readable, Writable } = require('stream');
const { test } = require('node:test');

function stubModule(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports
  };
}

async function withSessionRouter({ row, executeCommand, startKeepAlive }) {
  const calls = {
    dbRun: [],
    startKeepAlive: []
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
    all: async () => [],
    pool: { end: async () => undefined },
    ready: Promise.resolve()
  });
  stubModule(providerFactoryPath, {
    getProvider: () => ({
      name: 'codespaces',
      executeCommand
    }),
    listProviders: () => [],
    normalizeProviderName: (provider) => provider
  });
  stubModule(keepAlivePath, {
    stopKeepAlive: () => undefined,
    stopAllKeepAlives: () => undefined,
    getKeepAliveStats: () => null,
    startKeepAlive: async (sessionRow, provider) => {
      calls.startKeepAlive.push({ sessionRow: { ...sessionRow }, providerName: provider.name });
      if (typeof startKeepAlive === 'function') {
        await startKeepAlive(sessionRow, provider);
      }
    }
  });
  stubModule(credentialsListerPath, {
    listAvailableCredentials: async () => ({ credentials: [] })
  });
  stubModule(googleLoaderPath, {
    initGoogleCredentialsFromS3IfNeeded: async () => undefined
  });

  const router = require('../src/routes/sessions');
  const app = express();
  app.use('/api/v1/sessions', router);

  return {
    calls,
    request: (method, url, options) => requestApp(app, method, url, options)
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
    req.headers = {
      ...(options.headers || {})
    };

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

test('Codespaces command auto-starts stopped sessions, persists RUNNING, and restarts keepalive', async () => {
  const harness = await withSessionRouter({
    row: {
      id: 'cs-1',
      provider: 'codespaces',
      status: 'STOPPED',
      providerSessionId: 'octocat-code-abc',
      credentialRef: 'codespaces/token.json'
    },
    executeCommand: async (_row, command) => {
      assert.equal(command, 'pwd');
      return {
        output: 'ok',
        updates: { status: 'RUNNING' }
      };
    }
  });

  const response = await harness.request('POST', '/api/v1/sessions/cs-1/command', {
    body: { command: 'pwd' }
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { output: 'ok' });

  const updateCall = harness.calls.dbRun.find((call) => /UPDATE sessions/.test(call.sql));
  assert.ok(updateCall, 'expected the command route to persist session updates');
  assert.equal(updateCall.params[3], 'RUNNING');
  assert.equal(harness.calls.startKeepAlive.length, 1);
  assert.equal(harness.calls.startKeepAlive[0].sessionRow.status, 'RUNNING');
  assert.equal(harness.calls.startKeepAlive[0].providerName, 'codespaces');
});
