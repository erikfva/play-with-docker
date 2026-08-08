const { execFile } = require('child_process');
const { ProviderError } = require('../../errors/provider-errors');

const BOOT_TIMEOUT_MS = 90_000;
const COMMAND_TIMEOUT_MS = 30_000;

/**
 * Classify raw stderr/stdout text from `gh codespace ssh` into a structured
 * ProviderError when the text indicates a known failure mode. Returns null if
 * the text does not match any known pattern (caller will use a generic error).
 */
function classifyGhStderrError(text) {
  if (!text) return null;
  const lower = text.toLowerCase();

  if (/your account was suspended|account.*suspend/i.test(text)) {
    return new ProviderError(`GitHub account is suspended: ${text.trim()}`, {
      code: 'CODESPACES_ACCOUNT_SUSPENDED',
      statusCode: 403
    });
  }

  if (/bad credentials|token.*invalid|invalid.*token|401/i.test(text)) {
    return new ProviderError('GitHub token is invalid or expired', {
      code: 'CODESPACES_TOKEN_INVALID',
      statusCode: 401
    });
  }

  if (/error getting token|lacks.*scope|insufficient.*scope/i.test(text)) {
    return new ProviderError('GitHub token lacks the required codespace scope', {
      code: 'CODESPACES_TOKEN_INSUFFICIENT_SCOPE',
      statusCode: 403
    });
  }

  if (lower.includes('not found') || lower.includes('could not find')) {
    return new ProviderError('Codespace not found', {
      code: 'CODESPACES_NOT_FOUND',
      statusCode: 404
    });
  }

  if (/rate.?limit/i.test(text)) {
    return new ProviderError('GitHub API rate limit exceeded', {
      code: 'CODESPACES_RATE_LIMIT_EXCEEDED',
      statusCode: 429
    });
  }

  return null;
}

function buildCommandError(error, stderr, timeout) {
  // Timeout: killed by the timeout option or SIGTERM
  if (error && (error.killed || error.signal === 'SIGTERM')) {
    return new ProviderError(`Command timed out after ${timeout}ms`, {
      code: 'CODESPACES_COMMAND_TIMEOUT',
      statusCode: 504
    });
  }

  // gh CLI exited non-zero: inspect stderr for known error patterns first.
  // These come back as exit code 1 with plain-text diagnostics, not HTTP
  // structured errors, so we must classify them from the text.
  const classified = classifyGhStderrError(stderr);
  if (classified) return classified;

  // Unknown non-zero exit: wrap with a provider code so mapErrorToHttp never
  // sees a raw node error with a numeric .code that it mistakes for an HTTP status.
  const message = (stderr || error?.message || 'gh codespace ssh failed').trim();
  return new ProviderError(message, {
    code: 'CODESPACES_COMMAND_FAILED',
    statusCode: 502
  });
}

async function executeInCodespace(codespaceName, command, token, options = {}) {
  if (!codespaceName || typeof codespaceName !== 'string') {
    throw new Error('codespaceName is required');
  }
  if (!command || typeof command !== 'string') {
    throw new Error('command must be a non-empty string');
  }
  if (!token || typeof token !== 'string') {
    throw new Error('token is required');
  }

  const timeout = options.timeout ?? COMMAND_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      ['codespace', 'ssh', '-c', codespaceName, '--', command],
      {
        timeout,
        env: { ...process.env, GH_TOKEN: token }
      },
      (error, stdout, stderr) => {
        if (error) {
          return reject(buildCommandError(error, stderr, timeout));
        }

        resolve({ output: (stdout + stderr).trim() });
      }
    );
  });
}

module.exports = {
  executeInCodespace,
  BOOT_TIMEOUT_MS,
  COMMAND_TIMEOUT_MS
};
