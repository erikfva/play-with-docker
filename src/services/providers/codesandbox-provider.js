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

const REFERENCE_PRICING = {
  Pico: { creditsPerHour: 5 },
  Nano: { creditsPerHour: 10 },
  Micro: { creditsPerHour: 20 },
  Small: { creditsPerHour: 40 },
  Medium: { creditsPerHour: 80 },
  Large: { creditsPerHour: 160 },
  XLarge: { creditsPerHour: 320 }
};

function numOrNull(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
function limitation(field, reason) { return { field, reason }; }
function quotaEntry({ quotaUnit, quotaPeriod, usage = null, limit = null, remaining = null, extra = {} }) {
  return { quotaUnit, quotaPeriod, usage, limit, remaining, ...extra };
}

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
    providerSessionId: getRowValue(row, 'providerSessionId'),
    envName: getRowValue(row, 'envName'),
    status: row.status,
    webHost: getRowValue(row, 'webHost'),
    sshCommand: getRowValue(row, 'sshCommand'),
    credentialRef: getRowValue(row, 'credentialRef'),
    credentialFingerprint: getRowValue(row, 'credentialFingerprint'),
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

  async getCredentialStatus(loaded) {
    const limitations = [];
    const quotas = [];

    const apiClient = codesandboxClient.getApiClient(loaded.token);
    const metaResult = await apiClient.getMetaInfo();

    const httpStatus = metaResult?.response?.status;

    if (httpStatus === 401 || httpStatus === 403) {
      return {
        status: 'INVALID',
        validated: false,
        quotas: [],
        expiresAt: null,
        limitations: [limitation(
          'status',
          `getMetaInfo() returned HTTP ${httpStatus}: token is expired, revoked, or lacks required scopes (sandbox_create, vm_manage).`
        )]
      };
    }

    if (!metaResult?.data) {
      const err = new Error(`getMetaInfo() returned HTTP ${httpStatus ?? 'unknown'}`);
      err.statusCode = httpStatus;
      throw err;
    }

    const meta = metaResult.data;

    const rl = meta.rate_limits || {};
    const hourly = rl.sandboxes_hourly || {};
    const conc = rl.concurrent_vms || {};

    const hourlyUsage =
      hourly.limit != null && hourly.remaining != null
        ? numOrNull(hourly.limit - hourly.remaining)
        : null;

    quotas.push(quotaEntry({
      quotaUnit: 'count',
      quotaPeriod: 'hourly-window',
      usage: hourlyUsage,
      limit: numOrNull(hourly.limit),
      remaining: numOrNull(hourly.remaining),
      extra: { resetAt: hourly.reset ?? null }
    }));

    const concUsage =
      conc.limit != null && conc.remaining != null
        ? numOrNull(conc.limit - conc.remaining)
        : null;

    quotas.push(quotaEntry({
      quotaUnit: 'count',
      quotaPeriod: null,
      usage: concUsage,
      limit: numOrNull(conc.limit),
      remaining: numOrNull(conc.remaining)
    }));

    // Dashboard credits (400 included / 275 used for etecnologysys) are UI-only.
    // api.codesandbox.io exposes no billing endpoint (probed 30+ candidates → 404).
    // Try web-scraping via Playwright (GitHub storageState → dashboard) — best-effort.
    let creditUsage = null;
    let creditLimit = null;
    let creditRemaining = null;
    let creditSource = null;
    let creditBillingPeriod = null;

    const teamId = meta.auth?.team;
    const scraperEnabled = process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED === '1' || process.env.CODESANDBOX_SCRAPER_ENABLED === '1';
    if (teamId && scraperEnabled) {
      try {
        // Lazy require for test mockability (stubModule can stub credits-scraper)
        const scraper = require('./codesandbox/credits-scraper');
        const scraped = await scraper.scrapeCreditsForTeam(teamId, { timeoutMs: 45000 });
        if (scraped && (typeof scraped.used === 'number' || typeof scraped.included === 'number')) {
          creditUsage = scraped.used;
          creditLimit = scraped.included;
          creditRemaining = scraped.remaining;
          creditBillingPeriod = scraped.billingPeriod;
          creditSource = scraped.url || `https://codesandbox.io/t/usage?workspace=${teamId}`;
        }
      } catch (scrapeErr) {
        console.warn(`[CodeSandbox] scrapeCreditsForTeam failed: ${scrapeErr.message}`);
      }
    }

    if (creditUsage != null || creditLimit != null) {
      quotas.push(quotaEntry({
        quotaUnit: 'credits',
        quotaPeriod: 'billing-cycle',
        usage: numOrNull(creditUsage),
        limit: numOrNull(creditLimit),
        remaining: numOrNull(creditRemaining),
        extra: {
          ...(creditSource ? { source: creditSource } : {}),
          ...(creditBillingPeriod ? { billingPeriod: creditBillingPeriod } : {})
        }
      }));
    } else {
      quotas.push(quotaEntry({
        quotaUnit: 'credits',
        quotaPeriod: 'billing-cycle',
        usage: null, limit: null, remaining: null
      }));
      limitations.push(limitation(
        'quotas[2].usage',
        'Dashboard credits (e.g. 400 included / 275 used for etecnologysys, 400/403 for vm-manager123) are rendered by codesandbox.io web UI via private cookie-auth billing API, not by GET /meta/info. ' +
        'Probed api.codesandbox.io billing candidates with Bearer token → 404/403. ' +
        'Scraping https://codesandbox.io/dashboard via Playwright (GitHub storageState, xvfb-run --headful, Cloudflare bypass) was attempted and failed or no GitHub session was available. ' +
        'Check https://codesandbox.io/dashboard?workspace=' + (teamId || 'ws_...') + ' for authoritative usage; a passing rate-limit check can still fail at VM creation if credits are exhausted.'
      ));
    }

    const rateLimitExhausted = conc.remaining === 0 || hourly.remaining === 0;
    const creditExhausted = creditRemaining === 0;

    return {
      status: (rateLimitExhausted || creditExhausted) ? 'QUOTA_EXHAUSTED' : 'AVAILABLE',
      validated: true,
      quotas,
      limitations,
      expiresAt: null,
      details: {
        referencePricing: REFERENCE_PRICING,
        authScopes: meta.auth?.scopes ?? null,
        referenceLimits: {
          freePlanConcurrentVmsDefault: 10,
          includedCreditsDefault: 400,
          billingPeriodExample: '4 Aug – 8 Sep 2026 (etecnologysys: 275/400, vm-manager123: 403/400 as scraped from dashboard)',
          dashboardUrl: teamId ? `https://codesandbox.io/t/usage?workspace=${teamId}` : 'https://codesandbox.io/dashboard'
        },
        ...(creditSource ? { creditSource } : {}),
        ...(creditBillingPeriod ? { creditBillingPeriod } : {})
      }
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
      const credentialRef = getRowValue(sessionRow, 'credentialRef') || metadata.credentialRef;
      const providerSessionId = getRowValue(sessionRow, 'providerSessionId');

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
    const credentialRef = getRowValue(sessionRow, 'credentialRef') || metadata.credentialRef;
    const providerSessionId = getRowValue(sessionRow, 'providerSessionId');

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
      const credentialFingerprint = getRowValue(sessionRow, 'credentialFingerprint') || metadata.credentialFingerprint;
      const credentialRef = getRowValue(sessionRow, 'credentialRef') || metadata.credentialRef;
      const providerSessionId = getRowValue(sessionRow, 'providerSessionId');

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
      const credentialFingerprint = getRowValue(sessionRow, 'credentialFingerprint') || metadata.credentialFingerprint;
      const credentialRef = getRowValue(sessionRow, 'credentialRef') || metadata.credentialRef;
      const providerSessionId = getRowValue(sessionRow, 'providerSessionId');

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
    const metadata = parseMetadata(sessionRow.metadata);
    // Handle PostgreSQL lowercasing of unquoted identifiers
    const credentialFingerprint = getRowValue(sessionRow, 'credentialFingerprint') || metadata.credentialFingerprint;
    const credentialRef = getRowValue(sessionRow, 'credentialRef') || metadata.credentialRef;
    const providerSessionId = getRowValue(sessionRow, 'providerSessionId');

    if (!credentialFingerprint || !credentialRef) {
      // Without valid credentials we cannot terminate the provider session.
      // Throw so the caller keeps the local DB record instead of silently
      // deleting a session that is still live provider-side.
      throw new ProviderError('CodeSandbox session is missing credential information; cannot terminate safely', {
        code: 'CODESANDBOX_SESSION_MISSING_CREDENTIALS',
        statusCode: 502
      });
    }

    // Load token from credential reference
    // Let credential-loading errors propagate to the caller — if we cannot
    // authenticate, we must not silently treat the session as deleted.
    const credentialData = await loadCodeSandboxCredentials(credentialRef);
    const client = codesandboxClient.getClient(credentialData.token);

    if (!providerSessionId) {
      // Cannot delete a sandbox we cannot identify. Throw so the local DB
      // record is preserved rather than silently removed.
      throw new ProviderError('CodeSandbox session is missing providerSessionId; cannot terminate', {
        code: 'CODESANDBOX_SESSION_MISSING_ID',
        statusCode: 502
      });
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
        statusCode: 502,
        details: {
          output: typeof error.message === 'string' ? error.message : undefined
        }
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
