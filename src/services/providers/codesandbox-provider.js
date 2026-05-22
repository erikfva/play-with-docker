const BaseProvider = require('./base-provider');
const db = require('../../db/db');
const codesandboxClient = require('./codesandbox/client');
const { loadCodeSandboxCredentials } = require('./codesandbox/credentials-loader');
const { mapToSession } = require('./codesandbox/session-mapper');
const { getRowValue } = require('../../utils/helpers');
const {
  ProviderError,
  SessionNotReadyError,
  ConflictError,
  InvalidCredentialsError,
  ProviderUnavailableError
} = require('../../services/errors/provider-errors');

// Import VMTier constants from SDK
const { VMTier } = require('@codesandbox/sdk');

const CODESANDBOX_DOCKER_TEMPLATE_ALIAS = 'docker';
const DEFAULT_CODESANDBOX_DOCKER_TEMPLATE_ID = 'hsd8ke';
const DOCKER_HOST_ENV_FILE = '/tmp/codesandbox-docker-host.env';
const DEFAULT_HIBERNATION_TIMEOUT_SECONDS = 86400;
const DEFAULT_KEEP_ALIVE_INTERVAL_MINUTES = 60;
const KEEP_ALIVE_COMMAND = 'printf "%s\\n" "$(date -u +%FT%TZ)" > /tmp/play-with-docker-keepalive';

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

function normalizeSessionRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    provider: row.provider,
    providerSessionId: getRowValue(row, 'providerSessionId', 'providersessionid'),
    envName: getRowValue(row, 'envName', 'envname'),
    status: row.status,
    webHost: getRowValue(row, 'webHost', 'webhost'),
    sshCommand: getRowValue(row, 'sshCommand', 'sshcommand'),
    credentialRef: getRowValue(row, 'credentialRef', 'credentialref'),
    credentialFingerprint: getRowValue(row, 'credentialFingerprint', 'credentialfingerprint'),
    metadata: parseMetadata(row.metadata)
  };
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

class CodeSandboxProvider extends BaseProvider {
  constructor() {
    super('codesandbox');
  }

  /**
   * Get keep-alive configuration for CodeSandbox
   * CodeSandbox supports provider-managed hibernation, so keep-alive is disabled
   */
  getKeepAliveConfig(sessionRow) {
    const metadata = parseMetadata(sessionRow?.metadata);
    const keepAlive = metadata.keepAlive || {};
    const enabled = parseBoolean(keepAlive.enabled, false);

    if (!enabled) {
      return {
        enabled: false,
        intervalMinutes: null,
        strategy: 'session-disabled'
      };
    }

    return {
      enabled: true,
      intervalMinutes: parsePositiveInteger(keepAlive.intervalMinutes, DEFAULT_KEEP_ALIVE_INTERVAL_MINUTES),
      strategy: keepAlive.strategy || 'codesandbox-sdk-command',
      runOnStart: true
    };
  }

  /**
   * Check if session is active
   * @param {Object} sessionRow - Session database row
   * @returns {boolean} true if session is active
   */
  async isSessionActive(sessionRow) {
    try {
      const metadata = parseMetadata(sessionRow.metadata);
      // Handle PostgreSQL lowercasing of unquoted identifiers
      const credentialRef = getRowValue(sessionRow, 'credentialRef', 'credentialref') || metadata.credentialRef;
      const providerSessionId = getRowValue(sessionRow, 'providerSessionId', 'providersessionid');

      if (!providerSessionId) {
        return false;
      }

      if (!credentialRef) {
        return false;
      }

      const credentialData = await loadCodeSandboxCredentials(credentialRef);
      const client = codesandboxClient.getClient(credentialData.token);

      const running = await client.sandboxes.listRunning();
      return Array.isArray(running?.vms)
        && running.vms.some((vm) => vm.id === providerSessionId);
    } catch (error) {
      console.warn(`[CodeSandbox] Failed to check session active status: ${error.message}`);
      return false;
    }
  }

