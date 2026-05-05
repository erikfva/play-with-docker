const { CodeSandbox } = require('@codesandbox/sdk');

// Fix path for root require
const path = require('path');

/**
 * CodeSandbox SDK Client Factory
 *
 * Creates and manages CodeSandbox SDK instances.
 * Designed to be mockable for testing.
 */

class CodeSandboxClient {
  constructor() {
    this.instances = new Map();
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

    const cacheKey = `token:${token.trim()}`;

    if (!this.instances.has(cacheKey)) {
      // Use the verified constructor shape: new CodeSandbox(token)
      const client = new CodeSandbox(token.trim());
      this.instances.set(cacheKey, client);
      console.log('[CodeSandbox] Created new SDK client');
    }

    return this.instances.get(cacheKey);
  }

  /**
   * Clear all cached instances (useful for tests)
   */
  clearCache() {
    this.instances.clear();
  }
}

// Singleton instance
const client = new CodeSandboxClient();

module.exports = client;
