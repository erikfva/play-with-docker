const BaseProvider = require('./base-provider');
const { ProviderNotImplementedError } = require('../errors/provider-errors');

class PwdProvider extends BaseProvider {
  constructor() {
    super('pwd');
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
