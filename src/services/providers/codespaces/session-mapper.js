/**
 * Codespaces Session Mapper
 *
 * Maps GitHub Codespaces API codespace objects to the application's normalized
 * session model. Handles partial data and unknown states.
 */

const STATE_MAP = {
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

function mapState(state) {
  const mapped = STATE_MAP[state];
  if (!mapped) {
    console.warn(`[Codespaces] Unknown GitHub state: "${state}" — defaulting to PENDING`);
    return 'PENDING';
  }
  return mapped;
}

function mapToSession(codespace, credentialRef, credentialFingerprint) {
  if (!codespace || !codespace.name) {
    throw new Error('Codespaces session mapper requires a codespace with a name');
  }

  const machine = codespace.machine || {};

  const metadata = {
    githubState: codespace.state || null,
    machine: machine.name || null,
    cpus: machine.cpus ?? null,
    memoryGB: machine.memory_in_bytes != null
      ? Math.round(machine.memory_in_bytes / (1024 ** 3))
      : null,
    storageGB: machine.storage_in_bytes != null
      ? Math.round(machine.storage_in_bytes / (1024 ** 3))
      : null,
    idleTimeoutMinutes: codespace.idle_timeout_minutes ?? null,
    retentionPeriodMinutes: codespace.retention_period_minutes ?? null,
    location: codespace.location || null,
    webIdeUrl: codespace.web_url || null,
    sshHost: null,
    lastUsedAt: codespace.last_used_at || null
  };

  Object.keys(metadata).forEach((key) => {
    if (metadata[key] === null || metadata[key] === undefined) {
      delete metadata[key];
    }
  });

  return {
    provider: 'codespaces',
    providerSessionId: codespace.name,
    envName: codespace.display_name || codespace.name,
    sshCommand: `gh codespace ssh -c ${codespace.name}`,
    webHost: null,
    status: mapState(codespace.state),
    credentialRef: credentialRef || null,
    credentialFingerprint: credentialFingerprint || null,
    metadata
  };
}

module.exports = {
  mapToSession,
  mapState
};
