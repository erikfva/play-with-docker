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

// Credential cache with TTL eviction.
// A suspended or rotated token must not persist indefinitely in memory — it
// would silently reuse the dead token on every subsequent call until the
// process restarted. Entries expire after CREDENTIAL_CACHE_TTL_MS and are
// re-read from the source on the next request.
const CREDENTIAL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const loadedCredentials = new Map(); // key → { result, cachedAt }

function getCachedCredential(cacheKey) {
  const entry = loadedCredentials.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt >= CREDENTIAL_CACHE_TTL_MS) {
    loadedCredentials.delete(cacheKey);
    return null;
  }
  return entry.result;
}

function setCachedCredential(cacheKey, result) {
  loadedCredentials.set(cacheKey, { result, cachedAt: Date.now() });
}

function codespacesCredentialError(message, code, statusCode = 400) {
  return new ProviderError(message, { code, statusCode });
}

function isS3fsEnabled() {
  const raw = String(process.env.S3FS_ENABLED ?? '1').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function getCredentialsDirectory() {
  const directory = (process.env.S3_MOUNT_DIR || '').trim();
  if (!directory) {
    throw codespacesCredentialError(
      'S3_MOUNT_DIR is required when loading Codespaces credentials from the filesystem',
      'CODESPACES_NO_CREDENTIAL'
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
    throw codespacesCredentialError(
      'Codespaces credential reference must include bucket and key for s3:// references',
      'CODESPACES_NO_CREDENTIAL'
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
    throw codespacesCredentialError(
      'Codespaces credential path escapes allowed directory',
      'CODESPACES_NO_CREDENTIAL'
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
    throw codespacesCredentialError(
      'Codespaces credential reference is required',
      'CODESPACES_NO_CREDENTIAL',
      401
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

/**
 * Parse credential bytes into a plain-text token.
 * If the buffer is valid JSON, extract `credentialData.token`.
 * Otherwise treat the entire trimmed buffer as the raw token (plain-text `.txt` support).
 */
function parseTokenFromBuffer(fileBuffer) {
  const text = fileBuffer.toString('utf8').trim();

  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.token === 'string' && parsed.token.trim()) {
        return parsed.token.trim();
      }

      // Valid JSON without a token field is a malformed credential file, not a
      // plain-text PAT. Reject it instead of sending the whole JSON as the token.
      throw codespacesCredentialError(
        'Codespaces credentials JSON must contain a token field',
        'CODESPACES_NO_CREDENTIAL',
        401
      );
    }
  } catch (error) {
    if (error && error.code === 'CODESPACES_NO_CREDENTIAL') {
      throw error;
    }
    // Not JSON — fall through to plain-text handling
  }

  return text;
}

async function loadCredentialFile(credentialRefObj) {
  const cacheKey = getCredentialCacheKey(credentialRefObj);
  const cached = getCachedCredential(cacheKey);
  if (cached) {
    console.log(`[Codespaces] Reusing existing credentials: ${credentialRefObj.originalRef}`);
    return cached;
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
      throw codespacesCredentialError(
        `Failed to fetch Codespaces credentials from s3://${credentialRefObj.bucket}/${credentialRefObj.key}: ${error.message}`,
        'CODESPACES_NO_CREDENTIAL'
      );
    }

    if (!response.Body) {
      throw codespacesCredentialError(
        `S3 object has no body: s3://${credentialRefObj.bucket}/${credentialRefObj.key}`,
        'CODESPACES_NO_CREDENTIAL'
      );
    }

    fileBuffer = await streamToBuffer(response.Body);
  } else {
    // Filesystem
    try {
      fileBuffer = await fs.readFile(credentialRefObj.path);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw codespacesCredentialError(
          `Codespaces credentials file does not exist: ${credentialRefObj.path}`,
          'CODESPACES_NO_CREDENTIAL',
          404
        );
      }

      throw codespacesCredentialError(
        `Failed to read Codespaces credentials from ${credentialRefObj.path}: ${error.message}`,
        'CODESPACES_NO_CREDENTIAL'
      );
    }
  }

  const token = parseTokenFromBuffer(fileBuffer);
  if (!token) {
    throw codespacesCredentialError(
      'Codespaces credentials file must contain a non-empty token',
      'CODESPACES_NO_CREDENTIAL',
      401
    );
  }

  // Compute fingerprint for one codespace/session per token enforcement
  const fingerprint = crypto.createHash('sha256').update(token).digest('hex');

  const result = {
    token,
    credentialRef: credentialRefObj.originalRef,
    credentialFingerprint: `sha256:${fingerprint}`
  };

  setCachedCredential(cacheKey, result);

  return result;
}

async function loadCodespacesCredentials(credentialRefOrHeader) {
  const credentialRef = credentialRefOrHeader;

  // 1. Try DB first — if the ref matches a vps.name for this provider, use it.
  try {
    const { loadCredentialByRef } = require('../../../services/db-credentials-loader');
    const dbResult = await loadCredentialByRef('codespaces', credentialRef);
    if (dbResult) return dbResult;
  } catch (err) {
    if (err.code !== 'VPS_NOT_FOUND') throw err;
    // VPS_NOT_FOUND → no DB record with this name; fall through to legacy loader
    console.warn(`[Credentials] DB lookup miss for codespaces/${credentialRef}, falling back to legacy loader`);
  }

  // 2. Legacy path — resolve from filesystem / S3
  const resolvedRef = resolveCredentialReference(credentialRef);

  // Load and validate
  const result = await loadCredentialFile(resolvedRef);

  return result;
}

module.exports = {
  isS3fsEnabled,
  loadCodespacesCredentials,
  getCredentialsDirectory
};
