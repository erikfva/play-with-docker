const { execFile } = require('child_process');
const { ProviderError } = require('../../errors/provider-errors');

const BOOT_TIMEOUT_MS = 90_000;
const COMMAND_TIMEOUT_MS = 30_000;

function buildCommandError(error, timeout) {
  if (error && (error.killed || error.signal === 'SIGTERM')) {
    return new ProviderError(`Command timed out after ${timeout}ms`, {
      code: 'CODESPACES_COMMAND_TIMEOUT',
      statusCode: 504
    });
  }

  return error;
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
          return reject(buildCommandError(error, timeout));
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
