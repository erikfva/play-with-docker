const BaseProvider = require('./base-provider');
const gcsService = require('../gcs-service');
const sshService = require('../ssh-service');
const { SessionNotReadyError } = require('../errors/provider-errors');

class GcsProvider extends BaseProvider {
  constructor() {
    super('gcs');
  }

  getProviderSessionId(sessionRow) {
    return sessionRow.providerSessionId || sessionRow.envName;
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
    const gcsStatus = await gcsService.getCloudShellStatus(this.getProviderSessionId(sessionRow));
    const sshCommand = gcsStatus.sshUsername && gcsStatus.sshHost
      ? `ssh ${gcsStatus.sshUsername}@${gcsStatus.sshHost} -p ${gcsStatus.sshPort || 22}`
      : null;

    return {
      status: gcsStatus.status || sessionRow.status,
      webHost: gcsStatus.webHost || null,
      sshCommand,
      metadata: {
        sshHost: gcsStatus.sshHost || null,
        sshPort: gcsStatus.sshPort || null,
        sshUsername: gcsStatus.sshUsername || null,
        publicKeys: gcsStatus.publicKeys || []
      }
    };
  }

  async executeCommand(sessionRow, command) {
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
    if (!providerSessionId || !sessionRow.publicKey) {
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
