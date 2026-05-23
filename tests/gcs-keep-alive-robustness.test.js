const assert = require('assert');
const { test } = require('node:test');

// Clear require cache for the modules we want to test to ensure pristine imports
delete require.cache[require.resolve('../src/services/providers/gcs-provider')];
delete require.cache[require.resolve('../src/services/gcs-service')];
delete require.cache[require.resolve('../src/services/ssh-service')];

const GcsProvider = require('../src/services/providers/gcs-provider');
const gcsService = require('../src/services/gcs-service');
const sshService = require('../src/services/ssh-service');

test('GcsProvider - getKeepAliveConfig should have runOnStart enabled', () => {
  const provider = new GcsProvider();
  const config = provider.getKeepAliveConfig();
  assert.equal(config.enabled, true);
  assert.equal(config.runOnStart, true);
  assert.equal(config.intervalMinutes, 10);
});

test('GcsProvider - isSessionActive returns true for RUNNING, PENDING, SUSPENDED, STARTING states', async () => {
  const provider = new GcsProvider();
  
  // Stub initializeCredentials to bypass credential checks
  provider.initializeCredentials = async () => '/fake/creds.json';
  provider.getProviderSessionId = () => 'fake-session';

  const testStates = ['RUNNING', 'PENDING', 'SUSPENDED', 'STARTING'];

  for (const state of testStates) {
    gcsService.getCloudShellStatus = async () => ({ status: state });
    const isActive = await provider.isSessionActive({});
    assert.equal(isActive, true, `Should be active when status is ${state}`);
  }
});

test('GcsProvider - isSessionActive returns false only on definitive 404/Not Found error', async () => {
  const provider = new GcsProvider();
  provider.initializeCredentials = async () => '/fake/creds.json';
  provider.getProviderSessionId = () => 'fake-session';

  // 1. Definitive 404 error
  gcsService.getCloudShellStatus = async () => {
    const error = new Error('Resource default not found');
    error.status = 404;
    throw error;
  };
  const isActiveNotFound = await provider.isSessionActive({});
  assert.equal(isActiveNotFound, false, 'Should return false on definitive 404 error');

  // 2. Generic message "not found" error
  gcsService.getCloudShellStatus = async () => {
    throw new Error('Environment was not found for this user');
  };
  const isActiveNotFoundMessage = await provider.isSessionActive({});
  assert.equal(isActiveNotFoundMessage, false, 'Should return false on error containing "not found"');
});

test('GcsProvider - isSessionActive rethrows transient network or API errors', async () => {
  const provider = new GcsProvider();
  provider.initializeCredentials = async () => '/fake/creds.json';
  provider.getProviderSessionId = () => 'fake-session';

  gcsService.getCloudShellStatus = async () => {
    throw new Error('Connection timed out');
  };

  await assert.rejects(
    provider.isSessionActive({}),
    /Connection timed out/,
    'Should rethrow transient connection/network errors'
  );
});

test('GcsProvider - executeKeepAlive returns STARTING update when resuming from SUSPENDED', async () => {
  const provider = new GcsProvider();
  provider.initializeCredentials = async () => '/fake/creds.json';
  provider.getProviderSessionId = () => 'fake-session';

  gcsService.getCloudShellStatus = async () => ({ status: 'SUSPENDED' });
  // Mock start session to not fail
  let startCalled = false;
  gcsService.startCloudShellSession = async () => {
    startCalled = true;
    return {};
  };

  const result = await provider.executeKeepAlive({ id: 'test-session' });
  assert.equal(startCalled, true, 'startCloudShellSession should have been called');
  assert.equal(result.success, true);
  assert.equal(result.action, 'resumed');
  assert.deepEqual(result.updates, { status: 'STARTING' }, 'Should return updates specifying status is STARTING');
});

test('GcsProvider - executeKeepAlive returns RUNNING update when keep-alive succeeds on active environment', async () => {
  const provider = new GcsProvider();
  provider.initializeCredentials = async () => '/fake/creds.json';
  provider.getProviderSessionId = () => 'fake-session';

  gcsService.getCloudShellStatus = async () => ({
    status: 'RUNNING',
    sshHost: 'fake-host',
    sshPort: 2222,
    sshUsername: 'fake-user'
  });

  let sshCalled = false;
  sshService.executeCommand = async (connInfo, cmd, key) => {
    sshCalled = true;
    assert.equal(connInfo.host, 'fake-host');
    assert.equal(connInfo.port, 2222);
    assert.equal(connInfo.username, 'fake-user');
    assert.equal(cmd, 'echo "Keep-alive: $(date)"');
    return 'Keep-alive output';
  };

  const result = await provider.executeKeepAlive({ id: 'test-session', privateKey: 'fake-private-key' });
  assert.equal(sshCalled, true, 'sshService.executeCommand should have been called');
  assert.equal(result.success, true);
  assert.equal(result.action, 'keep-alive-sent');
  assert.deepEqual(result.updates, { status: 'RUNNING' }, 'Should return updates specifying status is RUNNING');
});