  /**
   * Execute keep-alive (disabled for CodeSandbox)
   */
  async executeKeepAlive(sessionRow) {
    const metadata = parseMetadata(sessionRow.metadata);
    const credentialRef = getRowValue(sessionRow, 'credentialRef', 'credentialref') || metadata.credentialRef;
    const providerSessionId = getRowValue(sessionRow, 'providerSessionId', 'providersessionid');

    if (!providerSessionId || !credentialRef) {
      return {
        success: false,
        action: 'missing-session-data',
        message: 'CodeSandbox keep-alive skipped because session is missing providerSessionId or credentialRef',
        updates: {}
      };
    }

    let connectedClient;
    try {
      const credentialData = await loadCodeSandboxCredentials(credentialRef);
      const client = codesandboxClient.getClient(credentialData.token);
      const sandbox = await client.sandboxes.resume(providerSessionId);
      connectedClient = await sandbox.connect();
      const output = await connectedClient.commands.run(KEEP_ALIVE_COMMAND);
      const updatedMetadata = {
        ...metadata,
        keepAlive: {
          ...(metadata.keepAlive || {}),
          enabled: true,
          lastRunAt: new Date().toISOString(),
          lastAction: 'sdk-command'
        }
      };

      return {
        success: true,
        action: 'keep-alive-sent',
        message: String(output || 'CodeSandbox keep-alive command completed').trim(),
        updates: {
          status: 'RUNNING',
          metadata: updatedMetadata
        }
      };
    } catch (error) {
      console.warn(`[CodeSandbox] Keep-alive failed for session ${sessionRow.id}: ${error.message}`);
      return {
        success: false,
        action: 'error',
        message: error.message,
        error: error.message,
        updates: {}
      };
    } finally {
      if (connectedClient?.dispose) {
        try {
          await connectedClient.dispose();
        } catch (disposeError) {
          console.warn(`[CodeSandbox] Failed to dispose keep-alive client: ${disposeError.message}`);
        }
      }
    }
  }

