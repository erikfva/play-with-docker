# Session Keep-Alive Architecture (Multi-Provider)

## Problem Analysis

Different providers have different **inactivity timeout behaviors** that can suspend or terminate sessions:

| Provider | Timeout Behavior | Issue |
|----------|------------------|-------|
| **GCS (Google Cloud Shell)** | 20 minutes of inactivity → SUSPENDED | Requires SSH activity to reset timer |
| **PWD (Play with Docker)** | Time-limited sessions (few hours) | May need different strategy or none needed |
| **Other Future Providers** | Provider-specific | Each needs own keep-alive mechanism |

### Current Implementation Gap

The code currently:
- ✅ Creates sessions across multiple providers
- ✅ Polls environment status
- ✅ Executes commands when requested
- ❌ **No provider-aware keep-alive mechanism**
- ❌ **GCS-specific keep-alive hardcoding if implemented**
- ❌ **No abstraction for different provider needs**

### Key Issue

Without a **provider-aware keep-alive architecture**, the app cannot:
1. Handle provider-specific inactivity timeouts
2. Scale to multiple providers cleanly
3. Configure per-provider keep-alive strategies
4. Disable unnecessary keep-alive for providers that don't need it

---

## Provider-Aware Keep-Alive Architecture

### Core Design Principle

**Each provider is responsible for defining its own keep-alive behavior**, controlled by methods on the provider class.

### Provider Interface (BaseProvider)

Add these methods to [src/services/providers/base-provider.js](src/services/providers/base-provider.js):

```javascript
class BaseProvider {
  // ... existing methods ...

  /**
   * Get keep-alive configuration for this provider
   * @returns {Object} Configuration object
   * @returns {boolean} enabled - Whether keep-alive is needed
   * @returns {number} intervalMinutes - How often to check (null if not needed)
   * @returns {string} strategy - 'ssh-command' | 'api-call' | 'none' | custom
   */
  getKeepAliveConfig() {
    return {
      enabled: false,
      intervalMinutes: null,
      strategy: 'none'
    };
  }

  /**
   * Execute keep-alive for this provider
   * Called periodically by keep-alive-service
   * @param {Object} sessionRow - Session database row with metadata
   * @returns {Object} Status update
   */
  async executeKeepAlive(sessionRow) {
    throw new Error('executeKeepAlive must be implemented by provider');
  }

  /**
   * Check if session is in a suspended/inactive state
   * @param {Object} sessionRow - Session database row
   * @returns {boolean} true if active, false if suspended/inactive
   */
  async isSessionActive(sessionRow) {
    throw new Error('isSessionActive must be implemented by provider');
  }
}
```

---

## Provider-Specific Implementations

### GCS Provider Keep-Alive (GCS-Specific)

**GCS Profile:**
- Timeout: 20 minutes of inactivity
- Activity: SSH commands reset timer
- State: Can be SUSPENDED
- Strategy: Periodic SSH echo command

**Update [src/services/providers/gcs-provider.js](src/services/providers/gcs-provider.js):**

```javascript
const BaseProvider = require('./base-provider');

class GcsProvider extends BaseProvider {
  constructor() {
    super('gcs');
  }

  getKeepAliveConfig() {
    return {
      enabled: true,
      intervalMinutes: 15,  // Send keep-alive every 15 minutes (before 20-min timeout)
      strategy: 'ssh-command'
    };
  }

  async isSessionActive(sessionRow) {
    const status = await gcsService.getCloudShellStatus(
      this.getProviderSessionId(sessionRow)
    );
    return status.status === 'RUNNING';
  }

  async executeKeepAlive(sessionRow) {
    try {
      const status = await gcsService.getCloudShellStatus(
        this.getProviderSessionId(sessionRow)
      );

      // Check if suspended, attempt resume if needed
      if (status.status === 'SUSPENDED') {
        console.log(`[GCS] Session ${sessionRow.id} detected as SUSPENDED. Resuming...`);
        await gcsService.startCloudShellSession();
        return {
          success: true,
          action: 'resumed',
          message: 'Session was suspended, resuming now'
        };
      }

      // If not running yet, don't send commands
      if (status.status !== 'RUNNING') {
        return {
          success: false,
          action: 'wait',
          message: `Session not ready (${status.status}), skipping keep-alive`
        };
      }

      // Send harmless SSH command to reset inactivity timer
      const output = await sshService.executeCommand(
        {
          host: status.sshHost,
          port: status.sshPort || 22,
          username: status.sshUsername
        },
        'echo "Keep-alive: $(date)"',
        sessionRow.privateKey
      );

      return {
        success: true,
        action: 'keep-alive-sent',
        message: output.trim()
      };
    } catch (error) {
      console.warn(`[GCS] Keep-alive failed for session ${sessionRow.id}: ${error.message}`);
      return {
        success: false,
        action: 'error',
        error: error.message
      };
    }
  }

  // ... other methods ...
}
```

### PWD Provider Keep-Alive (No Action Needed)

**PWD Profile:**
- Timeout: Long-lived sessions (few hours or manual cleanup)
- Strategy: No keep-alive needed
- State: Can be manually terminated

**Update [src/services/providers/pwd-provider.js](src/services/providers/pwd-provider.js):**

