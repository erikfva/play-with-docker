const BaseProvider = require('./base-provider');
const { ProviderNotImplementedError } = require('../errors/provider-errors');

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
    // Not called for PWD (keep-alive disabled), but implement for safety
    return {
      success: true,
      action: 'skipped',
      message: 'PWD provider does not require keep-alive',
      updates: {}
    };
  }

  async createSession() {
    throw new ProviderNotImplementedError(this.name);
  }

  async refreshSession() {
    throw new ProviderNotImplementedError(this.name);
  }

  async executeCommand() {
    throw new ProviderNotImplementedError(this.name);
  }

  async terminateSession() {
    throw new ProviderNotImplementedError(this.name);
  }
}

module.exports = PwdProvider;