  /**
   * Create a new CodeSandbox session
   * @param {Object} options - Creation options
   * @param {string} options.credentialRef - Optional credential reference from header
   * @param {string} options.title - Sandbox title
   * @param {string} options.description - Sandbox description
   * @param {string} options.templateId - Optional legacy template value; only "docker" is accepted
   * @param {string} options.tags - Tags array
   * @param {string} options.privacy - Privacy setting (public, private, public-hosts)
   * @param {string} options.path - Path in sandbox
   * @param {string} options.vmTier - VM tier (Nano, Micro, Small, Medium, Large)
   * @param {number} options.hibernationTimeoutSeconds - Hibernation timeout in seconds
   * @param {Object|boolean} options.automaticWakeupConfig - Automatic wakeup configuration
   * @returns {Object} Normalized session data
   */
  async createSession(options = {}) {
    const {
      credentialRef,
      title,
      description,
      templateId,
      tags,
      privacy,
      path,
      vmTier,
      hibernationTimeoutSeconds,
      automaticWakeupConfig,
      keepAliveEnabled,
      keepAliveIntervalMinutes
    } = options || {};

    try {
      this.validateDockerTemplateOnly(templateId);
      const keepAliveConfig = this.buildSessionKeepAliveConfig({
        keepAliveEnabled: keepAliveEnabled ?? options.CODESANDBOX_KEEP_ALIVE_ENABLED,
        keepAliveIntervalMinutes: keepAliveIntervalMinutes ?? options.CODESANDBOX_KEEP_ALIVE_INTERVAL_MINUTES,
        hibernationTimeoutSeconds: hibernationTimeoutSeconds ?? options.CODESANDBOX_HIBERNATION_TIMEOUT_SECONDS,
        envKeepAliveEnabled: process.env.CODESANDBOX_KEEP_ALIVE_ENABLED,
        envKeepAliveIntervalMinutes: process.env.CODESANDBOX_KEEP_ALIVE_INTERVAL_MINUTES,
        envHibernationTimeoutSeconds: process.env.CODESANDBOX_HIBERNATION_TIMEOUT_SECONDS
      });

      // Step 1: Load credentials
      const credentialData = await loadCodeSandboxCredentials(credentialRef);
      const { token, credentialRef: resolvedRef, credentialFingerprint } = credentialData;

      // Step 2: Reuse an existing sandbox/session for this token when present
      const existingSession = await this.findActiveSessionForToken(credentialFingerprint);
      if (existingSession) {
        const reusableSession = await this.getReusableExistingSession(existingSession, token);
        if (reusableSession) {
          return {
            existing: true,
            session: reusableSession
          };
        }
      }

      // Step 3: Build SDK create options
      const createOptions = this.buildCreateOptions({
        token,
        title,
        description,
        templateId,
        tags,
        privacy,
        path,
        vmTier,
        hibernationTimeoutSeconds: keepAliveConfig.hibernationTimeoutSeconds,
        automaticWakeupConfig
      });

      // Step 4: Instantiate SDK client
      const client = codesandboxClient.getClient(token);

      // Step 5: Create sandbox
      const sandbox = await client.sandboxes.create(createOptions);

      // Step 6: Map to normalized session
      const session = mapToSession(sandbox, resolvedRef, credentialFingerprint);
      let dockerHostSetup;

      try {
        dockerHostSetup = await this.prepareDockerHostProxy(client, sandbox.id);
      } catch (bootstrapError) {
        await this.cleanupSandboxAfterCreateFailure(client, sandbox.id, bootstrapError.message);
        throw bootstrapError;
      }

      session.metadata = {
        ...(session.metadata || {}),
        dockerHost: dockerHostSetup.dockerHost,
        dockerHostProxy: dockerHostSetup,
        keepAlive: keepAliveConfig
      };

      return session;
    } catch (error) {
      console.error('[CodeSandbox] Create session failed:', error.message);
      throw this.translateError(error, 'create');
    }
  }

  /**
   * Build create options from request parameters
   */
  buildCreateOptions(params) {
    const {
      title,
      description,
      templateId,
      tags,
      privacy,
      path,
      vmTier,
      hibernationTimeoutSeconds,
      automaticWakeupConfig
    } = params;

    // Default values from environment
    const defaultTitle = title || process.env.CODESANDBOX_DEFAULT_TITLE || 'CodeSandbox Session';
    const defaultPrivacy = privacy || process.env.CODESANDBOX_DEFAULT_PRIVACY || 'public-hosts';
    const defaultVmTier = vmTier || process.env.CODESANDBOX_DEFAULT_VM_TIER || 'Nano';
    const defaultHibernation = parsePositiveInteger(
      hibernationTimeoutSeconds,
      parsePositiveInteger(process.env.CODESANDBOX_HIBERNATION_TIMEOUT_SECONDS, DEFAULT_HIBERNATION_TIMEOUT_SECONDS)
    );
    // Build options object
    const options = {
      title: defaultTitle,
      privacy: defaultPrivacy,
      hibernationTimeoutSeconds: defaultHibernation
    };

    const wakeupConfig = this.normalizeAutomaticWakeupConfig(automaticWakeupConfig);
    if (wakeupConfig) {
      options.automaticWakeupConfig = wakeupConfig;
    }

    this.validateDockerTemplateOnly(templateId);
    options.id = this.getDockerTemplateId();

    // Add description if provided
    if (description) {
      options.description = description;
    }

    // Add tags if provided
    if (tags) {
      options.tags = Array.isArray(tags) ? tags : [tags];
    }

    // Add path if provided
    if (path) {
      options.path = path;
    }

    // Map VM tier string to SDK tier
    if (defaultVmTier) {
      options.vmTier = this.mapVmTierString(defaultVmTier);
    }

    return options;
  }