```javascript
class PwdProvider extends BaseProvider {
  constructor() {
    super('pwd');
  }

  getKeepAliveConfig() {
    return {
      enabled: false,
      intervalMinutes: null,
      strategy: 'none'  // PWD doesn't need keep-alive
    };
  }

  async isSessionActive(sessionRow) {
    // PWD sessions don't have inactivity concerns
    return true;
  }

  async executeKeepAlive(sessionRow) {
    // Not called for PWD, but implement for safety
    return {
      success: true,
      action: 'skipped',
      message: 'PWD provider does not require keep-alive'
    };
  }

  // ... other methods ...
}
```

---

## Generic Keep-Alive Service

**Create [src/services/keep-alive-service.js](src/services/keep-alive-service.js):**

```javascript
/**
 * Provider-agnostic keep-alive service
 * Uses provider's keep-alive configuration to manage session activity
 */

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
    `[KeepAlive] Starting ${provider.name} keep-alive (interval: ${config.intervalMinutes}m)`
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
      } else {
        stats.failures++;
        console.warn(
          `[KeepAlive] ✗ ${provider.name} session ${sessionRow.id}: ${result.message}`
        );
      }
    } catch (error) {
      const stats = keepAliveStats.get(sessionRow.id);
      stats.attempts++;
      stats.failures++;
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
 * @returns {Object} Statistics
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
```

---

## Route Integration

### Update Session Creation (POST /sessions)

**Modify [src/routes/sessions.js](src/routes/sessions.js):**

```javascript
const keepAliveService = require('../services/keep-alive-service');

router.post('/', async (req, res) => {
  try {
    const provider = getProvider(req.body?.provider || 'gcs');
    const created = await provider.createSession(req.body || {});
    const id = uuidv4();

    // Insert into database
    await dbRun(
      `INSERT INTO sessions (id, provider, providerSessionId, status, metadata)
       VALUES (?, ?, ?, ?, ?)`,
      [id, provider.name, created.providerSessionId, created.status, JSON.stringify(created.metadata)]
    );

    const sessionRow = await dbGet('SELECT * FROM sessions WHERE id = ?', [id]);

    // START KEEP-ALIVE (provider-aware)
    // Will only start if the provider has it enabled
    keepAliveService.startKeepAlive(sessionRow, provider);

    return res.status(201).json({
      id,
      message: `Session created with ${provider.name} provider`,
      ...created
    });
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to create session');
  }
});
```

### Update Session Deletion (DELETE /sessions/:id)

```javascript
router.delete('/:id', async (req, res) => {
  try {
    const row = await dbGet('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    if (!row) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const provider = getProvider(row.provider);

    // STOP KEEP-ALIVE BEFORE TERMINATING
    keepAliveService.stopKeepAlive(row.id);

    // Display keep-alive stats if available
    const stats = keepAliveService.getKeepAliveStats(row.id);
    if (stats) {
      console.log(`Session ${row.id} keep-alive stats:`, stats);
    }

    try {
      await provider.terminateSession(row);
    } catch (providerError) {
      console.warn(`Provider termination failed for session ${row.id}:`, providerError.message);
    }

    await dbRun('DELETE FROM sessions WHERE id = ?', [row.id]);

    return res.json({
      message: `Session ${row.id} (${row.provider}) terminated`,
      keepAliveStats: stats
    });
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to terminate session');
  }
});
```

---
## Configuration (Optional)

```bash
# .env - Optional overrides per provider
GCS_KEEP_ALIVE_ENABLED=1
GCS_KEEP_ALIVE_INTERVAL_MINUTES=15
PWD_KEEP_ALIVE_ENABLED=0  # Not needed for PWD
```

---

## Implementation Roadmap

### Phase 1: Add Provider Interface ✓ RECOMMENDED FIRST STEP

1. Add `getKeepAliveConfig()` to [src/services/providers/base-provider.js](src/services/providers/base-provider.js)
2. Add `executeKeepAlive()` to BaseProvider
3. Add `isSessionActive()` to BaseProvider

### Phase 2: Implement Provider-Specific Logic

1. **GCS Provider**: Implement SSH keep-alive + suspension detection
2. **PWD Provider**: Implement disabled keep-alive (returns success)
3. **Future Providers**: Follow same pattern

### Phase 3: Create Generic Keep-Alive Service

1. Create `src/services/keep-alive-service.js`
2. Use provider's config to manage timers generically
3. Track statistics per session

### Phase 4: Integrate with Routes

1. Call `startKeepAlive()` when session is created
2. Call `stopKeepAlive()` when session is deleted
3. Expose keep-alive stats in API

---

## Migration Path (If Already Using GCS-Specific Code)

If you already implemented GCS-specific keep-alive:

1. Move GCS logic into `GCSProvider.executeKeepAlive()`
2. Create generic `keep-alive-service.js` as shown above
3. Update routes to use generic service
4. PWD provider automatically gets "no keep-alive" behavior

---

## Benefits of This Architecture

✅ **Provider-Agnostic**: Each provider defines its own needs  
✅ **Extensible**: Adding new providers is trivial  
✅ **Maintainable**: Keep-alive logic lives in provider, not scattered  
✅ **Configurable**: Easy to enable/disable per provider  
✅ **Observable**: Built-in statistics and logging  
✅ **Scalable**: Generic service handles any provider strategy

---

## Summary

This provider-aware architecture ensures that:

- **GCS Provider** keeps sessions alive with periodic SSH commands
- **PWD Provider** skips keep-alive entirely (not needed)
- **Future Providers** implement their specific keep-alive strategies
- **Generic Service** handles orchestration without knowing provider details
- **Easy Testing** - Use `getKeepAliveStats()` to verify keep-alive is working

The key is moving keep-alive logic **into the provider** where it belongs, rather than having GCS-specific code scattered throughout your application.
