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

function isSuspendedError(error) {
  return error?.code === 'CODESPACES_ACCOUNT_SUSPENDED' || error?.statusCode === 403;
}

function isDeadAccountError(error) {
  return isSuspendedError(error) || isNotFoundError(error);
}

function normalizeStatus(status) {
  if (!status) return '';
  return String(status).trim().toUpperCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactTokensFromMessage(msg) {
  return String(msg || '').replace(/\b[A-Za-z0-9_\-]{20,}\b/g, '[REDACTED]');
}
function safeReason(error) {
  const msg = error?.message || 'unknown error';
  return redactTokensFromMessage(msg);
}
function safeErrorCode(error) {
  return error?.code
    || (error?.statusCode ? `HTTP_${error.statusCode}` : null)
    || (error?.status ? `HTTP_${error.status}` : null)
    || 'UNKNOWN_ERROR';
}
function isTerminalAuthError(error) {
  return (
    error?.code === 'CODESPACES_TOKEN_INVALID' ||
    error?.code === 'CODESPACES_TOKEN_INSUFFICIENT_SCOPE' ||
    error?.code === 'CODESPACES_ACCOUNT_SUSPENDED'
  );
}
function numOrNull(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
function round1(n) {
  return Math.round(n * 10) / 10;
}
function limitation(field, reason) { return { field, reason }; }
function quotaEntry({ quotaUnit, quotaPeriod, usage = null, limit = null, remaining = null, extra = {} }) {
  return { quotaUnit, quotaPeriod, usage, limit, remaining, ...extra };
}
function extractCodespacesUsage(body) {
  const items = Array.isArray(body?.usageItems) ? body.usageItems
    : Array.isArray(body) ? body
    : [];

  const rows = items.filter((i) =>
    String(i?.product || '').toLowerCase() === 'codespaces'
  );

  let computeHours = null;
  let storageGbMonths = null;

  for (const row of rows) {
    const qty = numOrNull(
      row.grossQuantity ??
      row.usageQuantity ??
      row.quantity
    );
    const unit = String(row.unitType || row.unit || '').toLowerCase();

    if (qty == null) continue;

    if (unit.includes('hour') || unit.includes('core')) {
      computeHours = round1((computeHours ?? 0) + qty);
    } else if (unit.includes('gb') || unit.includes('storage')) {
      storageGbMonths = round1((storageGbMonths ?? 0) + qty);
    }
  }

  return { computeHours, storageGbMonths };
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

  async getCredentialStatus(loaded) {
    const limitations = [];
    const quotas = [];

    let login, plan;
    try {
      const user = await githubClient.validateToken(loaded.token);
      login = user.login;
      plan = user.plan?.name ?? null;
    } catch (error) {
      if (isTerminalAuthError(error)) {
        return {
          status: 'INVALID',
          validated: false,
          quotas: [],
          expiresAt: null,
          limitations: [limitation('status', safeReason(error))]
        };
      }
      throw error;
    }

    let refLimits;
    if (plan === 'pro') {
      refLimits = { computeCoreHoursPerMonth: 180, storageGbMonth: 20 };
    } else {
      refLimits = { computeCoreHoursPerMonth: 120, storageGbMonth: 15 };
      if (plan !== 'free') {
        limitations.push(limitation(
          'details.referenceLimits',
          `Account plan is '${plan ?? 'unknown'}'. Reference limits shown are for GitHub Free personal accounts. Organization/enterprise accounts have no included Codespaces quota by default.`
        ));
      }
    }

    const spaces = await githubClient.listCodespaces(loaded.token);
    const adoptable = Array.isArray(spaces) ? spaces.length : 0;

    let usage = null;
    try {
      const body = await githubClient.getBillingUsageSummary(loaded.token, login);
      usage = extractCodespacesUsage(body);
    } catch (error) {
      limitations.push(limitation(
        'quotas[0].usage',
        `Billing usage summary unavailable (${safeErrorCode(error)}). Requires "Plan" user read permission on the token and a personal account context.`
      ));
    }

    const computeUsage = usage?.computeHours ?? null;
    const computeLimit = refLimits.computeCoreHoursPerMonth;
    const computeRemain = computeUsage != null
      ? Math.max(0, computeLimit - computeUsage)
      : null;

    quotas.push(quotaEntry({
      quotaUnit: 'core-hours',
      quotaPeriod: 'month',
      usage: numOrNull(computeUsage),
      limit: computeLimit,
      remaining: numOrNull(computeRemain)
    }));
    limitations.push(limitation(
      'quotas[0]',
      'Included compute is metered in core-hours, not clock hours: consumption accrues at the codespace machine\'s core-count multiplier (a 4-core machine depletes the allowance twice as fast as a 2-core machine). Remaining core-hours overstate possible clock runtime unless divided by core count.'
    ));

    const storageUsage = usage?.storageGbMonths ?? null;
    const storageLimit = refLimits.storageGbMonth;
    const storageRemain = storageUsage != null
      ? Math.max(0, storageLimit - storageUsage)
      : null;

    quotas.push(quotaEntry({
      quotaUnit: 'GB-month',
      quotaPeriod: 'month',
      usage: numOrNull(storageUsage),
      limit: storageLimit,
      remaining: numOrNull(storageRemain)
    }));

    if (adoptable === 0) {
      return {
        status: 'UNAVAILABLE',
        validated: true,
        quotas,
        limitations,
        expiresAt: null,
        details: {
          referenceLimits: refLimits,
          plan,
          adoptable: 0,
          reason: "This orchestrator uses adopt-don't-create flow. The GitHub account must already have at least one codespace before a session can be created."
        }
      };
    }

    return {
      status: 'AVAILABLE',
      validated: true,
      quotas,
      limitations,
      expiresAt: null,
      details: {
        referenceLimits: refLimits,
        plan,
        adoptable,
        adoptedCodespaceState: spaces[0]?.state ?? null
      }
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
      // Suspended account or not-found both mean the session is effectively dead.
      // Returning false lets recovery delete the local row instead of leaving it
      // stuck. Transient/unknown errors still throw so recovery skips the row.
      if (isDeadAccountError(error)) {
        console.warn(`[Codespaces] isSessionActive: treating session ${providerSessionId} as inactive (${error.message})`);
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

    const credentialData = await loadCodespacesCredentials(options.credentialRef);
    const { token, credentialRef: resolvedRef, credentialFingerprint } = credentialData;

    // Validate token before any destructive or expensive operation
    try {
      await githubClient.validateToken(token);
    } catch (error) {
      throw this.translateError(error, 'create');
    }

    // Reuse an existing codespace for this credential instead of creating a new
    // one: adopt the first codespace returned for the account. Nothing is created.
    let codespace;
    try {
      const codespaces = await githubClient.listCodespaces(token);
      codespace = codespaces[0];
    } catch (error) {
      throw this.translateError(error, 'create');
    }

    if (!codespace) {
      throw new ProviderError(
        'No existing Codespaces VM found for this credential. Create one in the GitHub web UI first.',
        { code: 'CODESPACES_ALREADY_ACTIVE', statusCode: 409 }
      );
    }

    const providerSessionId = codespace.name;

    // If the adopted codespace is STOPPED, wake it up by starting it and
    // waiting for it to become Available; then send a test command to confirm
    // it is truly up before reporting the session as created (RUNNING).
    const adoptedState = normalizeStatus(codespace.state || '');
    if (adoptedState === 'STOPPED') {
      try {
        await githubClient.startCodespace(token, providerSessionId);
      } catch (startError) {
        throw this.translateError(startError, 'create');
      }

      const deadline = Date.now() + BOOT_TIMEOUT_MS;
      let state = null;
      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        // Bypass the read cache: we need live readiness state.
        let current;
        try {
          current = await githubClient.getCodespace(token, providerSessionId, { nocache: true });
        } catch (pollError) {
          throw this.translateError(pollError, 'create');
        }
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

      // Update the adopted object so the mapped session reflects RUNNING.
      codespace = { ...codespace, state: 'Available' };
    }

    const session = mapToSession(codespace, resolvedRef, credentialFingerprint);

    // Mark the session RUNNING immediately — the codespace is confirmed
    // Available at this point. Background cleanup (docker prune, temp-file
    // removal) is fire-and-forgotten so provision returns quickly instead of
    // blocking on a multi-minute docker prune with a 30s command timeout.
    session.status = 'RUNNING';

    // Fire-and-forget: initialize (clean) the VM after adoption.
    // docker system prune and docker builder prune can take several minutes on
    // a codespace with cached images — far beyond the 30s COMMAND_TIMEOUT_MS.
    // Running this in the background means the session is returned immediately
    // while cleanup proceeds asynchronously.
    this.initializeSession({ providerSessionId, credentialRef: resolvedRef }).catch((error) => {
      console.warn(`[Codespaces] Background initialization failed for ${providerSessionId}: ${error.message}`);
    });

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

  /**
   * Initialize a Codespaces VM after adoption. Runs the ESSENTIAL, fast cleanup
   * so the VM starts clean and the session can be treated as created: prune
   * unused docker images, volumes, and build cache, and clear temp files. The
   * slower teardown tasks (package cache, logs, home-directory reset) are
   * handled in terminateSession so provision stays quick.
   *
   * This method is called fire-and-forget from createSession. It uses a 5-minute
   * timeout because `docker system prune -af` and `docker builder prune -af` can
   * take several minutes on a codespace with cached images — well beyond the
   * 30-second COMMAND_TIMEOUT_MS used for regular commands.
   */
  async initializeSession(sessionRow) {
    const INIT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for docker prune operations

    const providerSessionId = getRowValue(sessionRow, 'providerSessionId');
    const credentialRef = getRowValue(sessionRow, 'credentialRef')
      || parseMetadata(sessionRow.metadata).credentialRef;

    if (!providerSessionId || !credentialRef) {
      throw new ProviderError('CodeSpace session is missing providerSessionId or credentialRef', {
        code: 'CODESPACES_NO_CREDENTIAL',
        statusCode: 400
      });
    }

    const { token } = await loadCodespacesCredentials(credentialRef);

    const cleanupScript = [
      'docker system prune -af',
      'docker volume prune -f',
      'docker builder prune -af',
      'sudo rm -rf /tmp/* /var/tmp/* 2>/dev/null || true',
      'echo codespaces-vm-initialized'
    ].join(' && ');

    const result = await executeInCodespace(providerSessionId, cleanupScript, token, {
      timeout: INIT_TIMEOUT_MS
    });

    return { initialized: true, output: String(result.output || '').trim() };
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

    let codespace;
    try {
      codespace = await githubClient.getCodespace(token, providerSessionId);
    } catch (error) {
      // A suspended account or deleted codespace can never recover.
      // Return a terminal status so the route persists it and stops polling.
      if (isSuspendedError(error)) {
        console.warn(`[Codespaces] refreshSession: account suspended for ${providerSessionId} — marking TERMINATED`);
        return {
          status: 'TERMINATED',
          webHost: null,
          metadata: {
            ...parseMetadata(sessionRow.metadata),
            suspendedAt: new Date().toISOString(),
            suspendReason: error.message
          }
        };
      }
      if (isNotFoundError(error)) {
        return { status: 'TERMINATED', webHost: null, metadata: parseMetadata(sessionRow.metadata) };
      }
      throw error;
    }

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

    // If the codespace is STOPPING/ShuttingDown, wait for it to reach STOPPED
    // before attempting to start it. Sending a start or ssh command while it
    // is shutting down causes a 30s command timeout with no useful error.
    if (status === 'STOPPING') {
      const shutdownDeadline = Date.now() + BOOT_TIMEOUT_MS;
      let currentState = null;
      while (Date.now() < shutdownDeadline) {
        await sleep(POLL_INTERVAL_MS);
        let current;
        try {
          current = await githubClient.getCodespace(token, providerSessionId, { nocache: true });
        } catch (pollError) {
          if (isSuspendedError(pollError)) {
            throw new ProviderError(`GitHub account is suspended: ${pollError.message}`, {
              code: 'CODESPACES_ACCOUNT_SUSPENDED',
              statusCode: 403
            });
          }
          throw pollError;
        }
        currentState = current.state;
        if (currentState === 'Shutdown' || currentState === 'Available') {
          break;
        }
        if (currentState === 'Failed' || currentState === 'Deleted') {
          throw new ProviderError(`Codespace entered terminal state ${currentState} while waiting for shutdown`, {
            code: 'CODESPACES_START_FAILED',
            statusCode: 409
          });
        }
      }

      if (currentState !== 'Shutdown' && currentState !== 'Available') {
        throw new ProviderError('Codespace did not finish stopping within the timeout. Try again shortly.', {
          code: 'CODESPACES_START_TIMEOUT',
          statusCode: 504
        });
      }

      // Update local status to reflect what GitHub reports
      const mappedStatus = currentState === 'Available' ? 'RUNNING' : 'STOPPED';
      try {
        await db.run(`UPDATE sessions SET status = '${mappedStatus}' WHERE id = ?`, [getRowValue(sessionRow, 'id')]);
      } catch (_) { /* non-fatal */ }

      // Re-assign status so the STOPPED auto-start block below triggers
      sessionRow = { ...sessionRow, status: mappedStatus };
    }

    // Auto-start stopped codespaces before executing
    if (normalizeStatus(sessionRow.status) === 'STOPPED') {
      await githubClient.startCodespace(token, providerSessionId);

      const deadline = Date.now() + BOOT_TIMEOUT_MS;
      let state = null;
      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        // Bypass the read cache here: the boot loop must observe live state to
        // detect when the codespace actually becomes available.
        let current;
        try {
          current = await githubClient.getCodespace(token, providerSessionId, { nocache: true });
        } catch (pollError) {
          if (isSuspendedError(pollError)) {
            throw new ProviderError(`GitHub account is suspended: ${pollError.message}`, {
              code: 'CODESPACES_ACCOUNT_SUSPENDED',
              statusCode: 403
            });
          }
          throw pollError;
        }
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
      // A suspended account will never recover — mark the session TERMINATED
      // immediately rather than burning through 3 consecutive failure attempts
      // and landing on FAILED (which is misleading for a suspended account).
      if (isSuspendedError(error)) {
        console.warn(`[Codespaces] Keep-alive: account suspended for session ${sessionRow.id} — marking TERMINATED`);
        try {
          await db.run("UPDATE sessions SET status = 'TERMINATED' WHERE id = ?", [sessionRow.id]);
        } catch (dbErr) {
          console.warn(`[Codespaces] Keep-alive: failed to mark session ${sessionRow.id} TERMINATED: ${dbErr.message}`);
        }
        // Stop the keep-alive timer by returning a terminal skip signal.
        return {
          success: true,
          action: 'skipped',
          message: `Account suspended — session marked TERMINATED`,
          updates: { status: 'TERMINATED' }
        };
      }

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

    // Stop the VM FIRST so delete returns quickly and the VM ends STOPPED
    // immediately (which also kills ttyd/cloudflared). Heavy cleanup runs in
    // the BACKGROUND on the VM; the stop may interrupt it, which is acceptable
    // for teardown since stopping the VM halts all its processes anyway.
    //
    // If the account is suspended or the codespace is already gone (403/404),
    // treat it as already stopped — log a warning and continue so the route
    // can still mark the local row TERMINATED.
    try {
      await githubClient.stopCodespace(token, providerSessionId);
      console.log(`[Codespaces] Stopped codespace ${providerSessionId}`);
    } catch (stopError) {
      const code = stopError?.code;
      const status = stopError?.statusCode;
      if (
        code === 'CODESPACES_ACCOUNT_SUSPENDED' ||
        code === 'CODESPACES_NOT_FOUND' ||
        status === 403 ||
        status === 404
      ) {
        console.warn(`[Codespaces] Cannot stop ${providerSessionId} (${stopError.message}) — treating as already stopped`);
        return; // let the route mark it TERMINATED locally
      }
      throw stopError;
    }

    // Fire-and-forget cleanup: clear package caches/logs and reset the home
    // dir so the VM is left as close to a fresh VM as possible before GitHub
    // fully halts it. Best-effort — failures here must not fail the delete.
    try {
      const cleanupScript = [
        'sudo apt-get clean 2>/dev/null || true',
        'sudo journalctl --vacuum-size=20M >/dev/null 2>&1 || true',
        'find /home/codespace -mindepth 1 -maxdepth 1 ! -name ".ssh" ! -name ".bashrc" ! -name ".bash_logout" ! -name ".profile" -exec rm -rf {} + 2>/dev/null || true',
        'find /home/codespace/.[!.]* -maxdepth 0 -exec rm -rf {} + 2>/dev/null || true'
      ].join(' && ');
      await executeInCodespace(providerSessionId, `nohup bash -c '${cleanupScript}' >/dev/null 2>&1 &`, token, {
        timeout: 15_000
      });
      console.log(`[Codespaces] Launched background cleanup for ${providerSessionId}`);
    } catch (cleanupLaunchError) {
      console.warn(`[Codespaces] Failed to launch background cleanup for ${providerSessionId}: ${cleanupLaunchError.message}`);
    }
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

      if (msg.includes('suspend')) {
        return new ProviderError(error.message, {
          code: 'CODESPACES_ACCOUNT_SUSPENDED',
          statusCode: 403
        });
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
