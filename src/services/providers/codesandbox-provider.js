const BaseProvider = require('./base-provider');
const db = require('../../db/db');
const codesandboxClient = require('./codesandbox/client');
const { loadCodeSandboxCredentials } = require('./codesandbox/credentials-loader');
const { mapToSession } = require('./codesandbox/session-mapper');
const {
  ProviderError,
  SessionNotReadyError,
  ConflictError,
  InvalidCredentialsError,
  ProviderUnavailableError
} = require('../../services/errors/provider-errors');

// Import VMTier constants from SDK
const { VMTier } = require('@codesandbox/sdk');

const CODESANDBOX_DOCKER_TEMPLATE_ID = 'docker';

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

function getRowValue(row, camelName, lowerName) {
  return row[camelName] || row[lowerName];
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
  getKeepAliveConfig() {
    return {
      enabled: false,
      intervalMinutes: null,
      strategy: 'provider-managed-hibernation'
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
  async executeKeepAlive() {
    // Keep-alive is disabled; CodeSandbox uses provider-managed hibernation
    return {
      success: false,
      action: 'disabled',
      message: 'Keep-alive is disabled for CodeSandbox provider'
    };
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
      automaticWakeupConfig
    } = options || {};

    try {
      this.validateDockerTemplateOnly(templateId);

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
        hibernationTimeoutSeconds,
        automaticWakeupConfig
      });

      // Step 4: Instantiate SDK client
      const client = codesandboxClient.getClient(token);

      // Step 5: Create sandbox
      const sandbox = await client.sandboxes.create(createOptions);

      // Step 6: Map to normalized session
      const session = mapToSession(sandbox, resolvedRef, credentialFingerprint);

      return session;
    } catch (error) {
      console.error('[CodeSandbox] Create session failed:', error.message);
      throw this.translateError(error);
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
    const defaultHibernation = hibernationTimeoutSeconds !== undefined
      ? hibernationTimeoutSeconds
      : parseInt(process.env.CODESANDBOX_HIBERNATION_TIMEOUT_SECONDS || '86400', 10);
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
    options.id = CODESANDBOX_DOCKER_TEMPLATE_ID;

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

  validateDockerTemplateOnly(templateId) {
    if (!templateId) {
      return;
    }

    if (String(templateId).trim().toLowerCase() === CODESANDBOX_DOCKER_TEMPLATE_ID) {
      return;
    }

    throw new ProviderError('CodeSandbox provider only supports Docker sandboxes', {
      code: 'CODESANDBOX_TEMPLATE_UNSUPPORTED',
      statusCode: 400
    });
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
    const normalized = tierString.toUpperCase();

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
        throw new Error(`Unsupported VM tier: ${tierString}. Supported: Pico, Nano, Micro, Small, Medium, Large, XLarge`);
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
      return {
        ...normalized,
        envName: sandbox.title || normalized.envName || normalized.providerSessionId,
        status: sandbox.status ? mapStatus(sandbox.status) : normalized.status,
        metadata: {
          ...(normalized.metadata || {}),
          ...(sandbox.title ? { title: sandbox.title } : {}),
          ...(sandbox.privacy ? { privacy: sandbox.privacy } : {}),
          ...(sandbox.tags ? { tags: sandbox.tags } : {})
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
      const refreshData = this.mapRefreshData(sandbox, credentialRef, credentialFingerprint);

      return refreshData;
    } catch (error) {
      console.error('[CodeSandbox] Refresh session failed:', error.message);
      throw this.translateError(error);
    }
  }

  mapRefreshData(sandbox, credentialRef, credentialFingerprint) {
    return {
      status: sandbox.status ? mapStatus(sandbox.status) : undefined,
      metadata: {
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
      throw new Error('Command must be a non-empty string');
    }

    try {
      const metadata = parseMetadata(sessionRow.metadata);
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
        const result = await connectedClient.commands.run(command);

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
      throw this.translateError(error);
    }
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

      // Delete sandbox
      await client.sandboxes.delete(providerSessionId);
      console.log(`[CodeSandbox] Deleted session ${providerSessionId}`);
    } catch (error) {
      console.error('[CodeSandbox] Terminate session failed:', error.message);
      throw this.translateError(error);
    }
  }

  /**
   * Translate various errors into provider-safe errors
   */
  translateError(error) {
    if (error instanceof ProviderError) {
      return error;
    }

    // CodeSandbox SDK errors
    if (error.message) {
      const msg = error.message.toLowerCase();

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
