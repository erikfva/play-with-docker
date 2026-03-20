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

module.exports = BaseProvider;
