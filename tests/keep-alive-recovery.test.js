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

test('keep-alive recovery does not delete GCS rows when credential refs are missing', async () => {
  const keepAlivePath = require.resolve('../src/services/keep-alive-service');
  const dbPath = require.resolve('../src/db/db');
  const providerFactoryPath = require.resolve('../src/services/provider-factory');
  const dbRuns = [];

  delete require.cache[keepAlivePath];

  stubModule(dbPath, {
    all: async () => [
      {
        id: 'legacy-gcs-session',
        provider: 'gcs',
        status: 'RUNNING',
        providerSessionId: 'users/legacy@example.com/environments/default'
      }
    ],
    run: async (sql, params) => {
      dbRuns.push({ sql, params });
    }
  });

  stubModule(providerFactoryPath, {
    getProvider: () => ({
      name: 'gcs',
      getKeepAliveConfig: () => ({ enabled: true, intervalMinutes: 15 }),
      isSessionActive: async () => {
        const error = new Error('Google credential reference is missing for this session');
        error.code = 'GOOGLE_CREDENTIALS_MISSING';
        throw error;
      }
    })
  });

  const keepAliveService = require('../src/services/keep-alive-service');
  const summary = await keepAliveService.recoverKeepAlivesOnStartup();

  assert.equal(summary.cleaned, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.started, 0);
  assert.deepEqual(dbRuns, []);
});
