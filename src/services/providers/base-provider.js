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

  /**
   * Check a credential's validity and quota without creating sessions or running
   * commands. Returns:
   *   { status, quotas, limitations, validated, expiresAt, details? }
   *
   * Throwing causes the dispatcher to return an UNKNOWN entry (not cached).
   * Returning { status: 'UNKNOWN' } has the same effect and is appropriate for
   * provider-internal soft failures (e.g. a sub-call that is expected to be
   * unreliable).
   *
   * Optional — base default throws to signal "not implemented". Providers that
   * support status checking override this method.
   */
  async getCredentialStatus(loadedCredential) {
    throw new Error('getCredentialStatus must be implemented by provider');
  }
}

module.exports = BaseProvider;
