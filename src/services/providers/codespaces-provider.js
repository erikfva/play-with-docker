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

function redactTokensFromMessage(msg) { return String(msg || '').replace(/\b[A-Za-z0-9_\-]{20,}\b/g, '[REDACTED]'); }
function safeReason(error) { const msg = error?.message || 'unknown error'; return redactTokensFromMessage(msg); }
function safeErrorCode(error) { return error?.code || (error?.statusCode ? `HTTP_${error.statusCode}` : null) || (error?.status ? `HTTP_${error.status}` : null) || 'UNKNOWN_ERROR'; }
function isTerminalAuthError(error) { return ( error?.code === 'CODESPACES_TOKEN_INVALID' || error?.code === 'CODESPACES_TOKEN_INSUFFICIENT_SCOPE' || error?.code === 'CODESPACES_ACCOUNT_SUSPENDED' ); }
function numOrNull(n) { return typeof n === 'number' && Number.isFinite(n) ? n : null; }
function round1(n) { return Math.round(n * 10) / 10; }
function limitation(field, reason) { return { field, reason }; }
function quotaEntry({ name = null, quotaUnit, quotaPeriod, usage = null, limit = null, remaining = null, extra = {} }) { return { ...(name ? { name } : {}), quotaUnit, quotaPeriod, usage, limit, remaining, ...extra }; }
/**
 * Aggregate month-to-date Codespaces usage from billing usageItems.
 *
 * SKU-driven classification (NOT product-gated): GitHub reports compute and
 * storage rows with product "Codespaces" and skus like "Codespaces Compute" /
 * "Codespaces Storage", but storage historically also appears under
 * "Shared Storage" with a codespaces-flavoured sku — a strict
 * `product === 'codespaces'` filter silently drops those rows (the bug that
 * left storage usage permanently null for container-100). We therefore match
 * primarily on normalized sku text and only use product as a tiebreak.
 *
 * Quantity semantics: `quantity` is GROSS consumption before included-plan
 * discounts; `netQuantity` is net of included amounts. The quota entries we
 * produce are gross usage vs the included limit, so gross `quantity` is the
 * right field — `grossQuantity` (an alias present in some payloads) is
 * accepted, `netQuantity` is explicitly NOT used.
 *
 * Unit awareness: compute rows may be metered in core-hours already, or in
 * per-machine clock minutes/hours that must be scaled by core count. Storage
 * is normalized to GB-months. Unknown units are treated as already-normalized
 * and summed rather than dropped.
 */
