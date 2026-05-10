const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const {
  buildS3Client: buildBaseS3Client,
  isLocalNodeEnv,
  streamToBuffer
} = require('../../../services/google-credentials-loader');
const { ProviderError } = require('../../errors/provider-errors');

const loadedCredentials = new Map();

function codeSandboxCredentialError(message, code, statusCode = 400) {
  return new ProviderError(message, { code, statusCode });
}

function isS3fsEnabled() {
  const raw = String(process.env.S3FS_ENABLED ?? '1').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function getCredentialsDirectory() {
  const directory = (process.env.S3_MOUNT_DIR || '').trim();
  if (!directory) {
    throw codeSandboxCredentialError(
      'S3_MOUNT_DIR is required when loading CodeSandbox credentials from the filesystem',
      'CODESANDBOX_CREDENTIALS_PATH_INVALID'
    );
  }

  return directory;
}

function shouldResolveRelativeRefsFromFilesystem() {
  return isLocalNodeEnv() || isS3fsEnabled();
}

function getCredentialCacheKey(credentialRefObj) {
  if (credentialRefObj.type === 's3') {
    return `s3://${credentialRefObj.bucket}/${credentialRefObj.key}`;
  }

  return `file:${credentialRefObj.path}`;
}

function parseS3CredentialReference(credentialRef) {
  const withoutScheme = credentialRef.slice('s3://'.length);
  const slashIndex = withoutScheme.indexOf('/');
  if (slashIndex <= 0 || slashIndex === withoutScheme.length - 1) {
    throw codeSandboxCredentialError(
      'CodeSandbox credential reference must include bucket and key for s3:// references',
      'CODESANDBOX_CREDENTIALS_PATH_INVALID'
    );
  }

  return {
    bucket: withoutScheme.slice(0, slashIndex),
    key: withoutScheme.slice(slashIndex + 1)
  };
}

function resolveFilesystemCredentialReference(credentialRef, keyOverride) {
  const credsDir = getCredentialsDirectory();
  const ref = keyOverride || credentialRef;
  let safePath;

  if (path.isAbsolute(ref)) {
    safePath = path.normalize(ref);
  } else {
    safePath = path.normalize(path.join(credsDir, ref));
  }

  const normalizedCredsDir = path.resolve(credsDir);
  const normalizedSafePath = path.resolve(safePath);
  const relative = path.relative(normalizedCredsDir, normalizedSafePath);

  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw codeSandboxCredentialError(
      'CodeSandbox credential path escapes allowed directory',
      'CODESANDBOX_CREDENTIALS_PATH_INVALID'
    );
  }

  return {
    type: 'filesystem',
    path: safePath,
    originalRef: credentialRef
  };
}

function resolveCredentialReference(credentialRef) {
  if (!credentialRef) {
    if (isLocalNodeEnv()) {
      throw codeSandboxCredentialError(
        `CodeSandbox credentials file is not configured. Set CODESANDBOX_DEFAULT_CREDENTIALS or send x-codesandbox-credentials/credentialRef with a file under S3_MOUNT_DIR`,
        'CODESANDBOX_CREDENTIALS_MISSING'
      );
    }

    throw codeSandboxCredentialError(
      'CODESANDBOX_DEFAULT_CREDENTIALS is not configured',
      'CODESANDBOX_CREDENTIALS_MISSING'
    );
  }

  if (credentialRef.startsWith('s3://')) {
    const { bucket, key } = parseS3CredentialReference(credentialRef);
    if (isLocalNodeEnv()) {
      return resolveFilesystemCredentialReference(credentialRef, key);
    }

    return {
      type: 's3',
      bucket,
      key,
      originalRef: credentialRef
    };
  }

  const bucket = process.env.S3_BUCKET;
  if (bucket && !shouldResolveRelativeRefsFromFilesystem()) {
    // S3 API mode: treat as object key under S3_BUCKET
    const key = credentialRef.replace(/^\/+/, '');
    return {
      type: 's3',
      bucket,
      key,
      originalRef: credentialRef
    };
  }

  return resolveFilesystemCredentialReference(credentialRef);
}

function buildS3Client() {
  return buildBaseS3Client();
}

