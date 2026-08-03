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

function withRecoveryService(rows, provider) {
  const keepAlivePath = require.resolve('../src/services/keep-alive-service');
  const dbPath = require.resolve('../src/db/db');
  const providerFactoryPath = require.resolve('../src/services/provider-factory');
  const dbRuns = [];

  delete require.cache[keepAlivePath];

  stubModule(dbPath, {
    all: async () => rows,
    run: async (sql, params) => {
      dbRuns.push({ sql, params });
    }
  });

  stubModule(providerFactoryPath, {
    getProvider: () => provider
  });

  const keepAliveService = require('../src/services/keep-alive-service');
  return { keepAliveService, dbRuns };
}

test('recovery skips STOPPED sessions without calling isSessionActive or deleting the row', async () => {
  let isSessionActiveCalls = 0;
  const { keepAliveService, dbRuns } = withRecoveryService(
    [{ id: 'cs-stopped', provider: 'codespaces', status: 'STOPPED' }],
    {
      name: 'codespaces',
      getKeepAliveConfig: () => ({ enabled: true, intervalMinutes: 20 }),
      isSessionActive: async () => {
        isSessionActiveCalls += 1;
        return true;
      }
    }
  );

  const summary = await keepAliveService.recoverKeepAlivesOnStartup();

  assert.equal(summary.scanned, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.eligible, 0);
  assert.equal(summary.started, 0);
  assert.equal(summary.cleaned, 0);
  assert.equal(isSessionActiveCalls, 0);
  assert.deepEqual(dbRuns, []);
});

test('recovery calls isSessionActive for RUNNING sessions as before', async () => {
  let isSessionActiveCalls = 0;
  const { keepAliveService } = withRecoveryService(
    [{ id: 'cs-running', provider: 'codespaces', status: 'RUNNING' }],
    {
      name: 'codespaces',
      getKeepAliveConfig: () => ({ enabled: true, intervalMinutes: 20 }),
      isSessionActive: async () => {
        isSessionActiveCalls += 1;
        return true;
      }
    }
  );

  const summary = await keepAliveService.recoverKeepAlivesOnStartup();

  assert.equal(summary.scanned, 1);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.eligible, 1);
  assert.equal(summary.started, 1);
  assert.equal(isSessionActiveCalls, 1);

  keepAliveService.stopKeepAlive('cs-running');
});
