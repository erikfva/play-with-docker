const { CodeSandbox, API } = require('@codesandbox/sdk');
const crypto = require('crypto');

/**
 * CodeSandbox SDK Client Factory
 *
 * Creates and manages CodeSandbox SDK instances.
 * Designed to be mockable for testing.
 */

class CodeSandboxClient {
  constructor() {
    this.instances = new Map();
    this.apiInstances = new Map();
  }

  /**
   * Create or get a cached SDK instance for the given token
   * @param {string} token - CodeSandbox API token
   * @returns {CodeSandbox} SDK instance
   */
  getClient(token) {
    if (!token || typeof token !== 'string' || !token.trim()) {
      throw new Error('CodeSandbox token is required');
    }

    const trimmedToken = token.trim();
    const cacheKey = crypto.createHash('sha256').update(trimmedToken).digest('hex');

    if (!this.instances.has(cacheKey)) {
      // Use the verified constructor shape: new CodeSandbox(token)
      const client = new CodeSandbox(trimmedToken);
      this.instances.set(cacheKey, client);
      console.log('[CodeSandbox] Created new SDK client');
    }

    return this.instances.get(cacheKey);
  }

  getApiClient(token) {
    if (!token || typeof token !== 'string' || !token.trim()) {
      throw new Error('CodeSandbox token is required');
    }
    const trimmedToken = token.trim();
    const cacheKey = crypto.createHash('sha256').update(trimmedToken).digest('hex');
    if (!this.apiInstances.has(cacheKey)) {
      this.apiInstances.set(cacheKey, new API({ apiKey: trimmedToken }));
    }
    return this.apiInstances.get(cacheKey);
  }

  /**
   * Clear all cached instances (useful for tests)
   */
  clearCache() {
    this.instances.clear();
    this.apiInstances.clear();
  }
}

// Singleton instance
const client = new CodeSandboxClient();

module.exports = client;
