const assert = require('assert');
const childProcess = require('child_process');
const { test } = require('node:test');
const {
  classifyGhStderrError,
  listCodespacesViaCli,
  createCodespaceViaCli,
  GEO_TO_CLI_LOCATION
} = require('../src/services/providers/codespaces/cli-executor');
const { invalidateCache, cacheKey, putCachedStatus, getCachedStatus, getOrCheckStatus } = require('../src/services/status-cache');

test('classifyGhStderrError handles known CLI stderr patterns', () => {
  const suspended = classifyGhStderrError('Your account was suspended by GitHub staff');
  assert.strictEqual(suspended.code, 'CODESPACES_ACCOUNT_SUSPENDED');
  assert.strictEqual(suspended.statusCode, 403);

  const billing = classifyGhStderrError('HTTP 402: You have reached your Codespaces spending limit');
  assert.strictEqual(billing.code, 'CODESPACES_BILLING_ERROR');
  assert.strictEqual(billing.statusCode, 402);

  const badToken = classifyGhStderrError('Bad credentials - 401 Unauthorized');
  assert.strictEqual(badToken.code, 'CODESPACES_TOKEN_INVALID');
  assert.strictEqual(badToken.statusCode, 401);

  const scope = classifyGhStderrError('Error getting token: lacks codespace scope');
  assert.strictEqual(scope.code, 'CODESPACES_TOKEN_INSUFFICIENT_SCOPE');
  assert.strictEqual(scope.statusCode, 403);

  const rateLimit = classifyGhStderrError('API rate limit exceeded');
  assert.strictEqual(rateLimit.code, 'CODESPACES_RATE_LIMIT_EXCEEDED');
  assert.strictEqual(rateLimit.statusCode, 429);

  const repoNotFound = classifyGhStderrError('could not resolve to a repository: octocat/secret');
  assert.strictEqual(repoNotFound.code, 'CODESPACES_REPOSITORY_NOT_FOUND');
  assert.strictEqual(repoNotFound.statusCode, 404);
});

test('GEO_TO_CLI_LOCATION maps REST regions to Azure/CLI regions', () => {
  assert.strictEqual(GEO_TO_CLI_LOCATION.UsEast, 'EastUs');
  assert.strictEqual(GEO_TO_CLI_LOCATION.UsWest, 'WestUs2');
  assert.strictEqual(GEO_TO_CLI_LOCATION.EuropeWest, 'WestEurope');
  assert.strictEqual(GEO_TO_CLI_LOCATION.SoutheastAsia, 'SouthEastAsia');
});

test('status-cache: invalidateCache removes specific entry without clearing everything', () => {
  const key1 = cacheKey('codespaces', 'fp1');
  const key2 = cacheKey('codespaces', 'fp2');

  putCachedStatus(key1, { status: 'AVAILABLE' });
  putCachedStatus(key2, { status: 'AVAILABLE' });

  assert.deepStrictEqual(getCachedStatus(key1), { status: 'AVAILABLE' });
  assert.deepStrictEqual(getCachedStatus(key2), { status: 'AVAILABLE' });

  invalidateCache(key1);

  assert.strictEqual(getCachedStatus(key1), null);
  assert.deepStrictEqual(getCachedStatus(key2), { status: 'AVAILABLE' });
});

test('listCodespacesViaCli rejects empty or whitespace stdout instead of returning []', async () => {
  const originalExecFile = childProcess.execFile;
  try {
    childProcess.execFile = (cmd, args, opts, cb) => {
      cb(null, '   \n', '');
    };
    await assert.rejects(
      () => listCodespacesViaCli('dummy-token'),
      (err) => {
        assert.strictEqual(err.code, 'CODESPACES_COMMAND_FAILED');
        assert.strictEqual(err.statusCode, 502);
        assert.match(err.message, /Unexpected empty output/);
        return true;
      }
    );
  } finally {
    childProcess.execFile = originalExecFile;
  }
});

test('listCodespacesViaCli rejects non-array JSON output instead of returning []', async () => {
  const originalExecFile = childProcess.execFile;
  try {
    childProcess.execFile = (cmd, args, opts, cb) => {
      cb(null, JSON.stringify({ message: 'Not an array' }), '');
    };
    await assert.rejects(
      () => listCodespacesViaCli('dummy-token'),
      (err) => {
        assert.strictEqual(err.code, 'CODESPACES_COMMAND_FAILED');
        assert.strictEqual(err.statusCode, 502);
        assert.match(err.message, /Expected array output/);
        return true;
      }
    );
  } finally {
    childProcess.execFile = originalExecFile;
  }
});