function extractCodespacesUsage(body) {
  const items = Array.isArray(body?.usageItems) ? body.usageItems : Array.isArray(body) ? body : [];
  const rows = items.filter((i) => {
    const text = `${i?.product || ''} ${i?.sku || ''}`.toLowerCase();
    return text.includes('codespace') || text.includes('shared storage');
  });
  let computeCoreHours = null; let storageGbMonths = null;
  for (const row of rows) {
    const qty = numOrNull(row.quantity ?? row.grossQuantity ?? row.usageQuantity);
    if (qty == null) continue;
    const sku = String(row.sku || '').toLowerCase();
    const unit = String(row.unitType || row.unit || '').toLowerCase();
    const isStorageSku = sku.includes('storage');
    const isStorageUnit = unit.includes('gb') || unit.includes('storage') || unit.includes('byte');
    const isComputeSku = !isStorageSku && (sku.includes('compute') || sku.includes('codespace'));
    const isComputeUnit = unit.includes('hour') || unit.includes('core') || unit.includes('min');
    if (isStorageSku || (isStorageUnit && !isComputeSku)) {
      // Unit normalization to GB-months: "GB-months"/"gigabytes" are taken as
      // GB-months directly; minutes/hours on a storage row are MB-min style
      // prorations — without the sku's MB base we cannot convert, so keep raw.
      storageGbMonths = round1((storageGbMonths ?? 0) + qty);
    } else if (isComputeSku || isComputeUnit) {
      // Per-machine rows report wall-clock minutes/hours for a specific core
      // count ("2-core", "4-core" in the sku). Scale to core-hours so the sum
      // is comparable to the 120/180 core-hour included limits.
      const coreMatch = sku.match(/(\d+)\s*-?\s*core/i);
      const cores = coreMatch ? Number.parseInt(coreMatch[1], 10) : 1;
      let hours = qty;
      if (unit.includes('min') && !unit.includes('month')) {
        hours = qty / 60;
      }
      computeCoreHours = round1((computeCoreHours ?? 0) + hours * cores);
    } else {
      // Unknown unit on a codespaces row: count as compute rather than drop.
      computeCoreHours = round1((computeCoreHours ?? 0) + qty);
    }
  }
  return { computeHours: computeCoreHours, storageGbMonths };
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
    try { const user = await githubClient.validateToken(loaded.token); login = user.login; plan = user.plan?.name ?? null; } catch (error) { if (isTerminalAuthError(error)) { return { status: 'INVALID', validated: false, quotas: [], expiresAt: null, limitations: [limitation('status', safeReason(error))] }; } throw error; }
    let refLimits;
    if (plan === 'pro') { refLimits = { computeCoreHoursPerMonth: 180, storageGbMonth: 20 }; } else { refLimits = { computeCoreHoursPerMonth: 120, storageGbMonth: 15 }; if (plan !== 'free') { limitations.push(limitation('details.referenceLimits', `Account plan is '${plan ?? 'unknown'}'. Reference limits shown are for GitHub Free personal accounts. Organization/enterprise accounts have no included Codespaces quota by default.`)); } }
    const spaces = await githubClient.listCodespaces(loaded.token);
    const adoptable = Array.isArray(spaces) ? spaces.length : 0;
    let usage = null;
    let billingPeriod = null;
    try { const body = await githubClient.getMonthlyCodespacesUsage(loaded.token, login); usage = extractCodespacesUsage(body); billingPeriod = body?.billingPeriod ?? null; } catch (error) { limitations.push(limitation('quotas[0].usage', `Billing usage unavailable (${safeErrorCode(error)}). Month-to-date usage is read from the user billing usage report; it requires the token to have billing read permission on a personal account context.`)); }
    const computeUsage = usage?.computeHours ?? null;
    const computeLimit = refLimits.computeCoreHoursPerMonth;
    const computeRemain = computeUsage != null ? Math.max(0, round1(computeLimit - computeUsage)) : null;
    const computeQuota = quotaEntry({ name: 'Codespaces compute (core-hours)', quotaUnit: 'core-hours', quotaPeriod: 'month', usage: numOrNull(computeUsage), limit: computeLimit, remaining: numOrNull(computeRemain), extra: { ...(billingPeriod ? { billingPeriod } : {}) } });
    // Escalate before pushing: a zero remaining allowance is a definitive
    // quota verdict, not a passing check.
    const computeExhausted = computeQuota.remaining === 0 && computeQuota.limit != null;
    quotas.push(computeQuota);
    limitations.push(limitation('quotas[0]', 'Included compute is metered in core-hours, not clock hours: consumption accrues at the codespace machine\'s core-count multiplier (a 4-core machine depletes the allowance twice as fast as a 2-core machine). Remaining core-hours overstate possible clock runtime unless divided by core count.'));
    const storageUsage = usage?.storageGbMonths ?? null;
    const storageLimit = refLimits.storageGbMonth;
    const storageRemain = storageUsage != null ? Math.max(0, round1(storageLimit - storageUsage)) : null;
    const storageQuota = quotaEntry({ name: 'Codespaces storage (GB-month)', quotaUnit: 'GB-month', quotaPeriod: 'month', usage: numOrNull(storageUsage), limit: storageLimit, remaining: numOrNull(storageRemain), extra: { ...(billingPeriod ? { billingPeriod } : {}) } });
    const storageExhausted = storageQuota.remaining === 0 && storageQuota.limit != null;
    quotas.push(storageQuota);
    const quotaExhausted = computeExhausted || storageExhausted;
    const details = { referenceLimits: refLimits, plan, adoptable, ...(billingPeriod ? { billingPeriod } : {}), ...(spaces[0]?.state != null ? { adoptedCodespaceState: spaces[0].state } : {}) };
    if (adoptable === 0) {
      return { status: 'UNAVAILABLE', validated: true, quotas, limitations, expiresAt: null, details: { ...details, adoptable: 0, reason: "This orchestrator uses adopt-don\'t-create flow. The GitHub account must already have at least one codespace before a session can be created." } };
    }
    if (quotaExhausted) {
      return { status: 'QUOTA_EXHAUSTED', validated: true, quotas, limitations, expiresAt: null, details };
    }
    return { status: 'AVAILABLE', validated: true, quotas, limitations, expiresAt: null, details };
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

    // Run the VM initialization (docker prune + temp-file cleanup) synchronously
    // so we confirm the codespace is actually usable before committing the session
    // to the database. In particular, this catches billing errors (HTTP 402) that
    // only surface when the first SSH command is attempted — GitHub allows listing
    // and adopting a codespace even when billing blocks its use.
    //
    // If initialization fails due to a billing issue or other fatal error, the
    // session is NOT persisted and the error is returned to the caller.
    // Non-fatal/transient failures (timeouts, generic SSH errors) are tolerated
    // so a slow or busy codespace doesn't block adoption.
    try {
      await this.initializeSession({ providerSessionId, credentialRef: resolvedRef });
    } catch (initError) {
      // Billing errors and account suspension are definitive — the codespace
      // cannot be used at all. Abort without persisting the session.
      if (
        initError.code === 'CODESPACES_BILLING_ERROR' ||
        initError.code === 'CODESPACES_ACCOUNT_SUSPENDED' ||
        initError.code === 'CODESPACES_TOKEN_INVALID'
      ) {
        throw initError;
      }
      // All other errors (timeout, command failed, etc.) are treated as
      // non-fatal: log a warning and continue — the session will be created
      // and the user can still run commands.
      console.warn(`[Codespaces] Non-fatal initialization failure for ${providerSessionId}: ${initError.message}`);
    }

    session.status = 'RUNNING';

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
   * unused docker images, volumes, and build cache, and clear temp files.
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

    const initializedMessage = 'echo codespaces-vm-initialized';
    const cleanupScript = [
      'docker system prune -af',
      'docker volume prune -f',
      'docker builder prune -af',
      'sudo rm -rf /tmp/* /var/tmp/* 2>/dev/null || true',
      initializedMessage
    ].join(' && ');

    const result = await executeInCodespace(providerSessionId, initializedMessage, token, {
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
      try {
        await githubClient.startCodespace(token, providerSessionId);
      } catch (startError) {
        // A billing issue (402) means the codespace cannot be started at all —
        // mark the session FAILED so it is not retried, then surface the error.
        if (startError.code === 'CODESPACES_BILLING_ERROR') {
          try {
            await db.run("UPDATE sessions SET status = 'FAILED' WHERE id = ?", [getRowValue(sessionRow, 'id')]);
          } catch (dbErr) {
            console.warn(`[Codespaces] executeCommand: failed to mark session FAILED after billing error: ${dbErr.message}`);
          }
          throw startError;
        }
        throw startError;
      }

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

    // Stop the VM so it ends STOPPED immediately (which also kills ttyd/cloudflared).
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

    // Cleanup was previously attempted here via a fire-and-forget SSH command,
    // but the VM is already stopping at this point so the SSH attempt almost
    // always timed out (burning the full 15s timeout) before the stop completed.
    // The stop itself kills all running processes, so no explicit cleanup is
    // needed — GitHub will garbage-collect the VM on its own schedule.
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
