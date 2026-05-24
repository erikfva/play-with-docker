const BaseProvider = require('./base-provider');
const gcsService = require('../gcs-service');
const { initGoogleCredentialsFromS3IfNeeded } = require('../google-credentials-loader');
const sshService = require('../ssh-service');
const { SessionNotReadyError } = require('../errors/provider-errors');
const { getRowValue } = require('../../utils/helpers');

function isExpectedShutdownDisconnect(error) {
  if (!error || !error.message) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('connection') ||
    message.includes('closed') ||
    message.includes('eof') ||
    message.includes('socket hang up') ||
    message.includes('powering off')
  );
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

const KEEP_ALIVE_INTERVAL_MINUTES = 10

class MissingGoogleCredentialRefError extends Error {
  constructor() {
    super('Google credential reference is missing for this session');
    this.code = 'GOOGLE_CREDENTIALS_MISSING';
  }
}

class GcsProvider extends BaseProvider {
  constructor() {
    super('gcs');
  }

  getProviderSessionId(sessionRow) {
    const { providersessionid, envname } = sessionRow;
    return sessionRow.providerSessionId || providersessionid || sessionRow.envName || envname;
  }

  getCredentialRef(sessionRow) {
    const metadata = parseMetadata(sessionRow?.metadata);
    return getRowValue(sessionRow, 'credentialRef')
      || metadata.credentialRef
      || null;
  }

  async initializeCredentials(sessionRow) {
    const credentialRef = this.getCredentialRef(sessionRow);
    if (!credentialRef) {
      throw new MissingGoogleCredentialRefError();
    }

    return await initGoogleCredentialsFromS3IfNeeded(credentialRef);
  }

  async initializeCredentialRef(credentialRef) {
    if (!credentialRef) {
      throw new MissingGoogleCredentialRefError();
    }

    return await initGoogleCredentialsFromS3IfNeeded(credentialRef);
  }

  getKeepAliveConfig() {
    return {
      enabled: true,
      intervalMinutes: KEEP_ALIVE_INTERVAL_MINUTES,  // Send keep-alive every 10 minutes (before 20-min timeout)
      strategy: 'ssh-command',
      runOnStart: true
    };
  }

  async isSessionActive(sessionRow) {
    try {
      const credentialsPath = await this.initializeCredentials(sessionRow);
      const status = await gcsService.getCloudShellStatus(
        this.getProviderSessionId(sessionRow),
        { credentialsPath }
      );
      const activeStates = new Set(['RUNNING', 'PENDING', 'SUSPENDED', 'STARTING']);
      return activeStates.has(status.status);
    } catch (error) {
      if (error.code === 'GOOGLE_CREDENTIALS_MISSING') {
        throw error;
      }

      const isNotFound =
        error.status === 404 ||
        error.statusCode === 404 ||
        error.code === 404 ||
        (error.message && error.message.toLowerCase().includes('not found')) ||
        (error.response?.data?.error?.message && error.response.data.error.message.toLowerCase().includes('not found'));

      if (isNotFound) {
        console.warn(`[GCS] Session is definitively remote not-found: ${error.message}`);
        return false;
      }

      console.warn(`[GCS] Failed active-check due to transient/other error, preserving session row: ${error.message}`);
      throw error;
    }
  }

  async executeKeepAlive(sessionRow) {
    try {
      const credentialsPath = await this.initializeCredentials(sessionRow);
      const status = await gcsService.getCloudShellStatus(
        this.getProviderSessionId(sessionRow),
        { credentialsPath }
      );

      // Check if suspended, attempt resume if needed
      if (status.status === 'SUSPENDED') {
        console.log(`[GCS] Session ${sessionRow.id} detected as SUSPENDED. Resuming...`);
        await gcsService.startCloudShellSession({ credentialsPath });
        return {
          success: true,
          action: 'resumed',
          message: 'Session was suspended, resuming now',
          updates: {
            status: 'STARTING'
          }
        };
      }

      // If not running yet, don't send commands
      if (status.status !== 'RUNNING') {
        return {
          success: false,
          action: 'wait',
          message: `Session not ready (${status.status}), skipping keep-alive`,
          updates: {}
        };
      }

      // If no SSH key yet, generate them now (like executeCommand does)
      let privateKey = getRowValue(sessionRow, 'privateKey');
      let publicKey = getRowValue(sessionRow, 'publicKey');
      let updates = {
        status: 'RUNNING'
      };

      if (!privateKey) {
        console.log(`[GCS] Generating SSH keys for keep-alive on session ${sessionRow.id}`);
        const keys = await sshService.generateKeyPair();
        await gcsService.addPublicKey(keys.publicKey, this.getProviderSessionId(sessionRow), { credentialsPath });
        privateKey = keys.privateKey;
        publicKey = keys.publicKey;
        updates.privateKey = privateKey;
        updates.publicKey = publicKey;
      }

      // Send harmless SSH command to reset inactivity timer
      const output = await sshService.executeCommand(
        {
          host: status.sshHost,
          port: status.sshPort || 22,
          username: status.sshUsername
        },
        'echo "Keep-alive: $(date)"',
        privateKey
      );

      return {
        success: true,
        action: 'keep-alive-sent',
        message: output.trim(),
        updates
      };
    } catch (error) {
      console.warn(`[GCS] Keep-alive failed for session ${sessionRow.id}: ${error.message}`);
      return {
        success: false,
        action: 'error',
        error: error.message,
        updates: {}
      };
    }
  }

