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

async function withSessionRouter({ insertError, existingSession, createdSession, refreshedSession }) {
  const calls = {
    dbRun: [],
    dbGet: [],
    cleanup: []
  };

  const routePath = require.resolve('../src/routes/sessions');
  const dbPath = require.resolve('../src/db/db');
  const providerFactoryPath = require.resolve('../src/services/provider-factory');
  const keepAlivePath = require.resolve('../src/services/keep-alive-service');
  const credentialsListerPath = require.resolve('../src/services/credentials-lister');
  const googleLoaderPath = require.resolve('../src/services/google-credentials-loader');

  delete require.cache[routePath];

  const provider = {
    name: 'codespaces',
    createSession: async () => createdSession,
    refreshSession: async () => refreshedSession,
    terminateSession: async (sessionRow) => {
      calls.cleanup.push(sessionRow);
    }
  };

  stubModule(dbPath, {
    get: async (sql, params) => {
      calls.dbGet.push({ sql, params });
      if (/WHERE credentialFingerprint = \? AND provider = \?/.test(sql)) {
        return existingSession;
      }
      return null;
    },
    run: async (sql, params) => {
      calls.dbRun.push({ sql, params });
      if (insertError && /INSERT INTO sessions/.test(sql)) {
        throw insertError;
      }
    },
    all: async () => [],
    pool: { end: async () => undefined },
    ready: Promise.resolve()
  });
  stubModule(providerFactoryPath, {
    getProvider: () => provider,
    listProviders: () => [],
    normalizeProviderName: (providerName) => providerName
  });
  stubModule(keepAlivePath, {
    stopKeepAlive: () => undefined,
    stopAllKeepAlives: () => undefined,
    getKeepAliveStats: () => null,
    startKeepAlive: () => undefined
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

test('Codespaces create cleans up orphaned remote session and reuses existing row on unique conflict', async () => {
  const insertError = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505'
  });
  const harness = await withSessionRouter({
    insertError,
    existingSession: {
      id: 'cs-existing',
      provider: 'codespaces',
      providerSessionId: 'octocat-code-existing',
      status: 'RUNNING',
      metadata: '{}'
    },
    createdSession: {
      providerSessionId: 'octocat-code-new',
      credentialRef: 'codespaces/token.json',
      credentialFingerprint: 'sha256:test'
    },
    refreshedSession: {
      status: 'RUNNING',
      webHost: null,
      sshCommand: 'gh codespace ssh -c octocat-code-existing',
      metadata: {}
    }
  });

  const response = await harness.request('POST', '/api/v1/sessions', {
    body: {
      provider: 'codespaces',
      credentialRef: 'codespaces/token.json'
    }
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.reusedExisting, true);
  assert.equal(response.body.id, 'cs-existing');
  assert.equal(harness.calls.cleanup.length, 1);
  assert.equal(harness.calls.cleanup[0].providerSessionId, 'octocat-code-new');
  assert.equal(harness.calls.dbGet.length >= 1, true);
});
