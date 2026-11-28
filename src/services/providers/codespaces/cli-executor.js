const cp = require('child_process');
const { ProviderError } = require('../../errors/provider-errors');

const BOOT_TIMEOUT_MS = 90_000;
const COMMAND_TIMEOUT_MS = 30_000;
const CREATE_TIMEOUT_MS = 120_000;

// Codespaces `gh codespace ssh` can intermittently hang or fail with an empty
// error even though the codespace is Available. Retry a bounded number of times
// so transient SSH failures do not fail setup commands outright.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;

const GEO_TO_CLI_LOCATION = {
  UsEast: 'EastUs',
  UsWest: 'WestUs2',
  EuropeWest: 'WestEurope',
  SoutheastAsia: 'SouthEastAsia'
};

const CODESPACE_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/;

function redactTokens(str) {
  return String(str || '').replace(/\b[A-Za-z0-9_\-]{20,}\b/g, '[REDACTED]');
}

function buildCliEnv(token) {
  const env = { ...process.env, GH_TOKEN: token };
  delete env.GITHUB_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;
  return env;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Classify raw stderr/stdout text from `gh codespace` commands into a structured
 * ProviderError when the text indicates a known failure mode. Returns null if
 * the text does not match any known pattern (caller will use a generic error).
 */
function classifyGhStderrError(text) {
  if (!text) return null;
  const lower = text.toLowerCase();

  if (/your account was suspended|account.*suspend/i.test(text)) {
    return new ProviderError(redactTokens(`GitHub account is suspended: ${text.trim()}`), {
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
    return new ProviderError(redactTokens(message), {
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

  if (/could not resolve to a repository|repository.*not found/i.test(text)) {
    return new ProviderError('Repository not found or inaccessible', {
      code: 'CODESPACES_REPOSITORY_NOT_FOUND',
      statusCode: 404
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
  if (error && error.code === 'ENOENT') {
    return new ProviderError('GitHub CLI (gh) is not installed or not in PATH', {
      code: 'CODESPACES_CLI_NOT_INSTALLED',
      statusCode: 500
    });
  }

  // Timeout: killed by the timeout option or SIGTERM
  if (error && (error.killed || error.signal === 'SIGTERM')) {
    return new ProviderError(`Command timed out after ${timeout}ms`, {
      code: 'CODESPACES_COMMAND_TIMEOUT',
      statusCode: 504
    });
  }

  // gh CLI exited non-zero: inspect stderr for known error patterns first.
  const classified = classifyGhStderrError(stderr);
  if (classified) return classified;

  // Unknown non-zero exit: wrap with a provider code so mapErrorToHttp never
  // sees a raw node error with a numeric .code that it mistakes for an HTTP status.
  const message = redactTokens((stderr || error?.message || 'gh codespace ssh failed').trim());
  return new ProviderError(message, {
    code: 'CODESPACES_COMMAND_FAILED',
    statusCode: 502
  });
}

async function listCodespacesViaCli(token, options = {}) {
  if (!token || typeof token !== 'string') {
    throw new Error('token is required');
  }
  const timeout = options.timeout ?? COMMAND_TIMEOUT_MS;
  const args = ['codespace', 'list', '--json', 'name,state,displayName,machineName,lastUsedAt'];

  return new Promise((resolve, reject) => {
    cp.execFile('gh', args, { timeout, env: buildCliEnv(token) }, (error, stdout, stderr) => {
      if (error) {
        if (error.code === 'ENOENT') {
          return reject(
            new ProviderError('GitHub CLI (gh) is not installed or not in PATH', {
              code: 'CODESPACES_CLI_NOT_INSTALLED',
              statusCode: 500
            })
          );
        }
        if (error.killed || error.signal === 'SIGTERM') {
          return reject(
            new ProviderError(`gh codespace list timed out after ${timeout}ms`, {
              code: 'CODESPACES_COMMAND_TIMEOUT',
              statusCode: 504
            })
          );
        }
        const classified = classifyGhStderrError(stderr);
        if (classified) return reject(classified);

        const message = redactTokens((stderr || error.message || 'gh codespace list failed').trim());
        return reject(
          new ProviderError(message, {
            code: 'CODESPACES_COMMAND_FAILED',
            statusCode: 502
          })
        );
      }

      const trimmed = (stdout || '').trim();
      if (!trimmed) {
        return reject(
          new ProviderError('Unexpected empty output from gh codespace list', {
            code: 'CODESPACES_COMMAND_FAILED',
            statusCode: 502
          })
        );
      }

      try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) {
          return reject(
            new ProviderError('Expected array output from gh codespace list', {
              code: 'CODESPACES_COMMAND_FAILED',
              statusCode: 502
            })
          );
        }
        return resolve(parsed);
      } catch (_) {
        return reject(
          new ProviderError('Failed to parse gh codespace list output', {
            code: 'CODESPACES_COMMAND_FAILED',
            statusCode: 502
          })
        );
      }
    });
  });
}

async function createCodespaceViaCli(options = {}, token) {
  if (!token || typeof token !== 'string') {
    throw new Error('token is required');
  }
  if (!options.repo || typeof options.repo !== 'string') {
    throw new Error('repo is required');
  }

  const timeout = options.timeout ?? CREATE_TIMEOUT_MS;
  const args = ['codespace', 'create', '-R', options.repo];

  if (options.machine) {
    args.push('--machine', options.machine);
  }
  if (options.location) {
    args.push('--location', options.location);
  }
  if (options.branch) {
    args.push('--branch', options.branch);
  }
  if (options.displayName) {
    args.push('--display-name', options.displayName);
  }

  return new Promise((resolve, reject) => {
    cp.execFile('gh', args, { timeout, env: buildCliEnv(token) }, (error, stdout, stderr) => {
      if (error) {
        if (error.code === 'ENOENT') {
          return reject(
            new ProviderError('GitHub CLI (gh) is not installed or not in PATH', {
              code: 'CODESPACES_CLI_NOT_INSTALLED',
              statusCode: 500
            })
          );
        }
        if (error.killed || error.signal === 'SIGTERM') {
          return reject(
            new ProviderError(`gh codespace create timed out after ${timeout}ms`, {
              code: 'CODESPACES_CREATE_TIMEOUT',
              statusCode: 504
            })
          );
        }
        const classified = classifyGhStderrError(stderr);
        if (classified) return reject(classified);

        const message = redactTokens((stderr || error.message || 'gh codespace create failed').trim());
        return reject(
          new ProviderError(message, {
            code: 'CODESPACES_CREATION_FAILED',
            statusCode: 502
          })
        );
      }

      const output = (stdout || '').trim();
      if (!output) {
        return reject(
          new ProviderError('Empty output from gh codespace create', {
            code: 'CODESPACES_CREATION_FAILED',
            statusCode: 502
          })
        );
      }

      let createdName = null;
      try {
        const parsed = JSON.parse(output);
        if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string') {
          const candidate = parsed.name.trim();
          if (CODESPACE_NAME_REGEX.test(candidate)) {
            createdName = candidate;
          }
        }
      } catch (_) {
        // Not JSON output
      }

      if (!createdName) {
        const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        // The documented CLI output format for non-interactive create is a single line
        // containing the created codespace identifier. Multi-line output indicates
        // unexpected progress or diagnostics and must not be guessed from.
        if (lines.length === 1 && CODESPACE_NAME_REGEX.test(lines[0])) {
          createdName = lines[0];
        }
      }

      if (!createdName) {
        return reject(
          new ProviderError('Unable to extract valid created codespace name from gh output', {
            code: 'CODESPACES_CREATION_FAILED',
            statusCode: 502
          })
        );
      }

      return resolve(createdName);
    });
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
  if (error instanceof ProviderError && error.code !== 'CODESPACES_COMMAND_TIMEOUT') {
    return false;
  }
  return true;
}

function runSingleAttempt(codespaceName, command, token, timeout) {
  return new Promise((resolve, reject) => {
    cp.execFile(
      'gh',
      ['codespace', 'ssh', '-c', codespaceName, '--', command],
      {
        timeout,
        env: buildCliEnv(token)
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
  listCodespacesViaCli,
  createCodespaceViaCli,
  classifyGhStderrError,
  buildCommandError,
  GEO_TO_CLI_LOCATION,
  BOOT_TIMEOUT_MS,
  COMMAND_TIMEOUT_MS,
  CREATE_TIMEOUT_MS
};