test('listCodespacesViaCli succeeds only when output is a valid JSON array', async () => {
  const originalExecFile = childProcess.execFile;
  try {
    childProcess.execFile = (cmd, args, opts, cb) => {
      cb(null, '[]\n', '');
    };
    const res = await listCodespacesViaCli('dummy-token');
    assert.deepStrictEqual(res, []);
  } finally {
    childProcess.execFile = originalExecFile;
  }
});

test('createCodespaceViaCli rejects arbitrary progress text or invalid names', async () => {
  const originalExecFile = childProcess.execFile;
  try {
    childProcess.execFile = (cmd, args, opts, cb) => {
      cb(null, 'Creating codespace on vm-manager235-1/test...\nWaiting for ready...\n', '');
    };
    await assert.rejects(
      () => createCodespaceViaCli({ repo: 'vm-manager235-1/test' }, 'dummy-token'),
      (err) => {
        assert.strictEqual(err.code, 'CODESPACES_CREATION_FAILED');
        assert.strictEqual(err.statusCode, 502);
        assert.match(err.message, /Unable to extract valid created codespace name/);
        return true;
      }
    );
  } finally {
    childProcess.execFile = originalExecFile;
  }
});

test('createCodespaceViaCli accepts valid codespace name from plain-text or JSON stdout', async () => {
  const originalExecFile = childProcess.execFile;
  try {
    // Plain text valid identifier
    childProcess.execFile = (cmd, args, opts, cb) => {
      cb(null, 'octocat-test-abc123\n', '');
    };
    const name1 = await createCodespaceViaCli({ repo: 'vm-manager235-1/test' }, 'dummy-token');
    assert.strictEqual(name1, 'octocat-test-abc123');

    // JSON object with .name
    childProcess.execFile = (cmd, args, opts, cb) => {
      cb(null, JSON.stringify({ name: 'octocat-test-xyz789' }), '');
    };
    const name2 = await createCodespaceViaCli({ repo: 'vm-manager235-1/test' }, 'dummy-token');
    assert.strictEqual(name2, 'octocat-test-xyz789');
  } finally {
    childProcess.execFile = originalExecFile;
  }
});

test('createCodespaceViaCli rejects multi-line output containing name-like lines without guessing', async () => {
  const originalExecFile = childProcess.execFile;
  try {
    // Multi-line output where one line looks like a name but accompanied by progress text
    childProcess.execFile = (cmd, args, opts, cb) => {
      cb(null, 'Starting create...\noctocat-test-abc123\nDone.\n', '');
    };
    await assert.rejects(
      () => createCodespaceViaCli({ repo: 'vm-manager235-1/test' }, 'dummy-token'),
      (err) => {
        assert.strictEqual(err.code, 'CODESPACES_CREATION_FAILED');
        assert.strictEqual(err.statusCode, 502);
        assert.match(err.message, /Unable to extract valid created codespace name/);
        return true;
      }
    );
  } finally {
    childProcess.execFile = originalExecFile;
  }
});

test('status-cache: in-flight status check started before invalidateCache is discarded and cannot repopulate stale cache', async () => {
  const key = cacheKey('codespaces', 'race-condition-fp');

  let resolveChecker;
  const inFlightPromise = new Promise((resolve) => {
    resolveChecker = resolve;
  });

  // 1. Start an in-flight check
  const checkPromise = getOrCheckStatus(key, () => inFlightPromise);

  // 2. While the check is in flight, invalidate the cache
  invalidateCache(key);

  // 3. Resolve the stale in-flight check with UNAVAILABLE
  resolveChecker({ status: 'UNAVAILABLE' });
  const checkResult = await checkPromise;
  assert.deepStrictEqual(checkResult, { status: 'UNAVAILABLE' });

  // 4. Verify that the stale result did NOT enter the cache
  assert.strictEqual(getCachedStatus(key), null);

  // 5. Subsequent check started after invalidation works and can populate cache
  const freshResult = await getOrCheckStatus(key, async () => ({ status: 'AVAILABLE' }));
  assert.deepStrictEqual(freshResult, { status: 'AVAILABLE' });
  assert.deepStrictEqual(getCachedStatus(key), { status: 'AVAILABLE' });
});
