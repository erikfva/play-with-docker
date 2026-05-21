/**
 * Provider-agnostic keep-alive service
 * Uses provider's keep-alive configuration to manage session activity
 */

const db = require('../db/db');
const { getProvider } = require('./provider-factory');

const activeKeepAliveTimers = new Map();
const keepAliveStats = new Map();
const TERMINAL_SESSION_STATUSES = new Set(['TERMINATED', 'DELETED', 'FAILED']);

function normalizeStatus(status) {
  if (!status) return '';
  return String(status).trim().toUpperCase();
}

function isTerminalStatus(status) {
  return TERMINAL_SESSION_STATUSES.has(normalizeStatus(status));
}

/**
 * Start keep-alive for a session
 * @param {Object} sessionRow - Session from database
 * @param {Object} provider - Provider instance
 */
async function startKeepAlive(sessionRow, provider) {
  const config = provider.getKeepAliveConfig(sessionRow);

  // Don't start if provider doesn't need keep-alive
  if (!config.enabled) {
    console.log(`[KeepAlive] Skipping keep-alive for ${provider.name} provider (disabled)`);
    return;
  }

  if (!Number.isFinite(config.intervalMinutes) || config.intervalMinutes <= 0) {
    console.warn(
      `[KeepAlive] Skipping keep-alive for ${provider.name} session ${sessionRow.id}: invalid interval ${config.intervalMinutes}`
    );
    return;
  }

  if (activeKeepAliveTimers.has(sessionRow.id)) {
    console.log(`[KeepAlive] Already running for session ${sessionRow.id}`);
    return;
  }

  console.log(
    `[KeepAlive] Starting ${provider.name} keep-alive (interval: ${config.intervalMinutes}m, strategy: ${config.strategy})`
  );

  // Initialize stats
  keepAliveStats.set(sessionRow.id, {
    provider: provider.name,
    startedAt: new Date(),
    attempts: 0,
    successes: 0,
    failures: 0,
    lastRunAt: null
  });

  async function runKeepAlive() {
    try {
      const stats = keepAliveStats.get(sessionRow.id);

      // Execute provider-specific keep-alive
      const result = await provider.executeKeepAlive(sessionRow);

      stats.attempts++;
      stats.lastRunAt = new Date();

      if (result.success) {
        stats.successes++;
        console.log(
          `[KeepAlive] ✓ ${provider.name} session ${sessionRow.id}: ${result.message}`
        );

        // Update database with any updates (e.g., SSH keys generated during keep-alive)
        if (result.updates && Object.keys(result.updates).length > 0) {
          try {
            const updateFields = [];
            const updateValues = [];

            if (result.updates.privateKey !== undefined) {
              updateFields.push('privateKey = ?');
              updateValues.push(result.updates.privateKey);
              sessionRow.privateKey = result.updates.privateKey;
            }
            if (result.updates.publicKey !== undefined) {
              updateFields.push('publicKey = ?');
              updateValues.push(result.updates.publicKey);
              sessionRow.publicKey = result.updates.publicKey;
            }
            if (result.updates.sshCommand !== undefined) {
              updateFields.push('sshCommand = ?');
              updateValues.push(result.updates.sshCommand);
              sessionRow.sshCommand = result.updates.sshCommand;
              sessionRow.sshcommand = result.updates.sshCommand;
            }
            if (result.updates.status !== undefined) {
              updateFields.push('status = ?');
              updateValues.push(result.updates.status);
              sessionRow.status = result.updates.status;
            }
            if (result.updates.metadata !== undefined) {
              const metadata = typeof result.updates.metadata === 'string'
                ? result.updates.metadata
                : JSON.stringify(result.updates.metadata);
              updateFields.push('metadata = ?');
              updateValues.push(metadata);
              sessionRow.metadata = metadata;
            }

            if (updateFields.length > 0) {
              updateValues.push(sessionRow.id);
              await db.run(
                `UPDATE sessions SET ${updateFields.join(', ')} WHERE id = ?`,
                updateValues
              );
              console.log(`[KeepAlive] Updated database for session ${sessionRow.id} with: ${updateFields.join(', ')}`);
            }
          } catch (dbError) {
            console.warn(`[KeepAlive] Failed to update database for session ${sessionRow.id}:`, dbError.message);
          }
        }
      } else {
        stats.failures++;
        console.warn(
          `[KeepAlive] ✗ ${provider.name} session ${sessionRow.id}: ${result.message}`
        );
      }
    } catch (error) {
      const stats = keepAliveStats.get(sessionRow.id);
      if (stats) {
        stats.attempts++;
        stats.failures++;
      }
      console.error(`[KeepAlive] Unexpected error for session ${sessionRow.id}:`, error);
    }
  }

  const intervalMs = config.intervalMinutes * 60 * 1000;
  const timer = setInterval(runKeepAlive, intervalMs);

  activeKeepAliveTimers.set(sessionRow.id, timer);

  if (config.runOnStart) {
    setImmediate(runKeepAlive);
  }
}

