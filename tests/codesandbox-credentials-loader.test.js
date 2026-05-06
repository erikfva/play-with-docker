const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const { ProviderError } = require('../src/services/errors/provider-errors');
const { loadCodeSandboxCredentials } = require('../src/services/providers/codesandbox/credentials-loader');

async function withCredentialDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesandbox-creds-'));
  const previousEnv = {
    CODESANDBOX_CREDENTIALS_DIR: process.env.CODESANDBOX_CREDENTIALS_DIR,
    CODESANDBOX_DEFAULT_CREDENTIALS: process.env.CODESANDBOX_DEFAULT_CREDENTIALS,
    S3FS_ENABLED: process.env.S3FS_ENABLED,
    S3_MOUNT_DIR: process.env.S3_MOUNT_DIR,
    S3_BUCKET: process.env.S3_BUCKET
  };

  process.env.CODESANDBOX_CREDENTIALS_DIR = dir;
  process.env.S3FS_ENABLED = '1';
  delete process.env.CODESANDBOX_DEFAULT_CREDENTIALS;
  delete process.env.S3_BUCKET;

  try {
    await fn(dir);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function assertProviderError(promise, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof ProviderError && error.code === code
  );
}

test('loads a valid CodeSandbox credential file and computes a fingerprint', async () => {
  await withCredentialDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'valid.json'), JSON.stringify({ token: 'test-token' }));

    const result = await loadCodeSandboxCredentials('valid.json');

    assert.equal(result.token, 'test-token');
    assert.equal(result.credentialRef, 'valid.json');
    assert.match(result.credentialFingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.notEqual(result.credentialFingerprint, 'test-token');
  });
});

test('loads from CodeSandbox credential directory when S3FS is disabled', async () => {
  await withCredentialDir(async (dir) => {
    process.env.S3FS_ENABLED = '0';
    process.env.S3_BUCKET = 'play-with-docker';
    await fs.writeFile(path.join(dir, 'disk-mode.json'), JSON.stringify({ token: 'disk-token' }));

    const result = await loadCodeSandboxCredentials('disk-mode.json');

    assert.equal(result.token, 'disk-token');
    assert.equal(result.credentialRef, 'disk-mode.json');
    assert.match(result.credentialFingerprint, /^sha256:[a-f0-9]{64}$/);
  });
});

test('falls back to S3_MOUNT_DIR when CodeSandbox credential directory is unset', async () => {
  await withCredentialDir(async (dir) => {
    process.env.S3FS_ENABLED = '0';
    process.env.S3_BUCKET = 'play-with-docker';
    process.env.S3_MOUNT_DIR = dir;
    delete process.env.CODESANDBOX_CREDENTIALS_DIR;
    await fs.writeFile(path.join(dir, 'mount-dir.json'), JSON.stringify({ token: 'mount-token' }));

    const result = await loadCodeSandboxCredentials('mount-dir.json');

    assert.equal(result.token, 'mount-token');
    assert.equal(result.credentialRef, 'mount-dir.json');
    assert.match(result.credentialFingerprint, /^sha256:[a-f0-9]{64}$/);
  });
});

test('rejects path traversal outside the credential directory', async () => {
  await withCredentialDir(async () => {
    await assertProviderError(
      loadCodeSandboxCredentials('../outside.json'),
      'CODESANDBOX_CREDENTIALS_PATH_INVALID'
    );
  });
});

test('rejects a missing credential file with a provider-safe error', async () => {
  await withCredentialDir(async () => {
    await assertProviderError(
      loadCodeSandboxCredentials('missing.json'),
      'CODESANDBOX_CREDENTIALS_MISSING'
    );
  });
});

test('rejects malformed credential JSON with a provider-safe error', async () => {
  await withCredentialDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'malformed.json'), '{');

    await assertProviderError(
      loadCodeSandboxCredentials('malformed.json'),
      'CODESANDBOX_CREDENTIALS_INVALID'
    );
  });
});

test('rejects credential JSON without a token', async () => {
  await withCredentialDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'missing-token.json'), JSON.stringify({}));

    await assertProviderError(
      loadCodeSandboxCredentials('missing-token.json'),
      'CODESANDBOX_TOKEN_MISSING'
    );
  });
});
