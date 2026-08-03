const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const { ProviderError } = require('../src/services/errors/provider-errors');
const { loadCodespacesCredentials } = require('../src/services/providers/codespaces/credentials-loader');

async function withCredentialDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codespaces-creds-'));
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    S3FS_ENABLED: process.env.S3FS_ENABLED,
    S3_MOUNT_DIR: process.env.S3_MOUNT_DIR,
    S3_BUCKET: process.env.S3_BUCKET
  };

  process.env.S3_MOUNT_DIR = dir;
  process.env.S3FS_ENABLED = '1';
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

test('loads a valid JSON Codespaces credential file and computes a fingerprint', async () => {
  await withCredentialDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'valid.json'), JSON.stringify({ token: 'ghp_test-token' }));

    const result = await loadCodespacesCredentials('valid.json');

    assert.equal(result.token, 'ghp_test-token');
    assert.equal(result.credentialRef, 'valid.json');
    assert.match(result.credentialFingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.notEqual(result.credentialFingerprint, 'ghp_test-token');
  });
});

test('loads a valid plain-text .txt Codespaces credential file', async () => {
  await withCredentialDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'token.txt'), 'ghp_plain-text-token\n');

    const result = await loadCodespacesCredentials('token.txt');

    assert.equal(result.token, 'ghp_plain-text-token');
    assert.equal(result.credentialRef, 'token.txt');
    assert.match(result.credentialFingerprint, /^sha256:[a-f0-9]{64}$/);
  });
});

test('treats malformed JSON with non-token text as a plain-text token', async () => {
  await withCredentialDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'malformed.json'), 'ghp_raw-token-not-json');

    const result = await loadCodespacesCredentials('malformed.json');

    assert.equal(result.token, 'ghp_raw-token-not-json');
    assert.match(result.credentialFingerprint, /^sha256:[a-f0-9]{64}$/);
  });
});

test('rejects valid JSON without a token field instead of treating it as a raw PAT', async () => {
  await withCredentialDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ config: 'data', secret: 'value' })
    );

    await assertProviderError(
      loadCodespacesCredentials('config.json'),
      'CODESPACES_NO_CREDENTIAL',
      /must contain a token field/,
      401
    );
  });
});

test('rejects a missing credential file with CODESPACES_NO_CREDENTIAL', async () => {
  await withCredentialDir(async (dir) => {
    await assertProviderError(
      loadCodespacesCredentials('missing.json'),
      'CODESPACES_NO_CREDENTIAL',
      new RegExp(`Codespaces credentials file does not exist: ${path.join(dir, 'missing\\.json')}`),
      404
    );
  });
});

test('rejects an empty credential file with CODESPACES_NO_CREDENTIAL', async () => {
  await withCredentialDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'empty.txt'), '  \n');

    await assertProviderError(
      loadCodespacesCredentials('empty.txt'),
      'CODESPACES_NO_CREDENTIAL'
    );
  });
});

test('rejects path traversal outside the credential directory', async () => {
  await withCredentialDir(async () => {
    await assertProviderError(
      loadCodespacesCredentials('../outside.json'),
      'CODESPACES_NO_CREDENTIAL'
    );
  });
});

test('rejects a missing credential reference with CODESPACES_NO_CREDENTIAL', async () => {
  await withCredentialDir(async () => {
    await assertProviderError(
      loadCodespacesCredentials(),
      'CODESPACES_NO_CREDENTIAL',
      /Codespaces credential reference is required/,
      401
    );
  });
});
