const BaseProvider = require('./base-provider');
const codesandboxClient = require('./codesandbox/client');
const { loadCodeSandboxCredentials } = require('./codesandbox/credentials-loader');
const { mapToSession } = require('./codesandbox/session-mapper');
const db = require('../../db/db');
const {
  ProviderError,
  SessionNotReadyError,
  ConflictError,
  InvalidCredentialsError,
  ProviderUnavailableError
} = require('../../services/errors/provider-errors');

// Import VMTier constants from SDK
const { VMTier } = require('@codesandbox/sdk');

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
      // Handle PostgreSQL lowercasing of unquoted identifiers
      const credentialFingerprint = sessionRow.credentialFingerprint || sessionRow.credentialfingerprint || sessionRow.metadata?.credentialFingerprint;
      const providerSessionId = sessionRow.providerSessionId || sessionRow.providersessionid;

      if (!providerSessionId) {
        return false;
      }

      const client = codesandboxClient.getClient(credentialFingerprint);

      // Try to get sandbox status without waking it
      const sandbox = await client.sandboxes.get(providerSessionId);
      return sandbox.status === 'RUNNING';
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
   * @param {string} options.templateId - Template ID to fork from
   * @param {string} options.tags - Tags array
   * @param {string} options.privacy - Privacy setting (public, private, public-hosts)
   * @param {string} options.path - Path in sandbox
   * @param {string} options.vmTier - VM tier (Nano, Micro, Small, Medium, Large)
   * @param {number} options.hibernationTimeoutSeconds - Hibernation timeout in seconds
   * @param {boolean} options.automaticWakeupConfig - Automatic wakeup configuration
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
      // Step 1: Load credentials
      const credentialData = await loadCodeSandboxCredentials(credentialRef);
      const { token, credentialRef: resolvedRef, credentialFingerprint } = credentialData;

      // Step 2: Enforce one active VM per token
      await this.enforceOneActiveSessionPerToken(credentialFingerprint);

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
    const defaultWakeup = automaticWakeupConfig !== undefined
      ? automaticWakeupConfig
      : process.env.CODESANDBOX_AUTOMATIC_WAKEUP === 'true';

    // Build options object
    const options = {
      title: defaultTitle,
      privacy: defaultPrivacy,
      hibernationTimeoutSeconds: defaultHibernation,
      automaticWakeupConfig: defaultWakeup
    };

    // Add template ID if provided
    if (templateId) {
      options.id = templateId;
    }

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

  /**
   * Map VM tier string to SDK VMTier enum
   */
  mapVmTierString(tierString) {
    const normalized = tierString.toUpperCase();

    switch (normalized) {
      case 'NANO':
        return VMTier.Nano;
      case 'NANO2':
        return VMTier.Nano2;
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
      default:
        throw new Error(`Unsupported VM tier: ${tierString}. Supported: Nano, Nano2, Micro, Small, Medium, Large, XLarge`);
    }
  }

  /**
   * Enforce one active session per token
   * Uses database unique index for race-safe enforcement
   */
  async enforceOneActiveSessionPerToken(credentialFingerprint) {
    if (!credentialFingerprint) {
      throw new Error('credentialFingerprint is required for one-session-per-token enforcement');
    }

    try {
      // The unique index will prevent duplicates at database level
      // We don't need to check here; the insert will fail if duplicate exists
      return;
    } catch (error) {
      throw new Error(`Failed to enforce one-session-per-token: ${error.message}`);
    }
  }

  /**
   * Refresh session details
   */
  async refreshSession(sessionRow) {
    try {
      const credentialFingerprint = sessionRow.credentialFingerprint || sessionRow.metadata?.credentialFingerprint;
      const credentialRef = sessionRow.credentialRef || sessionRow.metadata?.credentialRef;

      if (!credentialFingerprint || !credentialRef) {
        throw new Error('Session is missing credential information');
      }

      // Load token from credential reference
      const credentialData = await loadCodeSandboxCredentials(credentialRef);
      const client = codesandboxClient.getClient(credentialData.token);

      // Get sandbox details (non-waking lookup)
      const sandbox = await client.sandboxes.get(sessionRow.providerSessionId);

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
      status: mapStatus(sandbox.status || 'RUNNING'),
      metadata: {
        ...(sandbox.title ? { title: sandbox.title } : {}),
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
      // Handle PostgreSQL lowercasing of unquoted identifiers
      const credentialFingerprint = sessionRow.credentialFingerprint || sessionRow.credentialfingerprint || sessionRow.metadata?.credentialFingerprint;
      const credentialRef = sessionRow.credentialRef || sessionRow.credentialref || sessionRow.metadata?.credentialRef;
      const providerSessionId = sessionRow.providerSessionId || sessionRow.providersessionid;

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

      // Resume sandbox if suspended
      const sandbox = await client.sandboxes.get(sandboxId);

      if (sandbox.status !== 'RUNNING') {
        // Attempt to resume
        try {
          await client.sandboxes.resume(sandboxId);
          console.log(`[CodeSandbox] Resumed session ${sandboxId}`);
        } catch (resumeError) {
          throw new SessionNotReadyError(`Session is ${sandbox.status} and could not be resumed: ${resumeError.message}`);
        }
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
      // Handle PostgreSQL lowercasing of unquoted identifiers
      const credentialFingerprint = sessionRow.credentialFingerprint || sessionRow.credentialfingerprint || sessionRow.metadata?.credentialFingerprint;
      const credentialRef = sessionRow.credentialRef || sessionRow.credentialref || sessionRow.metadata?.credentialRef;
      const providerSessionId = sessionRow.providerSessionId || sessionRow.providersessionid;

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
        return new ProviderError('Session not found', 404, 'CODESANDBOX_NOT_FOUND');
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