  buildSessionKeepAliveConfig(options = {}) {
    const enabled = parseBoolean(
      options.keepAliveEnabled ?? options.envKeepAliveEnabled,
      false
    );
    const intervalMinutes = parsePositiveInteger(
      options.keepAliveIntervalMinutes ?? options.envKeepAliveIntervalMinutes,
      DEFAULT_KEEP_ALIVE_INTERVAL_MINUTES
    );
    const hibernationTimeoutSeconds = parsePositiveInteger(
      options.hibernationTimeoutSeconds ?? options.envHibernationTimeoutSeconds,
      DEFAULT_HIBERNATION_TIMEOUT_SECONDS
    );

    return {
      enabled,
      intervalMinutes,
      hibernationTimeoutSeconds,
      strategy: enabled ? 'codesandbox-sdk-command' : 'session-disabled',
      createdAt: new Date().toISOString()
    };
  }

  validateDockerTemplateOnly(templateId) {
    if (!templateId) {
      return;
    }

    if (String(templateId).trim().toLowerCase() === CODESANDBOX_DOCKER_TEMPLATE_ALIAS) {
      return;
    }

    throw new ProviderError('CodeSandbox provider only supports Docker sandboxes', {
      code: 'CODESANDBOX_TEMPLATE_UNSUPPORTED',
      statusCode: 400
    });
  }

  getDockerTemplateId() {
    return process.env.CODESANDBOX_DOCKER_TEMPLATE_ID || DEFAULT_CODESANDBOX_DOCKER_TEMPLATE_ID;
  }

  normalizeAutomaticWakeupConfig(value) {
    if (value && typeof value === 'object') {
      return {
        http: Boolean(value.http),
        websocket: Boolean(value.websocket)
      };
    }

    if (typeof value === 'boolean') {
      return {
        http: value,
        websocket: false
      };
    }

    if (process.env.CODESANDBOX_AUTOMATIC_WAKEUP === undefined) {
      return null;
    }

    const enabled = String(process.env.CODESANDBOX_AUTOMATIC_WAKEUP).trim().toLowerCase() === 'true';
    return {
      http: enabled,
      websocket: false
    };
  }

  /**
   * Map VM tier string to SDK VMTier enum
   */
  mapVmTierString(tierString) {
    const normalized = String(tierString || '').trim().toUpperCase();

    switch (normalized) {
      case 'NANO':
        return VMTier.Nano;
      case 'MICRO':
        return VMTier.Micro;
      case 'SMALL':
        return VMTier.Small;
      case 'MEDIUM':
        return VMTier.Medium;
      case 'LARGE':
        return VMTier.Large;
      case 'XLARGE':
        return VMTier.XLarge;
      case 'PICO':
        return VMTier.Pico;
      default:
        throw new ProviderError(`Unsupported CodeSandbox VM tier: ${tierString}`, {
          code: 'CODESANDBOX_CREATE_FAILED',
          statusCode: 400,
          details: {
            supportedVmTiers: ['Pico', 'Nano', 'Micro', 'Small', 'Medium', 'Large', 'XLarge']
          }
        });
    }
  }