/**
 * Recover keep-alive timers from persisted sessions on startup.
 * This method is best-effort and continues processing even if one session fails.
 * @returns {Object} recovery summary
 */
async function recoverKeepAlivesOnStartup() {
  const summary = {
    scanned: 0,
    eligible: 0,
    started: 0,
    cleaned: 0,
    skipped: 0,
    failed: 0
  };

  let rows = [];
  try {
    rows = await db.all('SELECT * FROM sessions');
  } catch (error) {
    console.error('[KeepAlive][Recovery] Failed to load sessions from database:', error.message);
    summary.failed += 1;
    return summary;
  }

  summary.scanned = rows.length;
  if (summary.scanned === 0) {
    return summary;
  }

  console.log('[KeepAlive][Recovery] Starting keep-alive recovery from database');

  for (const sessionRow of rows) {
    try {
      let provider;
      try {
        provider = getProvider(sessionRow.provider);
      } catch (error) {
        summary.skipped += 1;
        console.warn(
          `[KeepAlive][Recovery] Skipping session ${sessionRow.id}: unsupported provider "${sessionRow.provider}"`
        );
        continue;
      }

      const keepAliveConfig = provider.getKeepAliveConfig(sessionRow);
      if (!keepAliveConfig.enabled) {
        summary.skipped += 1;
        continue;
      }

      if (isTerminalStatus(sessionRow.status)) {
        summary.skipped += 1;
        continue;
      }

      summary.eligible += 1;

      // For GCS recovery, verify remote session is still active before scheduling keep-alive.
      if (provider.name === 'gcs') {
        try {
          const isActive = await provider.isSessionActive(sessionRow);
          if (!isActive) {
            await db.run('DELETE FROM sessions WHERE id = ?', [sessionRow.id]);
            summary.cleaned += 1;
            console.log(
              `[KeepAlive][Recovery] Cleaned stale gcs session ${sessionRow.id}: remote session inactive/stopped`
            );
            continue;
          }
        } catch (error) {
          summary.failed += 1;
          console.warn(
            `[KeepAlive][Recovery] Failed active-check for session ${sessionRow.id}: ${error.message}`
          );
          continue;
        }
      }

      const alreadyRunning = activeKeepAliveTimers.has(sessionRow.id);
      await startKeepAlive(sessionRow, provider);
      if (alreadyRunning) {
        summary.skipped += 1;
      } else {
        summary.started += 1;
      }
    } catch (error) {
      summary.failed += 1;
      console.warn(
        `[KeepAlive][Recovery] Failed to recover session ${sessionRow.id}: ${error.message}`
      );
    }
  }

  console.log(
    `[KeepAlive][Recovery] scanned=${summary.scanned} eligible=${summary.eligible} started=${summary.started} cleaned=${summary.cleaned} skipped=${summary.skipped} failed=${summary.failed}`
  );

  return summary;
}

/**
 * Stop keep-alive for a session
 * @param {string} sessionId - Session ID
 */
function stopKeepAlive(sessionId) {
  const timer = activeKeepAliveTimers.get(sessionId);
  if (timer) {
    clearInterval(timer);
    activeKeepAliveTimers.delete(sessionId);

    const stats = keepAliveStats.get(sessionId);
    if (stats) {
      console.log(
        `[KeepAlive] Stopped ${stats.provider} keep-alive for session ${sessionId} ` +
        `(${stats.successes}/${stats.attempts} successes)`
      );
    }
  }
}

/**
 * Get keep-alive statistics for a session
 * @param {string} sessionId - Session ID
 * @returns {Object} Statistics or null if not found
 */
function getKeepAliveStats(sessionId) {
  return keepAliveStats.get(sessionId) || null;
}

/**
 * Stop all active keep-alive timers
 * (useful for cleanup/shutdown)
 */
function stopAllKeepAlives() {
  for (const [sessionId, timer] of activeKeepAliveTimers.entries()) {
    clearInterval(timer);
  }
  activeKeepAliveTimers.clear();
  console.log('[KeepAlive] All keep-alive timers stopped');
}

module.exports = {
  startKeepAlive,
  recoverKeepAlivesOnStartup,
  stopKeepAlive,
  getKeepAliveStats,
  stopAllKeepAlives
};
