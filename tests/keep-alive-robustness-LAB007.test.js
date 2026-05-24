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

test('keep-alive-service: clearKeepAliveStats deletes stats from Map', async () => {
  const keepAlivePath = require.resolve('../src/services/keep-alive-service');
  delete require.cache[keepAlivePath];

  const dbPath = require.resolve('../src/db/db');
  stubModule(dbPath, {
    run: async () => {},
    all: async () => []
  });

  const keepAliveService = require('../src/services/keep-alive-service');
  
  const fakeSession = { id: 'test-session-id', provider: 'gcs' };
  const mockProvider = {
    name: 'gcs',
    getKeepAliveConfig: () => ({ enabled: true, intervalMinutes: 10, runOnStart: false }),
    executeKeepAlive: async () => ({ success: true, message: 'OK' })
  };

  await keepAliveService.startKeepAlive(fakeSession, mockProvider);
  
  // Verify stats are initialized
  const statsBefore = keepAliveService.getKeepAliveStats('test-session-id');
  assert.ok(statsBefore, 'Stats should be initialized in Map');

  // Prune stats
  keepAliveService.clearKeepAliveStats('test-session-id');
  
  const statsAfter = keepAliveService.getKeepAliveStats('test-session-id');
  assert.equal(statsAfter, null, 'Stats should be completely removed from Map after pruning');
  
  keepAliveService.stopKeepAlive('test-session-id');
});

test('keep-alive-service: consecutive failure loop terminates after 3 failures', async () => {
  const keepAlivePath = require.resolve('../src/services/keep-alive-service');
  delete require.cache[keepAlivePath];

  const dbPath = require.resolve('../src/db/db');
  const dbRuns = [];
  stubModule(dbPath, {
    run: async (sql, params) => {
      dbRuns.push({ sql, params });
    },
    all: async () => []
  });

  const keepAliveService = require('../src/services/keep-alive-service');
  
  const fakeSession = { id: 'fail-session-id', provider: 'gcs' };
  
  // Keep track of executions
  let keepAliveCalls = 0;
  const mockProvider = {
    name: 'gcs',
    getKeepAliveConfig: () => ({ enabled: true, intervalMinutes: 10, runOnStart: false }),
    executeKeepAlive: async () => {
      keepAliveCalls++;
      return { success: false, message: 'Network unreachable' };
    }
  };

  // Stub setTimeout to run on next tick using process.nextTick so async promise chains resolve
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (fn, delay) => {
    process.nextTick(fn);
    return 999; // mock timeout ID
  };

  try {
    await keepAliveService.startKeepAlive(fakeSession, mockProvider);
    
    // Sleep a short duration using the original setTimeout to let the nextTick loop cycle 3 times
    await new Promise(resolve => originalSetTimeout(resolve, 50));
    
    assert.equal(keepAliveCalls, 3, 'executeKeepAlive should be called exactly 3 times before stopping');
    
    // Verify DB update
    assert.equal(dbRuns.length, 1, 'Should perform exactly one DB write to mark session as FAILED');
    assert.equal(dbRuns[0].sql, "UPDATE sessions SET status = 'FAILED' WHERE id = ?");
    assert.deepEqual(dbRuns[0].params, ['fail-session-id']);

  } finally {
    global.setTimeout = originalSetTimeout;
  }
});
