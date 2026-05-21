const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const {
  initGoogleCredentialsFromS3IfNeeded,
  resolveLocalCredentialsPath
} = require('../src/services/google-credentials-loader');
const { listAvailableCredentials } = require('../src/services/credentials-lister');

async function withLocalCredentialDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'google-creds-'));
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    S3FS_ENABLED: process.env.S3FS_ENABLED,
    S3_MOUNT_DIR: process.env.S3_MOUNT_DIR,
    S3_BUCKET: process.env.S3_BUCKET,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    GOOGLE_APPLICATION_DEFAULT_CREDENTIALS: process.env.GOOGLE_APPLICATION_DEFAULT_CREDENTIALS
  };

  process.env.NODE_ENV = 'local';
  process.env.S3FS_ENABLED = '0';
  process.env.S3_MOUNT_DIR = dir;
  process.env.S3_BUCKET = 'play-with-docker';
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.GOOGLE_APPLICATION_DEFAULT_CREDENTIALS;

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

test('loads Google credentials from S3_MOUNT_DIR when NODE_ENV is local', async () => {
  await withLocalCredentialDir(async (dir) => {
    const credentialPath = path.join(dir, 'service-account.json');
    await fs.writeFile(credentialPath, JSON.stringify({ client_email: 'local@example.com' }));

    const result = await initGoogleCredentialsFromS3IfNeeded('service-account.json');

    assert.equal(result, credentialPath);
    assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, credentialPath);
  });
});

test('resolves s3 credential references to local files when NODE_ENV is local', async () => {
  await withLocalCredentialDir(async (dir) => {
    const nestedDir = path.join(dir, 'credentials');
    await fs.mkdir(nestedDir);
    const credentialPath = path.join(nestedDir, 'service-account.json');
    await fs.writeFile(credentialPath, JSON.stringify({ client_email: 'local@example.com' }));

    const result = await initGoogleCredentialsFromS3IfNeeded('s3://bucket/credentials/service-account.json');

    assert.equal(result, credentialPath);
    assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, credentialPath);
  });
});

test('rejects local Google credential paths that escape S3_MOUNT_DIR', async () => {
  await withLocalCredentialDir(async () => {
    assert.throws(
      () => resolveLocalCredentialsPath('../service-account.json'),
      /escapes S3_MOUNT_DIR/
    );
  });
});

test('lists Google credentials from S3_MOUNT_DIR when NODE_ENV is local', async () => {
  await withLocalCredentialDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'a.json'), '{}');
    await fs.writeFile(path.join(dir, 'b.txt'), 'ignored');

    const result = await listAvailableCredentials();

    assert.equal(result.mode, 'local');
    assert.deepEqual(result.credentials, [
      {
        key: path.join(dir, 'a.json'),
        displayName: 'a.json'
      }
    ]);
  });
});
