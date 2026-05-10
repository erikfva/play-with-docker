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
    NODE_ENV: process.env.NODE_ENV,
    CODESANDBOX_DEFAULT_CREDENTIALS: process.env.CODESANDBOX_DEFAULT_CREDENTIALS,
    S3FS_ENABLED: process.env.S3FS_ENABLED,
    S3_MOUNT_DIR: process.env.S3_MOUNT_DIR,
    S3_BUCKET: process.env.S3_BUCKET
  };

  process.env.S3_MOUNT_DIR = dir;
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

async function assertProviderError(promise, code, messagePattern, statusCode) {
  await assert.rejects(
    promise,
    (error) => {
      assert.equal(error instanceof ProviderError, true);
      assert.equal(error.code, code);
      if (messagePattern) {
        assert.match(error.message, messagePattern);
      }
      if (statusCode) {
        assert.equal(error.statusCode, statusCode);
      }
      return true;
    }
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

test('loads CodeSandbox credentials from S3 when S3FS is disabled', async () => {
  await withCredentialDir(async () => {
    process.env.S3FS_ENABLED = '0';
    process.env.S3_BUCKET = 'play-with-docker';

    await assertProviderError(
      loadCodeSandboxCredentials('disk-mode.json'),
      'CODESANDBOX_CREDENTIALS_MISSING',
      /Failed to fetch CodeSandbox credentials from s3:\/\/play-with-docker\/disk-mode\.json/
    );
  });
});

test('falls back to S3_MOUNT_DIR when s3fs filesystem mode is enabled', async () => {
  await withCredentialDir(async (dir) => {
    process.env.S3FS_ENABLED = '1';
    process.env.S3_BUCKET = 'play-with-docker';
    process.env.S3_MOUNT_DIR = dir;
    await fs.writeFile(path.join(dir, 'mount-dir.json'), JSON.stringify({ token: 'mount-token' }));

    const result = await loadCodeSandboxCredentials('mount-dir.json');

    assert.equal(result.token, 'mount-token');
    assert.equal(result.credentialRef, 'mount-dir.json');
    assert.match(result.credentialFingerprint, /^sha256:[a-f0-9]{64}$/);
  });
});

test('resolves s3 credential references from S3_MOUNT_DIR when NODE_ENV is local', async () => {
  await withCredentialDir(async (dir) => {
    process.env.NODE_ENV = 'local';
    process.env.S3FS_ENABLED = '0';
    process.env.S3_BUCKET = 'play-with-docker';
    process.env.S3_MOUNT_DIR = dir;

    const nestedDir = path.join(dir, 'codesandbox');
    await fs.mkdir(nestedDir);
    await fs.writeFile(path.join(nestedDir, 'account.json'), JSON.stringify({ token: 'local-s3-ref-token' }));

    const result = await loadCodeSandboxCredentials('s3://play-with-docker/codesandbox/account.json');

    assert.equal(result.token, 'local-s3-ref-token');
    assert.equal(result.credentialRef, 's3://play-with-docker/codesandbox/account.json');
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
  await withCredentialDir(async (dir) => {
    await assertProviderError(
      loadCodeSandboxCredentials('missing.json'),
      'CODESANDBOX_CREDENTIALS_MISSING',
      new RegExp(`CodeSandbox credentials file does not exist: ${path.join(dir, 'missing\\.json')}`),
      404
    );
  });
});

test('reports local CodeSandbox credential configuration options when no ref is configured', async () => {
  await withCredentialDir(async () => {
    process.env.NODE_ENV = 'local';

    await assertProviderError(
      loadCodeSandboxCredentials(),
      'CODESANDBOX_CREDENTIALS_MISSING',
      /Set CODESANDBOX_DEFAULT_CREDENTIALS.*S3_MOUNT_DIR/
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