async function loadCredentialFile(credentialRefObj) {
  const cacheKey = getCredentialCacheKey(credentialRefObj);
  if (loadedCredentials.has(cacheKey)) {
    console.log(`[CodeSandbox] Reusing existing credentials: ${credentialRefObj.originalRef}`);
    return loadedCredentials.get(cacheKey);
  }

  let fileBuffer;

  if (credentialRefObj.type === 's3') {
    const s3 = buildS3Client();
    let response;
    try {
      response = await s3.send(
        new GetObjectCommand({
          Bucket: credentialRefObj.bucket,
          Key: credentialRefObj.key
        })
      );
    } catch (error) {
      throw codeSandboxCredentialError(
        `Failed to fetch CodeSandbox credentials from s3://${credentialRefObj.bucket}/${credentialRefObj.key}: ${error.message}`,
        'CODESANDBOX_CREDENTIALS_MISSING'
      );
    }

    if (!response.Body) {
      throw codeSandboxCredentialError(
        `S3 object has no body: s3://${credentialRefObj.bucket}/${credentialRefObj.key}`,
        'CODESANDBOX_CREDENTIALS_INVALID'
      );
    }

    fileBuffer = await streamToBuffer(response.Body);
  } else {
    // Filesystem
    try {
      fileBuffer = await fs.readFile(credentialRefObj.path);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw codeSandboxCredentialError(
          `CodeSandbox credentials file does not exist: ${credentialRefObj.path}`,
          'CODESANDBOX_CREDENTIALS_MISSING',
          404
        );
      }

      throw codeSandboxCredentialError(
        `Failed to read CodeSandbox credentials from ${credentialRefObj.path}: ${error.message}`,
        'CODESANDBOX_CREDENTIALS_MISSING'
      );
    }
  }

  let credentialData;
  try {
    credentialData = JSON.parse(fileBuffer.toString('utf8'));
  } catch (error) {
    throw codeSandboxCredentialError(
      `CodeSandbox credentials file is not valid JSON: ${error.message}`,
      'CODESANDBOX_CREDENTIALS_INVALID'
    );
  }

  if (!credentialData || typeof credentialData.token !== 'string' || !credentialData.token.trim()) {
    throw codeSandboxCredentialError(
      'CodeSandbox credentials file must contain a non-empty "token" field',
      'CODESANDBOX_TOKEN_MISSING'
    );
  }

  const token = credentialData.token.trim();

  // Compute fingerprint for one sandbox/session per token enforcement
  const fingerprint = crypto.createHash('sha256').update(token).digest('hex');

  const result = {
    token,
    credentialRef: credentialRefObj.originalRef,
    credentialFingerprint: `sha256:${fingerprint}`
  };

  loadedCredentials.set(cacheKey, result);

  return result;
}

async function loadCodeSandboxCredentials(credentialRefOrHeader) {
  // Determine credential reference source
  let credentialRef;

  if (credentialRefOrHeader) {
    // Use provided reference (from header or default)
    credentialRef = credentialRefOrHeader;
  } else if (process.env.CODESANDBOX_DEFAULT_CREDENTIALS) {
    credentialRef = process.env.CODESANDBOX_DEFAULT_CREDENTIALS;
  } else {
    if (isLocalNodeEnv()) {
      throw codeSandboxCredentialError(
        `CodeSandbox credentials file is not configured. Set CODESANDBOX_DEFAULT_CREDENTIALS or send x-codesandbox-credentials/credentialRef with a file under S3_MOUNT_DIR`,
        'CODESANDBOX_CREDENTIALS_MISSING'
      );
    }

    throw codeSandboxCredentialError(
      'CODESANDBOX_DEFAULT_CREDENTIALS is not configured',
      'CODESANDBOX_CREDENTIALS_MISSING'
    );
  }

  // Resolve reference to actual source
  const resolvedRef = resolveCredentialReference(credentialRef);

  // Load and validate
  const result = await loadCredentialFile(resolvedRef);

  return result;
}

module.exports = {
  isS3fsEnabled,
  loadCodeSandboxCredentials,
  getCredentialsDirectory
};
