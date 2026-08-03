const BaseProvider = require('./base-provider');
const db = require('../../db/db');
const githubClient = require('./codespaces/client');
const { loadCodespacesCredentials } = require('./codespaces/credentials-loader');
const { mapToSession, mapState } = require('./codespaces/session-mapper');
const { executeInCodespace, BOOT_TIMEOUT_MS, COMMAND_TIMEOUT_MS } = require('./codespaces/cli-executor');
const { getRowValue } = require('../../utils/helpers');
const {
  ProviderError,
  ConflictError,
  InvalidCredentialsError
} = require('../../services/errors/provider-errors');

const VALID_MACHINES = new Set([
  'basicLinux32gb',
  'standardLinux32gb',
  'standardLinux',
  'premiumLinux',
  'largePremiumLinux',
  'xLargePremiumLinux'
]);
const VALID_GEOS = new Set(['UsEast', 'UsWest', 'EuropeWest', 'SoutheastAsia']);
const NON_TERMINAL_STATUSES = new Set(['RUNNING', 'STARTING', 'PENDING', 'STOPPING']);
const POLL_INTERVAL_MS = 3000;

function parseMetadata(metadata) {
  if (!metadata) {
    return {};
  }

  if (typeof metadata === 'object') {
    return metadata;
  }

  try {
    return JSON.parse(metadata);
  } catch (_) {
    return {};
  }
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function parsePositiveInteger(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return parsed;
}

function isNotFoundError(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('not found') || message.includes('does not exist') || message.includes('404');
}

function normalizeStatus(status) {
  if (!status) return '';
  return String(status).trim().toUpperCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CodespacesProvider extends BaseProvider {
  constructor() {
    super('codespaces');
  }

  /**
   * Get keep-alive configuration for Codespaces
   * Precedence: per-session metadata.keepAlive.enabled → env var → default true
   */
  getKeepAliveConfig(sessionRow) {
    const metadata = parseMetadata(sessionRow?.metadata);
    const keepAlive = metadata.keepAlive || {};

    const enabled = parseBoolean(
      keepAlive.enabled ?? process.env.CODESPACES_KEEP_ALIVE_ENABLED,
      true
    );

    if (!enabled) {
      return {
        enabled: false,
        intervalMinutes: null,
        strategy: 'none'
      };
    }

    const configuredInterval = parsePositiveInteger(
      process.env.CODESPACES_KEEP_ALIVE_INTERVAL_MINUTES,
      20
    );
    const idleTimeout = parsePositiveInteger(
      metadata.idleTimeoutMinutes ?? process.env.CODESPACES_DEFAULT_IDLE_TIMEOUT_MINUTES,
      30
    );
    const intervalMinutes = Math.max(1, Math.min(configuredInterval, idleTimeout - 10));

    return {
      enabled: true,
      intervalMinutes,
      strategy: 'gh-cli-command',
      runOnStart: false
    };
  }

  /**
   * Check if session is active
   * Returns false only on a definitive not-found. Throws on transient errors so
   * the recovery service skips rather than deletes.
   */
  async isSessionActive(sessionRow) {
    const providerSessionId = getRowValue(sessionRow, 'providerSessionId');
    const credentialRef = getRowValue(sessionRow, 'credentialRef')
      || parseMetadata(sessionRow.metadata).credentialRef;

    if (!providerSessionId || !credentialRef) {
      return false;
    }

    const { token } = await loadCodespacesCredentials(credentialRef);

    try {
      const codespace = await githubClient.getCodespace(token, providerSessionId);
      return codespace.state !== 'Deleted';
    } catch (error) {
      if (isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Create a new Codespaces session
   */
  async createSession(options = {}) {
    this.validateMachine(options.machine);
    this.validateGeo(options.geo);

    const repositoryId = process.env.CODESPACES_DEFAULT_REPOSITORY_ID;
    if (!repositoryId) {
      throw new ProviderError('CODESPACES_DEFAULT_REPOSITORY_ID is not configured', {
        code: 'CODESPACES_REPOSITORY_NOT_CONFIGURED',
        statusCode: 500
      });
    }

    const credentialData = await loadCodespacesCredentials(options.credentialRef);
    const { token, credentialRef: resolvedRef, credentialFingerprint } = credentialData;

    // Validate token before any destructive or expensive operation
    try {
      await githubClient.validateToken(token);
    } catch (error) {
      throw this.translateError(error, 'create');
    }

    // Enforce one active session per token
    const existingSession = await this.findSessionForToken(credentialFingerprint);
    if (existingSession) {
      const status = normalizeStatus(existingSession.status);
      if (status === 'STOPPED') {
        // Delete remote (404-safe), then release the unique index slot by removing
        // the local row. Both must succeed before creating a fresh session.
        await githubClient.deleteCodespace(token, getRowValue(existingSession, 'providerSessionId'));
        await db.run('DELETE FROM sessions WHERE id = ?', [existingSession.id]);
      } else if (NON_TERMINAL_STATUSES.has(status)) {
        throw new ProviderError('An active Codespaces session already exists for this token', {
          code: 'CODESPACES_ALREADY_ACTIVE',
          statusCode: 409
        });
      }
    }

    const machine = options.machine || process.env.CODESPACES_DEFAULT_MACHINE || 'basicLinux32gb';
    const geo = options.geo || process.env.CODESPACES_DEFAULT_GEO || 'UsEast';
    const idleTimeoutMinutes = parsePositiveInteger(
      options.idleTimeoutMinutes,
      parsePositiveInteger(process.env.CODESPACES_DEFAULT_IDLE_TIMEOUT_MINUTES, 30)
    );
    const retentionPeriodMinutes = parsePositiveInteger(
      options.retentionPeriodMinutes,
      parsePositiveInteger(process.env.CODESPACES_DEFAULT_RETENTION_PERIOD_MINUTES, 1440)
    );

    const params = {
      repository_id: Number.parseInt(repositoryId, 10),
      ref: 'main',
      machine,
      geo,
      idle_timeout_minutes: idleTimeoutMinutes,
      retention_period_minutes: retentionPeriodMinutes
    };

    if (options.displayName) {
      params.display_name = options.displayName;
    }

    let codespace;
    try {
      codespace = await githubClient.createCodespace(token, params);
    } catch (error) {
      throw this.translateError(error, 'create');
    }

    const session = mapToSession(codespace, resolvedRef, credentialFingerprint);

    // Inject keep-alive config into metadata (mapper builds its own metadata)
    const syntheticMetadata = { ...(session.metadata || {}) };
    if (options.keepAlive !== undefined) {
      syntheticMetadata.keepAlive = {
        ...(syntheticMetadata.keepAlive || {}),
        enabled: options.keepAlive
      };
    }
    const keepAliveConfig = this.getKeepAliveConfig({ metadata: syntheticMetadata });
    session.metadata = {
      ...(session.metadata || {}),
      keepAlive: keepAliveConfig
    };

    return session;
  }

  validateMachine(machine) {
    if (machine === undefined || machine === null || machine === '') {
      return;
    }

    if (!VALID_MACHINES.has(String(machine))) {
      throw new ProviderError(`Unsupported Codespaces machine type: ${machine}`, {
        code: 'CODESPACES_INVALID_MACHINE',
        statusCode: 400,
        details: {
          supportedMachines: Array.from(VALID_MACHINES)
        }
      });
    }
  }

  validateGeo(geo) {
    if (geo === undefined || geo === null || geo === '') {
      return;
    }

    if (!VALID_GEOS.has(String(geo))) {
      throw new ProviderError(`Unsupported Codespaces geo region: ${geo}`, {
        code: 'CODESPACES_INVALID_GEO',
        statusCode: 400,
        details: {
          supportedGeos: Array.from(VALID_GEOS)
        }
      });
    }
  }

  async findSessionForToken(credentialFingerprint) {
    if (!credentialFingerprint) {
      return null;
    }

    return db.get(
      `SELECT * FROM sessions
       WHERE provider = 'codespaces'
         AND credentialFingerprint = ?
         AND (status IS NULL OR status NOT IN ('TERMINATED', 'FAILED'))
       LIMIT 1`,
      [credentialFingerprint]
    );
  }

  /**
   * Refresh session details from GitHub API
   */
  async refreshSession(sessionRow) {
    const providerSessionId = getRowValue(sessionRow, 'providerSessionId');
    const credentialRef = getRowValue(sessionRow, 'credentialRef')
      || parseMetadata(sessionRow.metadata).credentialRef;

    if (!providerSessionId) {
      throw new Error('Session is missing providerSessionId');
    }
    if (!credentialRef) {
      throw new Error('Session is missing credentialRef');
    }

    const { token } = await loadCodespacesCredentials(credentialRef);
    const codespace = await githubClient.getCodespace(token, providerSessionId);

    const existingMetadata = parseMetadata(sessionRow.metadata);

    return {
      status: mapState(codespace.state),
      webHost: null,
      sshCommand: `gh codespace ssh -c ${codespace.name}`,
      metadata: {
        ...existingMetadata,
        githubState: codespace.state,
        lastUsedAt: codespace.last_used_at || null
      }
    };
  }

  /**
   * Execute a command in the Codespaces session
   */
  async executeCommand(sessionRow, command) {
    if (!command || typeof command !== 'string') {
      throw new ProviderError('Command must be a non-empty string', {
        code: 'CODESPACES_COMMAND_INVALID',
        statusCode: 400
      });
    }

    const status = normalizeStatus(sessionRow.status);
    if (status === 'FAILED' || status === 'TERMINATED') {
      throw new ProviderError(`Session is ${status} and cannot execute commands`, {
        code: 'CODESPACES_COMMAND_FAILED',
        statusCode: 409
      });
    }

    const providerSessionId = getRowValue(sessionRow, 'providerSessionId');
    const credentialRef = getRowValue(sessionRow, 'credentialRef')
      || parseMetadata(sessionRow.metadata).credentialRef;

    if (!providerSessionId || !credentialRef) {
      throw new ProviderError('Session is missing providerSessionId or credentialRef', {
        code: 'CODESPACES_NO_CREDENTIAL',
        statusCode: 401
      });
    }

    const { token } = await loadCodespacesCredentials(credentialRef);
    let autoStarted = false;

    // Auto-start stopped codespaces before executing
    if (status === 'STOPPED') {
      await githubClient.startCodespace(token, providerSessionId);

      const deadline = Date.now() + BOOT_TIMEOUT_MS;
      let state = null;
      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        const current = await githubClient.getCodespace(token, providerSessionId);
        state = current.state;
        if (state === 'Available') {
          break;
        }
        if (state === 'Failed' || state === 'Deleted') {
          throw new ProviderError(`Codespace entered terminal state ${state} during boot`, {
            code: 'CODESPACES_START_FAILED',
            statusCode: 409
          });
        }
      }

      if (state !== 'Available') {
        throw new ProviderError('Codespace did not become available within the boot timeout', {
          code: 'CODESPACES_START_TIMEOUT',
          statusCode: 504
        });
      }

      autoStarted = true;

      try {
        await db.run("UPDATE sessions SET status = 'RUNNING' WHERE id = ?", [getRowValue(sessionRow, 'id')]);
      } catch (error) {
        console.warn(
          `[CodespacesProvider] Failed to persist RUNNING status after boot for session ${getRowValue(sessionRow, 'id')}: ${error.message}`
        );
      }
    }

    const result = await executeInCodespace(providerSessionId, command, token, {
      timeout: COMMAND_TIMEOUT_MS
    });

    return {
      output: result.output,
      updates: autoStarted ? { status: 'RUNNING' } : {}
    };
  }

  /**
   * Execute keep-alive for a session
   */
  async executeKeepAlive(sessionRow) {
    const status = normalizeStatus(sessionRow.status);
    if (['STOPPED', 'STOPPING', 'TERMINATED', 'FAILED'].includes(status)) {
      // Return success:true so the keep-alive service does NOT count this as a
      // failure. A deliberate skip must never increment consecutiveFailures.
      return {
        success: true,
        action: 'skipped',
        message: `Session is ${status}, keep-alive skipped`,
        updates: {}
      };
    }

    const providerSessionId = getRowValue(sessionRow, 'providerSessionId');
    const credentialRef = getRowValue(sessionRow, 'credentialRef')
      || parseMetadata(sessionRow.metadata).credentialRef;

    if (!providerSessionId || !credentialRef) {
      return {
        success: false,
        action: 'missing-session-data',
        message: 'Missing providerSessionId or credentialRef',
        updates: {}
      };
    }

    const { token } = await loadCodespacesCredentials(credentialRef);

    try {
      const result = await executeInCodespace(
        providerSessionId,
        'echo keep-alive',
        token,
        { timeout: BOOT_TIMEOUT_MS }
      );

      return {
        success: true,
        action: 'keep-alive-sent',
        message: result.output,
        updates: { status: 'RUNNING' }
      };
    } catch (error) {
      console.warn(`[Codespaces] Keep-alive failed for session ${sessionRow.id}: ${error.message}`);
      return {
        success: false,
        action: 'error',
        message: error.message,
        error: error.message,
        updates: {}
      };
    }
  }

  /**
   * Terminate a Codespaces session
   * The DB transition to TERMINATED is handled by the route, not here.
   */
  async terminateSession(sessionRow) {
    const providerSessionId = getRowValue(sessionRow, 'providerSessionId');
    const credentialRef = getRowValue(sessionRow, 'credentialRef')
      || parseMetadata(sessionRow.metadata).credentialRef;

    if (!providerSessionId) {
      console.warn('[Codespaces] No providerSessionId for termination');
      return;
    }

    if (!credentialRef) {
      console.warn('[Codespaces] Session missing credentialRef during termination');
      return;
    }

    const { token } = await loadCodespacesCredentials(credentialRef);
    await githubClient.deleteCodespace(token, providerSessionId);
    console.log(`[Codespaces] Deleted codespace ${providerSessionId}`);
  }

  /**
   * Translate various errors into provider-safe errors
   */
  translateError(error, operation = 'provider') {
    if (error instanceof ProviderError) {
      return error;
    }

    if (error instanceof InvalidCredentialsError) {
      return error;
    }

    if (error instanceof ConflictError) {
      return error;
    }

    if (error.message) {
      const msg = error.message.toLowerCase();

      if (msg.includes('token') && (msg.includes('invalid') || msg.includes('expired'))) {
        return new InvalidCredentialsError('Codespaces token is invalid');
      }

      if (msg.includes('not found') || msg.includes('does not exist')) {
        return new ProviderError('Codespace not found', {
          code: 'CODESPACES_NOT_FOUND',
          statusCode: 404
        });
      }
    }

    if (operation === 'create') {
      return new ProviderError('Codespaces create failed', {
        code: 'CODESPACES_CREATION_FAILED',
        statusCode: 500
      });
    }

    return new ProviderError('Codespaces provider unavailable', {
      code: 'CODESPACES_PROVIDER_UNAVAILABLE',
      statusCode: 502
    });
  }
}

module.exports = CodespacesProvider;
