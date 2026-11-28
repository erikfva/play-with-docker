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
      'content-type': 'application/json',
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

function createTestApp(providerMock, useAuth = false) {
  const providerFactoryPath = require.resolve('../src/services/provider-factory');
  const routePath = require.resolve('../src/routes/codespaces-rpc');
  const { requireServerToken } = require('../src/middleware/require-server-token');

  delete require.cache[routePath];

  stubModule(providerFactoryPath, {
    getProvider: (name) => {
      if (name === 'codespaces') return providerMock;
      throw new Error(`Unexpected provider: ${name}`);
    },
    listProviders: () => ['codespaces'],
    normalizeProviderName: (p) => p
  });

  const router = require('../src/routes/codespaces-rpc');
  const app = express();
  app.use(express.json());
  if (useAuth) {
    app.use('/api/v1/rpc', requireServerToken, router);
  } else {
    app.use('/api/v1/rpc', router);
  }
  return app;
}

test('POST /api/v1/rpc/ensure is protected by requireServerToken', async () => {
  const originalToken = process.env.SERVER_TOKEN;
  process.env.SERVER_TOKEN = 'secret-test-server-token';
  try {
    const app = createTestApp({}, true);

    // Missing token
    const resNoAuth = await requestApp(app, 'POST', '/api/v1/rpc/ensure', {
      body: { provider: 'codespaces', credentialRef: 'etecnologysys1alwaysdata' }
    });
    assert.strictEqual(resNoAuth.status, 401);

    // Invalid token
    const resBadAuth = await requestApp(app, 'POST', '/api/v1/rpc/ensure', {
      headers: { 'x-server-token': 'wrong-token' },
      body: { provider: 'codespaces', credentialRef: 'etecnologysys1alwaysdata' }
    });
    assert.strictEqual(resBadAuth.status, 401);
  } finally {
    process.env.SERVER_TOKEN = originalToken;
  }
});

test('POST /api/v1/rpc/:action rejects unsupported action with 400', async () => {
  const app = createTestApp({});
  const res = await requestApp(app, 'POST', '/api/v1/rpc/unknownAction', {
    body: { provider: 'codespaces', credentialRef: 'etecnologysys1alwaysdata' }
  });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.code, 'CODESPACES_UNSUPPORTED_ACTION');
  assert.deepStrictEqual(res.body.details.supportedActions, ['ensure']);
});

test('POST /api/v1/rpc/:action rejects inherited Object prototype properties with 400', async () => {
  const app = createTestApp({});
  for (const action of ['constructor', 'toString', 'valueOf', '__proto__']) {
    const res = await requestApp(app, 'POST', `/api/v1/rpc/${action}`, {
      body: { provider: 'codespaces', credentialRef: 'etecnologysys1alwaysdata' }
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'CODESPACES_UNSUPPORTED_ACTION');
    assert.strictEqual(res.body.details.action, action);
    assert.deepStrictEqual(res.body.details.supportedActions, ['ensure']);
  }
});

test('POST /api/v1/rpc/ensure rejects when credentialRef is missing from header and body', async () => {
  const app = createTestApp({
    ensureCodespace: async () => ({})
  });
  const res = await requestApp(app, 'POST', '/api/v1/rpc/ensure', {
    body: { provider: 'codespaces' }
  });

  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.code, 'CODESPACES_NO_CREDENTIAL');
});

test('POST /api/v1/rpc/ensure succeeds with 200 when codespace already exists', async () => {
  let receivedOptions = null;
  const mockProvider = {
    ensureCodespace: async (opts) => {
      receivedOptions = opts;
      return {
        created: false,
        providerSessionId: 'test-vm-123',
        codespace: {
          name: 'test-vm-123',
          displayName: 'Test Codespace',
          state: 'Available',
          status: 'RUNNING'
        }
      };
    }
  };

  const app = createTestApp(mockProvider);
  const res = await requestApp(app, 'POST', '/api/v1/rpc/ensure', {
    headers: { 'x-codespaces-credentials': 'etecnologysys1alwaysdata' },
    body: { provider: 'codespaces', repository: 'vm-manager235-1/test' }
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.action, 'ensure');
  assert.strictEqual(res.body.provider, 'codespaces');
  assert.strictEqual(res.body.credentialRef, 'etecnologysys1alwaysdata');
  assert.strictEqual(res.body.created, false);
  assert.strictEqual(res.body.providerSessionId, 'test-vm-123');
  assert.strictEqual(receivedOptions.credentialRef, 'etecnologysys1alwaysdata');
  assert.strictEqual(receivedOptions.repository, 'vm-manager235-1/test');
});

test('POST /api/v1/rpc/ensure succeeds with 201 when new codespace is created', async () => {
  const mockProvider = {
    ensureCodespace: async (opts) => {
      return {
        created: true,
        providerSessionId: 'new-vm-456',
        codespace: {
          name: 'new-vm-456',
          displayName: 'New Codespace',
          state: 'Available',
          status: 'RUNNING'
        }
      };
    }
  };

  const app = createTestApp(mockProvider);
  const res = await requestApp(app, 'POST', '/api/v1/rpc/ensure', {
    body: {
      provider: 'codespaces',
      credentialRef: 'etecnologysys1alwaysdata',
      machine: 'basicLinux32gb'
    }
  });

  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.action, 'ensure');
  assert.strictEqual(res.body.provider, 'codespaces');
  assert.strictEqual(res.body.credentialRef, 'etecnologysys1alwaysdata');
  assert.strictEqual(res.body.created, true);
  assert.strictEqual(res.body.providerSessionId, 'new-vm-456');
});
