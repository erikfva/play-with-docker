const assert = require('assert');
const { test } = require('node:test');

function stubModule(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports
  };
}

function withCodespacesEnv(fn) {
  const previousEnv = {
    CODESPACES_KEEP_ALIVE_ENABLED: process.env.CODESPACES_KEEP_ALIVE_ENABLED,
    CODESPACES_KEEP_ALIVE_INTERVAL_MINUTES: process.env.CODESPACES_KEEP_ALIVE_INTERVAL_MINUTES,
    CODESPACES_DEFAULT_IDLE_TIMEOUT_MINUTES: process.env.CODESPACES_DEFAULT_IDLE_TIMEOUT_MINUTES
  };

  delete process.env.CODESPACES_KEEP_ALIVE_ENABLED;
  delete process.env.CODESPACES_KEEP_ALIVE_INTERVAL_MINUTES;
  delete process.env.CODESPACES_DEFAULT_IDLE_TIMEOUT_MINUTES;

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function loadProvider() {
  const dbPath = require.resolve('../src/db/db');
  const providerPath = require.resolve('../src/services/providers/codespaces-provider');

  delete require.cache[providerPath];
  stubModule(dbPath, {
    get: async () => null,
    run: async () => undefined,
    all: async () => [],
    pool: { end: async () => undefined },
    ready: Promise.resolve()
  });

  const CodespacesProvider = require('../src/services/providers/codespaces-provider');
  return new CodespacesProvider();
}

test('getKeepAliveConfig: enabled by default with a 20-minute interval and runOnStart false', () => {
  withCodespacesEnv(() => {
    const provider = loadProvider();
    const config = provider.getKeepAliveConfig({ metadata: '{}' });

    assert.equal(config.enabled, true);
    assert.equal(config.intervalMinutes, 20);
    assert.equal(config.strategy, 'gh-cli-command');
    assert.equal(config.runOnStart, false);
  });
});

test('getKeepAliveConfig: per-session disable override wins over env var default', () => {
  withCodespacesEnv(() => {
    process.env.CODESPACES_KEEP_ALIVE_ENABLED = 'true';
    const provider = loadProvider();
    const config = provider.getKeepAliveConfig({
      metadata: JSON.stringify({ keepAlive: { enabled: false } })
    });

    assert.equal(config.enabled, false);
    assert.equal(config.intervalMinutes, null);
    assert.equal(config.strategy, 'none');
  });
});

test('getKeepAliveConfig: env var default enables keep-alive when no per-session value', () => {
  withCodespacesEnv(() => {
    process.env.CODESPACES_KEEP_ALIVE_ENABLED = 'false';
    const provider = loadProvider();
    const config = provider.getKeepAliveConfig({ metadata: '{}' });

    assert.equal(config.enabled, false);
  });
});

test('getKeepAliveConfig: effective interval is min(configured, idleTimeout - 10)', () => {
  withCodespacesEnv(() => {
    const provider = loadProvider();
    const config = provider.getKeepAliveConfig({
      metadata: JSON.stringify({ idleTimeoutMinutes: 60 })
    });

    assert.equal(config.intervalMinutes, 20);
  });
});

test('getKeepAliveConfig: interval respects a short custom idle timeout', () => {
  withCodespacesEnv(() => {
    const provider = loadProvider();
    const config = provider.getKeepAliveConfig({
      metadata: JSON.stringify({ idleTimeoutMinutes: 25 })
    });

    assert.equal(config.intervalMinutes, 15);
  });
});

test('getKeepAliveConfig: effective interval is floored at 1 when idleTimeout - 10 <= 0', () => {
  withCodespacesEnv(() => {
    const provider = loadProvider();
    const config = provider.getKeepAliveConfig({
      metadata: JSON.stringify({ idleTimeoutMinutes: 5 })
    });

    assert.equal(config.intervalMinutes, 1);
  });
});

test('getKeepAliveConfig: runOnStart is always false', () => {
  withCodespacesEnv(() => {
    const provider = loadProvider();
    for (const metadata of ['{}', JSON.stringify({ idleTimeoutMinutes: 5 }), JSON.stringify({ keepAlive: { enabled: true } })]) {
      assert.equal(provider.getKeepAliveConfig({ metadata }).runOnStart, false);
    }
  });
});

test('executeKeepAlive: returns success true for skipped terminal/stopped states', async () => {
  const provider = loadProvider();
  for (const status of ['STOPPED', 'STOPPING', 'TERMINATED', 'FAILED']) {
    const result = await provider.executeKeepAlive({ id: 'session-1', status });

    assert.equal(result.success, true, `status ${status} must be success:true`);
    assert.equal(result.action, 'skipped');
    assert.match(result.message, new RegExp(status));
    assert.deepEqual(result.updates, {});
  }
});

test('executeKeepAlive: returns success false for missing providerSessionId', async () => {
  const provider = loadProvider();
  const result = await provider.executeKeepAlive({
    id: 'session-1',
    status: 'RUNNING',
    credentialRef: 'codespaces/account.json'
  });

  assert.equal(result.success, false);
  assert.equal(result.action, 'missing-session-data');
  assert.match(result.message, /providerSessionId|credentialRef/);
});

test('executeKeepAlive: returns success false for missing credentialRef', async () => {
  const provider = loadProvider();
  const result = await provider.executeKeepAlive({
    id: 'session-1',
    status: 'RUNNING',
    providerSessionId: 'octocat-code-abc'
  });

  assert.equal(result.success, false);
  assert.equal(result.action, 'missing-session-data');
});

function loadProviderWithMocks({ clientOverrides = {}, loaderOverrides = {} } = {}) {
  const dbPath = require.resolve('../src/db/db');
  const providerPath = require.resolve('../src/services/providers/codespaces-provider');
  const clientPath = require.resolve('../src/services/providers/codespaces/client');
  const loaderPath = require.resolve('../src/services/providers/codespaces/credentials-loader');

  delete require.cache[providerPath];

  stubModule(dbPath, {
    get: async () => null,
    run: async () => undefined,
    all: async () => [],
    pool: { end: async () => undefined },
    ready: Promise.resolve()
  });

  stubModule(loaderPath, {
    loadCodespacesCredentials: async () => ({
      token: 'ghp_test',
      credentialRef: 'codespaces/token.json',
      credentialFingerprint: 'sha256:test'
    }),
    ...loaderOverrides
  });

  stubModule(clientPath, {
    validateToken: async () => ({ login: 'octocat' }),
    createCodespace: async () => ({ name: 'octocat-test-1', state: 'Created' }),
    deleteCodespace: async () => undefined,
    getCodespace: async () => ({ state: 'Created' }),
    startCodespace: async () => ({ state: 'Starting' }),
    ...clientOverrides
  });

  const CodespacesProvider = require('../src/services/providers/codespaces-provider');
  return new CodespacesProvider();
}

test('createSession: geo and retention defaults match documented values', async () => {
  const createdParams = [];
  const provider = loadProviderWithMocks({
    clientOverrides: {
      createCodespace: async (token, params) => {
        createdParams.push(params);
        return { name: 'octocat-test-1', state: 'Created' };
      }
    }
  });

  process.env.CODESPACES_DEFAULT_REPOSITORY_ID = '123';
  try {
    await provider.createSession({ credentialRef: 'codespaces/token.json' });
  } finally {
    delete process.env.CODESPACES_DEFAULT_REPOSITORY_ID;
  }

  assert.equal(createdParams.length, 1);
  assert.equal(createdParams[0].geo, 'UsEast');
  assert.equal(createdParams[0].machine, 'basicLinux32gb');
  assert.equal(createdParams[0].idle_timeout_minutes, 30);
  assert.equal(createdParams[0].retention_period_minutes, 1440);
});

test('createSession: per-request geo and retention options override defaults', async () => {
  const createdParams = [];
  const provider = loadProviderWithMocks({
    clientOverrides: {
      createCodespace: async (token, params) => {
        createdParams.push(params);
        return { name: 'octocat-test-1', state: 'Created' };
      }
    }
  });

  process.env.CODESPACES_DEFAULT_REPOSITORY_ID = '123';
  try {
    await provider.createSession({
      credentialRef: 'codespaces/token.json',
      geo: 'EuropeWest',
      retentionPeriodMinutes: 2880
    });
  } finally {
    delete process.env.CODESPACES_DEFAULT_REPOSITORY_ID;
  }

  assert.equal(createdParams.length, 1);
  assert.equal(createdParams[0].geo, 'EuropeWest');
  assert.equal(createdParams[0].retention_period_minutes, 2880);
});

test('executeCommand: boot poll exits early when the codespace enters a terminal state', async () => {
  let getCodespaceCalls = 0;
  const provider = loadProviderWithMocks({
    clientOverrides: {
      getCodespace: async () => {
        getCodespaceCalls += 1;
        return { state: 'Failed' };
      }
    }
  });

  await assert.rejects(
    () => provider.executeCommand({
      id: 'session-1',
      status: 'STOPPED',
      providerSessionId: 'octocat-code-abc',
      credentialRef: 'codespaces/token.json'
    }, 'docker ps'),
    (error) => {
      assert.equal(error.code, 'CODESPACES_START_FAILED');
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /Failed/);
      return true;
    }
  );

  assert.equal(getCodespaceCalls, 1);
});
