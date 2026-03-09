class BaseProvider {
  constructor(name) {
    this.name = name;
  }

  async createSession() {
    throw new Error('createSession must be implemented by provider');
  }

  async refreshSession() {
    throw new Error('refreshSession must be implemented by provider');
  }

  async executeCommand() {
    throw new Error('executeCommand must be implemented by provider');
  }

  async terminateSession() {
    throw new Error('terminateSession must be implemented by provider');
  }
}

module.exports = BaseProvider;
