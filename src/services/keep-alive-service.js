/**
 * Provider-agnostic keep-alive service
 * Uses provider's keep-alive configuration to manage session activity
 */

const db = require('../db/db');

const activeKeepAliveTimers = new Map();
const keepAliveStats = new Map();

/**
 * Start keep-alive for a session
 * @param {Object} sessionRow - Session from database
 * @param {Object} provider - Provider instance
 */
async function startKeepAlive(sessionRow, provider) {
  const config = provider.getKeepAliveConfig();

  // Don't start if provider doesn't need keep-alive
  if (!config.enabled) {
    console.log(`[KeepAlive] Skipping keep-alive for ${provider.name} provider (disabled)`);
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

  const intervalMs = config.intervalMinutes * 60 * 1000;
  const timer = setInterval(async () => {
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
            }
            if (result.updates.publicKey !== undefined) {
              updateFields.push('publicKey = ?');
              updateValues.push(result.updates.publicKey);
            }
            if (result.updates.sshCommand !== undefined) {
              updateFields.push('sshCommand = ?');
              updateValues.push(result.updates.sshCommand);
            }
            if (result.updates.status !== undefined) {
              updateFields.push('status = ?');
              updateValues.push(result.updates.status);
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
  }, intervalMs);

  activeKeepAliveTimers.set(sessionRow.id, timer);
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
  stopKeepAlive,
  getKeepAliveStats,
  stopAllKeepAlives
};
