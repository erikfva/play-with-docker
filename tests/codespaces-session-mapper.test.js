const assert = require('assert');
const { test } = require('node:test');

const { mapToSession, mapState } = require('../src/services/providers/codespaces/session-mapper');

const STATE_EXPECTATIONS = {
  Available: 'RUNNING',
  Awaiting: 'RUNNING',
  Exporting: 'RUNNING',
  Starting: 'STARTING',
  ShuttingDown: 'STOPPING',
  Shutdown: 'STOPPED',
  Archived: 'STOPPED',
  Unavailable: 'STOPPED',
  Moved: 'STOPPED',
  Created: 'PENDING',
  Provisioning: 'PENDING',
  Queued: 'PENDING',
  Unknown: 'PENDING',
  Updating: 'PENDING',
  Rebuilding: 'PENDING',
  Failed: 'FAILED',
  Deleted: 'TERMINATED'
};

function buildCodespace(overrides = {}) {
  return {
    name: 'octocat-play-with-docker-abc123',
    display_name: 'My Session',
    state: 'Available',
    web_url: 'https://octocat-play-with-docker-abc123.github.dev',
    location: 'WestUs2',
    idle_timeout_minutes: 30,
    retention_period_minutes: 43200,
    last_used_at: '2026-08-02T05:35:00Z',
    machine: {
      name: 'basicLinux32gb',
      cpus: 2,
      memory_in_bytes: 8 * (1024 ** 3),
      storage_in_bytes: 32 * (1024 ** 3)
    },
    ...overrides
  };
}

test('maps all 17 GitHub states to the correct orchestrator status', () => {
  for (const [state, expectedStatus] of Object.entries(STATE_EXPECTATIONS)) {
    assert.equal(mapState(state), expectedStatus, `state ${state} should map to ${expectedStatus}`);
  }
});

test('defaults unknown states to PENDING and logs a warning', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);

  try {
    const status = mapState('SomeFutureState');
    assert.equal(status, 'PENDING');
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /SomeFutureState/);
});

test('maps codespace fields to the normalized session shape', () => {
  const session = mapToSession(buildCodespace(), 'codespaces/account.json', 'sha256:abc');

  assert.equal(session.provider, 'codespaces');
  assert.equal(session.providerSessionId, 'octocat-play-with-docker-abc123');
  assert.equal(session.envName, 'My Session');
  assert.equal(session.sshCommand, 'gh codespace ssh -c octocat-play-with-docker-abc123');
  assert.equal(session.status, 'RUNNING');
  assert.equal(session.credentialRef, 'codespaces/account.json');
  assert.equal(session.credentialFingerprint, 'sha256:abc');
});

test('webHost is always null', () => {
  assert.equal(mapToSession(buildCodespace(), 'ref', 'fp').webHost, null);
  assert.equal(mapToSession(buildCodespace({ state: 'Deleted' }), 'ref', 'fp').webHost, null);
});

test('webIdeUrl is populated from web_url', () => {
  const session = mapToSession(buildCodespace(), 'ref', 'fp');
  assert.equal(session.metadata.webIdeUrl, 'https://octocat-play-with-docker-abc123.github.dev');
});

test('memoryGB and storageGB are correctly converted from bytes', () => {
  const session = mapToSession(buildCodespace(), 'ref', 'fp');
  assert.equal(session.metadata.memoryGB, 8);
  assert.equal(session.metadata.storageGB, 32);
  assert.equal(session.metadata.cpus, 2);
  assert.equal(session.metadata.machine, 'basicLinux32gb');
});

test('metadata never contains the raw token', () => {
  const session = mapToSession(buildCodespace(), 'ref', 'fp');
  const json = JSON.stringify(session.metadata);
  assert.ok(!json.includes('ghp_'));
  assert.ok(!json.includes('token'));
});

test('envName falls back to codespace name when display_name is absent', () => {
  const session = mapToSession(buildCodespace({ display_name: undefined }), 'ref', 'fp');
  assert.equal(session.envName, 'octocat-play-with-docker-abc123');
});

test('stores githubState and lastUsedAt in metadata', () => {
  const session = mapToSession(buildCodespace({ last_used_at: '2026-08-02T05:35:00Z' }), 'ref', 'fp');
  assert.equal(session.metadata.githubState, 'Available');
  assert.equal(session.metadata.lastUsedAt, '2026-08-02T05:35:00Z');
});

test('rejects codespaces without a name', () => {
  assert.throws(() => mapToSession({ state: 'Available' }, 'ref', 'fp'), /requires a codespace with a name/);
});