  /**
   * Enforce one sandbox/session per token
   * Uses database unique index for race-safe enforcement
   */
  async findActiveSessionForToken(credentialFingerprint) {
    if (!credentialFingerprint) {
      throw new Error('credentialFingerprint is required for one-session-per-token enforcement');
    }

    try {
      return db.get(
        `SELECT * FROM sessions
         WHERE provider = ?
           AND credentialFingerprint = ?
           AND (status IS NULL OR status NOT IN (?, ?, ?))
         LIMIT 1`,
        ['codesandbox', credentialFingerprint, 'TERMINATED', 'DELETED', 'FAILED']
      );
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }

      throw new Error(`Failed to find CodeSandbox session for token: ${error.message}`);
    }
  }

  async getReusableExistingSession(existingSession, token) {
    const normalized = normalizeSessionRow(existingSession);
    if (!normalized?.providerSessionId) {
      await this.markSessionStale(existingSession.id, 'Missing CodeSandbox providerSessionId');
      return null;
    }

    const client = codesandboxClient.getClient(token);
    try {
      const sandbox = await client.sandboxes.get(normalized.providerSessionId);
      const dockerHostSetup = await this.prepareDockerHostProxy(client, normalized.providerSessionId);

      return {
        ...normalized,
        envName: sandbox.title || normalized.envName || normalized.providerSessionId,
        status: sandbox.status ? mapStatus(sandbox.status) : normalized.status,
        metadata: {
          ...(normalized.metadata || {}),
          ...(sandbox.title ? { title: sandbox.title } : {}),
          ...(sandbox.privacy ? { privacy: sandbox.privacy } : {}),
          ...(sandbox.tags ? { tags: sandbox.tags } : {}),
          dockerHost: dockerHostSetup.dockerHost,
          dockerHostProxy: dockerHostSetup
        }
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        await this.markSessionStale(existingSession.id, error.message);
        return null;
      }

      throw error;
    }
  }

  async markSessionStale(sessionId, reason) {
    if (!sessionId) {
      return;
    }

    await db.run(
      `UPDATE sessions
       SET status = ?,
           metadata = COALESCE(metadata, ?)
       WHERE id = ?`,
      ['DELETED', JSON.stringify({ staleReason: reason }), sessionId]
    );
    console.warn(`[CodeSandbox] Marked stale session ${sessionId} as DELETED: ${reason}`);
  }

  async enforceOneActiveSessionPerToken(credentialFingerprint) {
    const existingSession = await this.findActiveSessionForToken(credentialFingerprint);
    if (existingSession) {
      throw new ConflictError('A CodeSandbox session with this token already exists');
    }
  }

  /**
   * Refresh session details
   */
  async refreshSession(sessionRow) {
    try {
      const metadata = parseMetadata(sessionRow.metadata);
      // Handle PostgreSQL lowercasing of unquoted identifiers
      const credentialFingerprint = getRowValue(sessionRow, 'credentialFingerprint', 'credentialfingerprint') || metadata.credentialFingerprint;
      const credentialRef = getRowValue(sessionRow, 'credentialRef', 'credentialref') || metadata.credentialRef;
      const providerSessionId = getRowValue(sessionRow, 'providerSessionId', 'providersessionid');

      if (!credentialFingerprint || !credentialRef) {
        throw new Error('Session is missing credential information');
      }
      if (!providerSessionId) {
        throw new Error('Session is missing providerSessionId');
      }

      // Load token from credential reference
      const credentialData = await loadCodeSandboxCredentials(credentialRef);
      const client = codesandboxClient.getClient(credentialData.token);

      // Get sandbox details (non-waking lookup)
      const sandbox = await client.sandboxes.get(providerSessionId);

      // Map to refresh response
      const refreshData = this.mapRefreshData(sandbox, credentialRef, credentialFingerprint, metadata);

      return refreshData;
    } catch (error) {
      console.error('[CodeSandbox] Refresh session failed:', error.message);
      throw this.translateError(error, 'refresh');
    }
  }

  mapRefreshData(sandbox, credentialRef, credentialFingerprint, existingMetadata = {}) {
    return {
      status: sandbox.status ? mapStatus(sandbox.status) : undefined,
      metadata: {
        ...(existingMetadata || {}),
        ...(sandbox.title ? { title: sandbox.title } : {}),
        ...(sandbox.privacy ? { privacy: sandbox.privacy } : {}),
        ...(sandbox.tags ? { tags: sandbox.tags } : {}),
        ...(sandbox.cluster ? { cluster: sandbox.cluster } : {}),
        ...(sandbox.bootupType ? { bootupType: sandbox.bootupType } : {}),
        ...(sandbox.isUpToDate !== undefined ? { isUpToDate: sandbox.isUpToDate } : {}),
        credentialRef,
        credentialFingerprint
      }
    };
  }

  /**
   * Execute command in CodeSandbox session
   */
  async executeCommand(sessionRow, command) {
    if (!command || typeof command !== 'string') {
      throw new ProviderError('Command must be a non-empty string', {
        code: 'CODESANDBOX_COMMAND_INVALID',
        statusCode: 400
      });
    }

    try {
      const metadata = parseMetadata(sessionRow.metadata);
      const dockerHost = metadata.dockerHost;
      // Handle PostgreSQL lowercasing of unquoted identifiers
      const credentialFingerprint = getRowValue(sessionRow, 'credentialFingerprint', 'credentialfingerprint') || metadata.credentialFingerprint;
      const credentialRef = getRowValue(sessionRow, 'credentialRef', 'credentialref') || metadata.credentialRef;
      const providerSessionId = getRowValue(sessionRow, 'providerSessionId', 'providersessionid');

      if (!credentialFingerprint || !credentialRef) {
        throw new Error('Session is missing credential information');
      }

      // Load token from credential reference
      const credentialData = await loadCodeSandboxCredentials(credentialRef);
      const client = codesandboxClient.getClient(credentialData.token);

      if (!providerSessionId) {
        throw new Error('Session is missing providerSessionId');
      }

      const sandboxId = providerSessionId;
      let sandbox;

      try {
        sandbox = await client.sandboxes.resume(sandboxId);
        console.log(`[CodeSandbox] Resumed session ${sandboxId}`);
      } catch (resumeError) {
        throw new SessionNotReadyError(`Session ${sandboxId} could not be resumed: ${resumeError.message}`);
      }

      // Connect to sandbox
      const connectedClient = await sandbox.connect();

      try {
        // Execute command
        const result = await connectedClient.commands.run(this.withDockerHostEnv(command, dockerHost));

        // Return normalized output
        return {
          output: result
        };
      } finally {
        // Dispose client
        try {
          await connectedClient.dispose();
        } catch (disposeError) {
          console.warn(`[CodeSandbox] Failed to dispose client: ${disposeError.message}`);
        }
      }
    } catch (error) {
      console.error('[CodeSandbox] Execute command failed:', error.message);
      throw this.translateError(error, 'command');
    }
  }

  async prepareDockerHostProxy(client, sandboxId) {
    if (!sandboxId) {
      throw new Error('CodeSandbox Docker host bootstrap requires a sandbox id');
    }

    let sandbox;
    try {
      sandbox = await client.sandboxes.resume(sandboxId);
      console.log(`[CodeSandbox] Resumed session ${sandboxId} for Docker host bootstrap`);
    } catch (resumeError) {
      throw new SessionNotReadyError(`Session ${sandboxId} could not be resumed for Docker host bootstrap: ${resumeError.message}`);
    }

    const connectedClient = await sandbox.connect();
    try {
      const output = await connectedClient.commands.run(this.buildDockerHostBootstrapCommand());
      const dockerHost = this.parseDockerHostFromBootstrapOutput(output);

      if (!dockerHost) {
        throw new Error(`Docker host bootstrap did not return DOCKER_HOST. Output: ${String(output || '').trim()}`);
      }

      return {
        dockerHost,
        envFile: DOCKER_HOST_ENV_FILE,
        port: 2375,
        preparedAt: new Date().toISOString()
      };
    } finally {
      try {
        await connectedClient.dispose();
      } catch (disposeError) {
        console.warn(`[CodeSandbox] Failed to dispose bootstrap client: ${disposeError.message}`);
      }
    }
  }

  async cleanupSandboxAfterCreateFailure(client, sandboxId, reason) {
    if (!sandboxId) {
      return;
    }

    try {
      await client.sandboxes.shutdown(sandboxId);
    } catch (shutdownError) {
      if (!isNotFoundError(shutdownError)) {
        console.warn(`[CodeSandbox] Failed to shutdown sandbox ${sandboxId} after create failure: ${shutdownError.message}`);
      }
    }

    try {
      await client.sandboxes.delete(sandboxId);
      console.warn(`[CodeSandbox] Deleted sandbox ${sandboxId} after create bootstrap failure: ${reason}`);
    } catch (deleteError) {
      if (!isNotFoundError(deleteError)) {
        console.warn(`[CodeSandbox] Failed to delete sandbox ${sandboxId} after create failure: ${deleteError.message}`);
      }
    }
  }

  buildDockerHostBootstrapCommand() {
    return [
      'set -eu',
      'if ! command -v socat >/dev/null 2>&1; then sudo apt-get update && sudo apt-get install -y socat; fi',
      'HOST_IP=$(ip -4 addr show scope global | awk \'/192\\.168\\./ { split($2,a,"/"); print a[1]; exit }\')',
      'if [ -z "$HOST_IP" ]; then HOST_IP=$(ip route | awk \'/default/ { print $3; exit }\'); fi',
      'test -n "$HOST_IP"',
      'DOCKER_HOST_VALUE="tcp://$HOST_IP:2375"',
      `printf 'DOCKER_HOST=%s\\n' "$DOCKER_HOST_VALUE" | tee ${DOCKER_HOST_ENV_FILE} >/dev/null`,
      'printf \'export DOCKER_HOST=%s\\n\' "$DOCKER_HOST_VALUE" | sudo tee /etc/profile.d/codesandbox-docker-host.sh >/dev/null',
      'if sudo test -f /etc/environment && sudo grep -q "^DOCKER_HOST=" /etc/environment; then sudo sed -i "s#^DOCKER_HOST=.*#DOCKER_HOST=$DOCKER_HOST_VALUE#" /etc/environment; else printf \'DOCKER_HOST=%s\\n\' "$DOCKER_HOST_VALUE" | sudo tee -a /etc/environment >/dev/null; fi',
      'if ss -ltn | awk \'$4 ~ /:2375$/ { found=1 } END { exit !found }\'; then :; else setsid socat TCP-LISTEN:2375,bind=$HOST_IP,reuseaddr,fork UNIX-CONNECT:/var/run/docker.sock </dev/null >/tmp/docker-socket-proxy.log 2>&1 & fi',
      'sleep 1',
      'if ! ss -ltn | awk \'$4 ~ /:2375$/ { found=1 } END { exit !found }\'; then cat /tmp/docker-socket-proxy.log; exit 1; fi',
      'printf \'DOCKER_HOST=%s\\n\' "$DOCKER_HOST_VALUE"'
    ].join('\n');
  }

  parseDockerHostFromBootstrapOutput(output) {
    const text = String(output || '');
    const match = text.match(/DOCKER_HOST=(tcp:\/\/[^\s]+)/);
    return match ? match[1] : null;
  }

  withDockerHostEnv(command, dockerHost) {
    if (!dockerHost) {
      return command;
    }

    const escapedDockerHost = dockerHost.replace(/'/g, "'\"'\"'");
    return `export DOCKER_HOST='${escapedDockerHost}'; ${command}`;
  }

  /**
   * Terminate session
   */
  async terminateSession(sessionRow) {
    try {
      const metadata = parseMetadata(sessionRow.metadata);
      // Handle PostgreSQL lowercasing of unquoted identifiers
      const credentialFingerprint = getRowValue(sessionRow, 'credentialFingerprint', 'credentialfingerprint') || metadata.credentialFingerprint;
      const credentialRef = getRowValue(sessionRow, 'credentialRef', 'credentialref') || metadata.credentialRef;
      const providerSessionId = getRowValue(sessionRow, 'providerSessionId', 'providersessionid');

      if (!credentialFingerprint || !credentialRef) {
        console.warn('[CodeSandbox] Session missing credential information during termination');
        return;
      }

      // Load token from credential reference
      const credentialData = await loadCodeSandboxCredentials(credentialRef);
      const client = codesandboxClient.getClient(credentialData.token);

      if (!providerSessionId) {
        console.warn('[CodeSandbox] No providerSessionId for termination');
        return;
      }

      try {
        await client.sandboxes.shutdown(providerSessionId);
        console.log(`[CodeSandbox] Shutdown session ${providerSessionId}`);
      } catch (shutdownError) {
        if (isNotFoundError(shutdownError)) {
          console.log(`[CodeSandbox] Session ${providerSessionId} already absent before shutdown`);
        } else {
          console.warn(`[CodeSandbox] Failed to shutdown session ${providerSessionId} before delete: ${shutdownError.message}`);
        }
      }

      try {
        await client.sandboxes.delete(providerSessionId);
      } catch (deleteError) {
        if (isNotFoundError(deleteError)) {
          console.log('[CodeSandbox] Session already deleted during termination');
          return;
        }

        throw new ProviderError('CodeSandbox delete failed', {
          code: 'CODESANDBOX_DELETE_FAILED',
          statusCode: 502
        });
      }
      console.log(`[CodeSandbox] Deleted session ${providerSessionId}`);
    } catch (error) {
      if (isNotFoundError(error)) {
        console.log('[CodeSandbox] Session already deleted during termination');
        return;
      }

      console.error('[CodeSandbox] Terminate session failed:', error.message);
      throw this.translateError(error, 'delete');
    }
  }

  /**
   * Translate various errors into provider-safe errors
   */
  translateError(error, operation = 'provider') {
    if (error instanceof ProviderError) {
      return error;
    }

    // CodeSandbox SDK errors
    if (error.message) {
      const msg = error.message.toLowerCase();

      if (
        error.name === 'CommandError'
        || Number.isInteger(error.exitCode)
        || msg.includes('command failed')
        || msg.includes('non-zero exit code')
      ) {
        return new ProviderError('CodeSandbox command failed', {
          code: 'CODESANDBOX_COMMAND_FAILED',
          statusCode: 500,
          details: {
            exitCode: Number.isInteger(error.exitCode) ? error.exitCode : undefined,
            output: typeof error.output === 'string' ? error.output : undefined
          }
        });
      }

      if (msg.includes('token') && msg.includes('invalid')) {
        return new InvalidCredentialsError('CodeSandbox token is invalid');
      }

      if (msg.includes('not found') || msg.includes('does not exist')) {
        return new ProviderError('Session not found', { code: 'CODESANDBOX_NOT_FOUND', statusCode: 404 });
      }

      if (msg.includes('already exists') || msg.includes('conflict')) {
        return new ConflictError('A session with this token already exists');
      }

      if (msg.includes('api key') || msg.includes('credentials')) {
        return new InvalidCredentialsError('CodeSandbox credentials are invalid');
      }
    }

    if (operation === 'create') {
      return new ProviderError('CodeSandbox create failed', {
        code: 'CODESANDBOX_CREATE_FAILED',
        statusCode: 502
      });
    }

    if (operation === 'delete') {
      return new ProviderError('CodeSandbox delete failed', {
        code: 'CODESANDBOX_DELETE_FAILED',
        statusCode: 502
      });
    }

    if (operation === 'command') {
      return new ProviderError('CodeSandbox command failed', {
        code: 'CODESANDBOX_COMMAND_FAILED',
        statusCode: 502
      });
    }

    if (operation === 'refresh') {
      return new ProviderError('CodeSandbox session refresh failed', {
        code: 'CODESANDBOX_REFRESH_FAILED',
        statusCode: 502
      });
    }

    // Generic provider unavailable
    return new ProviderUnavailableError('CodeSandbox provider unavailable');
  }
}

function mapStatus(codeSandboxStatus) {
  const statusMap = {
    'RUNNING': 'RUNNING',
    'SUSPENDED': 'SUSPENDED',
    'IDLE': 'IDLE',
    'PAUSED': 'PAUSED',
    'STARTING': 'STARTING'
  };
  return statusMap[codeSandboxStatus] || 'RUNNING';
}

module.exports = CodeSandboxProvider;
