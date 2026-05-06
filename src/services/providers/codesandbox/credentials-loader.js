const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { buildS3Client: buildBaseS3Client, streamToBuffer } = require('../../../services/google-credentials-loader');
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
  return process.env.CODESANDBOX_CREDENTIALS_DIR || process.env.S3_MOUNT_DIR || '/tmp/codesandbox';
}

function shouldResolveRelativeRefsFromFilesystem() {
  return Boolean(process.env.CODESANDBOX_CREDENTIALS_DIR || process.env.S3_MOUNT_DIR) || isS3fsEnabled();
}

function resolveCredentialReference(credentialRef) {
  if (!credentialRef) {
    throw codeSandboxCredentialError(
      'CODESANDBOX_DEFAULT_CREDENTIALS is not configured',
      'CODESANDBOX_CREDENTIALS_MISSING'
    );
  }

  if (credentialRef.startsWith('s3://')) {
    const withoutScheme = credentialRef.slice('s3://'.length);
    const slashIndex = withoutScheme.indexOf('/');
    if (slashIndex <= 0 || slashIndex === withoutScheme.length - 1) {
      throw codeSandboxCredentialError(
        'CodeSandbox credential reference must include bucket and key for s3:// references',
        'CODESANDBOX_CREDENTIALS_PATH_INVALID'
      );
    }
    return {
      type: 's3',
      bucket: withoutScheme.slice(0, slashIndex),
      key: withoutScheme.slice(slashIndex + 1),
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

  // Filesystem mode (s3fs or local directory)
  const credsDir = getCredentialsDirectory();
  let safePath;

  if (credentialRef.startsWith('/')) {
    // Absolute path
    safePath = path.normalize(credentialRef);
  } else {
    // Relative path
    safePath = path.normalize(path.join(credsDir, credentialRef));
  }

  // Security: ensure path is within credentials directory
  const normalizedCredsDir = path.normalize(credsDir);
  const normalizedSafePath = path.normalize(safePath);

  // Use path.relative to check if target is inside base directory
  const relative = path.relative(normalizedCredsDir, normalizedSafePath);

  // Reject if:
  // - relative path starts with '..' (escapes directory)
  // - relative path is absolute (shouldn't happen but be safe)
  // - relative path is empty (same directory)
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
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

function buildS3Client() {
  return buildBaseS3Client();
}

async function loadCredentialFile(credentialRefObj) {
  if (loadedCredentials.has(credentialRefObj.originalRef)) {
    console.log(`[CodeSandbox] Reusing existing credentials: ${credentialRefObj.originalRef}`);
    return loadedCredentials.get(credentialRefObj.originalRef);
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

  loadedCredentials.set(credentialRefObj.originalRef, result);

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