  async createSession(options = {}) {
    const credentialsPath = await this.initializeCredentialRef(options.credentialRef);
    const sessionData = await gcsService.startCloudShellSession({ credentialsPath });
    return {
      provider: this.name,
      providerSessionId: sessionData.envName,
      status: sessionData.status || 'STARTING',
      metadata: {
        operation: sessionData.operation || null
      }
    };
  }

  async refreshSession(sessionRow) {
    const credentialsPath = await this.initializeCredentials(sessionRow);
    const credentialRef = this.getCredentialRef(sessionRow);
    const gcsStatus = await gcsService.getCloudShellStatus(this.getProviderSessionId(sessionRow), { credentialsPath });
    const sshCommand = gcsStatus.sshUsername && gcsStatus.sshHost
      ? `ssh ${gcsStatus.sshUsername}@${gcsStatus.sshHost} -p ${gcsStatus.sshPort || 22}`
      : null;

    return {
      status: gcsStatus.status || sessionRow.status,
      webHost: gcsStatus.webHost || null,
      sshCommand,
      metadata: {
        ...parseMetadata(sessionRow.metadata),
        credentialRef,
        sshHost: gcsStatus.sshHost || null,
        sshPort: gcsStatus.sshPort || null,
        sshUsername: gcsStatus.sshUsername || null,
        publicKeys: gcsStatus.publicKeys || []
      }
    };
  }

  async executeCommand(sessionRow, command) {
    const credentialsPath = await this.initializeCredentials(sessionRow);
    const status = await gcsService.getCloudShellStatus(this.getProviderSessionId(sessionRow), { credentialsPath });

    if (status.status !== 'RUNNING') {
      throw new SessionNotReadyError(status.status);
    }

    let privateKey = getRowValue(sessionRow, 'privateKey');
    let publicKey = getRowValue(sessionRow, 'publicKey');

    if (!privateKey) {
      const keys = await sshService.generateKeyPair();
      await gcsService.addPublicKey(keys.publicKey, this.getProviderSessionId(sessionRow), { credentialsPath });
      privateKey = keys.privateKey;
      publicKey = keys.publicKey;
    }

    const output = await sshService.executeCommand(
      {
        host: status.sshHost,
        port: status.sshPort,
        username: status.sshUsername
      },
      command,
      privateKey
    );

    return {
      output,
      updates: {
        privateKey,
        publicKey,
        sshCommand: `ssh ${status.sshUsername}@${status.sshHost} -p ${status.sshPort || 22}`,
        status: status.status
      }
    };
  }

  async terminateSession(sessionRow) {
    const providerSessionId = this.getProviderSessionId(sessionRow);
    if (!providerSessionId) {
      return;
    }

    const credentialsPath = await this.initializeCredentials(sessionRow);

    try {
      const status = await gcsService.getCloudShellStatus(providerSessionId, { credentialsPath });

      if (status.status === 'RUNNING' && status.sshHost && status.sshUsername) {
        let privateKey = getRowValue(sessionRow, 'privateKey');

        if (!privateKey) {
          const keys = await sshService.generateKeyPair();
          await gcsService.addPublicKey(keys.publicKey, providerSessionId, { credentialsPath });
          privateKey = keys.privateKey;
        }

        try {
          console.log(`[GCS] Attempting graceful shutdown of session ${sessionRow.id} via SSH command...`);
          await sshService.executeCommand(
            {
              host: status.sshHost,
              port: status.sshPort || 22,
              username: status.sshUsername
            },
            'sudo poweroff -f',
            privateKey
          );
        } catch (error) {
          if (!isExpectedShutdownDisconnect(error)) {
            throw error;
          }
        }

        return;
      }
    } catch (error) {
      console.warn('GCS shutdown failed during termination:', error.message);
    }

    const storedPublicKey = getRowValue(sessionRow, 'publicKey');
    if (!storedPublicKey) {
      return;
    }

    try {
      await gcsService.removePublicKey(storedPublicKey, providerSessionId, { credentialsPath });
    } catch (error) {
      // Keep termination best-effort: DB cleanup should continue on key revoke failures.
      console.warn('GCS key revocation failed during termination:', error.message);
    }
  }
}

module.exports = GcsProvider;
