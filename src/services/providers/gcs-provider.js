const BaseProvider = require('./base-provider');
const gcsService = require('../gcs-service');
const { initGoogleCredentialsFromS3IfNeeded } = require('../google-credentials-loader');
const sshService = require('../ssh-service');
const { SessionNotReadyError } = require('../errors/provider-errors');

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
    return sessionRow?.credentialRef
      || sessionRow?.credentialref
      || metadata.credentialRef
      || null;
  }

  async initializeCredentials(sessionRow) {
    const credentialRef = this.getCredentialRef(sessionRow);
    if (!credentialRef) {
      throw new Error('Google credential reference is missing for this session');
    }

    await initGoogleCredentialsFromS3IfNeeded(credentialRef);
  }

  getKeepAliveConfig() {
    return {
      enabled: true,
      intervalMinutes: 15,  // Send keep-alive every 15 minutes (before 20-min timeout)
      strategy: 'ssh-command'
    };
  }

  async isSessionActive(sessionRow) {
    try {
      await this.initializeCredentials(sessionRow);
      const status = await gcsService.getCloudShellStatus(
        this.getProviderSessionId(sessionRow)
      );
      return status.status === 'RUNNING';
    } catch (error) {
      console.warn(`[GCS] Failed to check session active status: ${error.message}`);
      return false;
    }
  }

  async executeKeepAlive(sessionRow) {
    try {
      await this.initializeCredentials(sessionRow);
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
          message: 'Session was suspended, resuming now',
          updates: {}
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
      let privateKey = sessionRow.privateKey;
      let publicKey = sessionRow.publicKey;
      let updates = {};

      if (!privateKey) {
        console.log(`[GCS] Generating SSH keys for keep-alive on session ${sessionRow.id}`);
        const keys = await sshService.generateKeyPair();
        await gcsService.addPublicKey(keys.publicKey, this.getProviderSessionId(sessionRow));
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

  async createSession() {
    const sessionData = await gcsService.startCloudShellSession();
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
    await this.initializeCredentials(sessionRow);
    const credentialRef = this.getCredentialRef(sessionRow);
    const gcsStatus = await gcsService.getCloudShellStatus(this.getProviderSessionId(sessionRow));
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
    await this.initializeCredentials(sessionRow);
    const status = await gcsService.getCloudShellStatus(this.getProviderSessionId(sessionRow));

    if (status.status !== 'RUNNING') {
      throw new SessionNotReadyError(status.status);
    }

    let privateKey = sessionRow.privateKey;
    let publicKey = sessionRow.publicKey;

    if (!privateKey) {
      const keys = await sshService.generateKeyPair();
      await gcsService.addPublicKey(keys.publicKey, this.getProviderSessionId(sessionRow));
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

    await this.initializeCredentials(sessionRow);

    try {
      const status = await gcsService.getCloudShellStatus(providerSessionId);

      if (status.status === 'RUNNING' && status.sshHost && status.sshUsername) {
        let privateKey = sessionRow.privateKey;

        if (!privateKey) {
          const keys = await sshService.generateKeyPair();
          await gcsService.addPublicKey(keys.publicKey, providerSessionId);
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

    if (!sessionRow.publicKey) {
      return;
    }

    try {
      await gcsService.removePublicKey(sessionRow.publicKey, providerSessionId);
    } catch (error) {
      // Keep termination best-effort: DB cleanup should continue on key revoke failures.
      console.warn('GCS key revocation failed during termination:', error.message);
    }
  }
}

module.exports = GcsProvider;
