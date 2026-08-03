const fs = require('fs/promises');
const path = require('path');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const {
  isS3fsEnabled,
  isLocalNodeEnv,
  buildS3Client,
  resolveBucketAndKey
} = require('./google-credentials-loader');

function createError(message, code, httpStatus) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = httpStatus;
  return err;
}

async function listCredentialsS3(bucket, prefix) {
  if (!bucket) {
    throw createError('S3_BUCKET is not configured', 'S3_BUCKET_MISSING', 500);
  }

  const s3 = buildS3Client();
  const command = new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix || '',
  });

  try {
    const response = await s3.send(command);

    const files = (response.Contents || [])
      .map((obj) => obj.Key)
      .filter((key) => {
        const lower = key.toLowerCase();
        return lower.endsWith('.json') || lower.endsWith('.txt');
      })
      .map((key) => ({
        key,
        displayName: path.basename(key),
      }));

    return files;
  } catch (err) {
    throw createError('Failed to list credentials', 'S3_LIST_FAILED', 503);
  }
}

async function listCredentialsFs(directory) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    const files = entries
      .filter((entry) => {
        const lower = entry.name.toLowerCase();
        return entry.isFile() && (lower.endsWith('.json') || lower.endsWith('.txt'));
      })
      .map((entry) => {
        const fullPath = path.join(directory, entry.name);
        return {
          key: fullPath,
          displayName: entry.name,
        };
      });

    return files;
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw createError('Credentials directory not found', 'DIR_NOT_FOUND', 503);
    }
    throw createError('Failed to list credentials', 'DIR_NOT_FOUND', 503);
  }
}

async function listAvailableCredentials(prefix) {
  const prefixPath = prefix ? '/' + prefix : '';
  if (isLocalNodeEnv() || isS3fsEnabled()) {
    const directory = (process.env.S3_MOUNT_DIR || '') + prefixPath;
    const files = await listCredentialsFs(directory);
    const mode = isS3fsEnabled() ? 's3fs' : 'local';
    return { credentials: files, mode, default: '' };
  }

  let bucket;
  try {
    ({ bucket } = resolveBucketAndKey('placeholder.json'));
  } catch (err) {
    if (!err.statusCode) {
      throw createError(err.message, 'S3_BUCKET_MISSING', 500);
    }
    throw err;
  }
  const files = await listCredentialsS3(bucket, prefix);
  const mode = 's3-api';

  return { credentials: files, mode, default: '' };
}

module.exports = { listAvailableCredentials };
