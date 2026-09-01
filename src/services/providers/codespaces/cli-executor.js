const { execFile } = require('child_process');
const { ProviderError } = require('../../errors/provider-errors');

const BOOT_TIMEOUT_MS = 90_000;
const COMMAND_TIMEOUT_MS = 30_000;

// Codespaces `gh codespace ssh` can intermittently hang or fail with an empty
// error even though the codespace is Available. Retry a bounded number of times
// so transient SSH failures do not fail setup commands outright.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  // Billing issue — quota exhausted or payment required.
  // gh CLI surfaces this as "HTTP 402: ... billing issue ..." inside stderr.
  if (/http 402|billing issue|usage.*disallowed|disallowed.*billing/i.test(text)) {
    // Extract the GitHub message after "HTTP 402:" if present, otherwise use the full text.
    const match = text.match(/HTTP 402:\s*(.+)/i);
    const message = match ? match[1].trim() : text.trim();
    return new ProviderError(message, {
      code: 'CODESPACES_BILLING_ERROR',
      statusCode: 402
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
  const maxAttempts = options.retries != null ? options.retries + 1 : MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await runSingleAttempt(codespaceName, command, token, timeout);
    } catch (error) {
      lastError = error;

      // Fatal/classified errors never retry (suspended account, not-found, bad token)
      if (!isRetryableError(error) || attempt === maxAttempts) {
        throw error;
      }

      console.warn(
        `[Codespaces] gh ssh attempt ${attempt}/${maxAttempts} failed for ${codespaceName} ` +
          `(${error.code || error.message}); retrying in ${retryDelayMs}ms`
      );
      await sleep(retryDelayMs);
    }
  }

  throw lastError;
}

function isRetryableError(error) {
  // A classified fatal error (suspended account, bad token, not-found,
  // rate-limit) must NOT be retried — retrying would mask the real cause.
  if (error instanceof ProviderError && error.code !== 'CODESPACES_COMMAND_TIMEOUT') {
    return false;
  }

  // Timeouts, and unknown/generic failures (empty stderr, exec failed) are
  // classic transient SSH failures and are safe to retry.
  return true;
}

function runSingleAttempt(codespaceName, command, token, timeout) {
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
