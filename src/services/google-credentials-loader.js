const fs = require('fs/promises');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const loadedCredentialsFiles = new Set();

function isS3fsEnabled() {
  const raw = String(process.env.S3FS_ENABLED ?? '1').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function isLocalNodeEnv() {
  return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'local';
}

function getLocalCredentialsDirectory() {
  const directory = (process.env.S3_MOUNT_DIR || '').trim();
  if (!directory) {
    throw new Error('S3_MOUNT_DIR is required when NODE_ENV=local');
  }
  return directory;
}

function getMountedCredentialsDirectory() {
  const directory = (process.env.S3_MOUNT_DIR || '').trim();
  if (!directory) {
    throw new Error('S3_MOUNT_DIR is required when S3FS_ENABLED=1 and credential references are relative');
  }
  return directory;
}

function isPathInsideDirectory(directory, targetPath) {
  const relative = path.relative(directory, targetPath);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveBucketAndKey(credentialsRef) {
  if (credentialsRef.startsWith('s3://')) {
    const withoutScheme = credentialsRef.slice('s3://'.length);
    const slashIndex = withoutScheme.indexOf('/');
    if (slashIndex <= 0 || slashIndex === withoutScheme.length - 1) {
      throw new Error(
        `GOOGLE_APPLICATION_CREDENTIALS must include bucket and key for s3:// references (got: ${credentialsRef})`
      );
    }
    return {
      bucket: withoutScheme.slice(0, slashIndex),
      key: withoutScheme.slice(slashIndex + 1)
    };
  }

  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error(
      'S3_BUCKET is required when S3FS_ENABLED=0 and GOOGLE_APPLICATION_CREDENTIALS is not an s3:// URL'
    );
  }

  const key = credentialsRef.replace(/^\/+/, '');
  if (!key) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS cannot be empty when S3FS_ENABLED=0');
  }

  return { bucket, key };
}

function resolveLocalCredentialsPath(credentialsRef) {
  const ref = (credentialsRef || '').trim();
  if (!ref) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS cannot be empty when NODE_ENV=local');
  }

  const directory = path.resolve(getLocalCredentialsDirectory());
  let localPath;

  if (ref.startsWith('s3://')) {
    const { key } = resolveBucketAndKey(ref);
    localPath = path.resolve(directory, key);
  } else if (path.isAbsolute(ref)) {
    const absolutePath = path.resolve(ref);
    localPath = isPathInsideDirectory(directory, absolutePath)
      ? absolutePath
      : path.resolve(directory, ref.replace(/^\/+/, ''));
  } else {
    localPath = path.resolve(directory, ref);
  }

  if (!isPathInsideDirectory(directory, localPath)) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS path escapes S3_MOUNT_DIR when NODE_ENV=local');
  }

  return localPath;
}

function resolveS3fsCredentialsPath(credentialsRef) {
  const ref = (credentialsRef || '').trim();
  if (!ref) {
    return null;
  }

  if (path.isAbsolute(ref)) {
    return path.resolve(ref);
  }

  const directory = path.resolve(getMountedCredentialsDirectory());
  const key = ref.startsWith('s3://')
    ? resolveBucketAndKey(ref).key
    : ref.replace(/^\/+/, '');
  const credentialsPath = path.resolve(directory, key);

  if (!isPathInsideDirectory(directory, credentialsPath)) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS path escapes S3_MOUNT_DIR when S3FS_ENABLED=1');
  }

  return credentialsPath;
}

function getDownloadedCredentialsPath(bucket, key) {
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${bucket}/${key}`)
    .digest('hex');

  return path.join(os.tmpdir(), 'gcs-credentials', `${fingerprint}.json`);
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function buildS3Client() {
  const region = process.env.S3_REGION || process.env.AWS_REGION || 'us-east-1';
  const endpoint = process.env.S3_ENDPOINT || undefined;
  const hasStaticCreds = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY;

  const clientConfig = {
    region
  };

  if (endpoint) {
    clientConfig.endpoint = endpoint;
    clientConfig.forcePathStyle = true;
  }

  if (hasStaticCreds) {
    clientConfig.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN || undefined
    };
  }

  return new S3Client(clientConfig);
}

async function initGoogleCredentialsFromS3IfNeeded( googleCredentials ) {
  if (isLocalNodeEnv()) {
    console.log('Credential mode: local (read GOOGLE_APPLICATION_CREDENTIALS from S3_MOUNT_DIR)');
    const credentialsRef = (googleCredentials || process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
    if (!credentialsRef) {
      console.log('Credential mode: local skipped (GOOGLE_APPLICATION_CREDENTIALS is empty)');
      return;
    }

    const localPath = resolveLocalCredentialsPath(credentialsRef);
    try {
      await fs.access(localPath);
    } catch (error) {
      throw new Error(`Failed to read local credentials from ${localPath}: ${error.message}`);
    }

    process.env.GOOGLE_APPLICATION_CREDENTIALS = localPath;
    loadedCredentialsFiles.add(credentialsRef);
    console.log(`Loaded GOOGLE_APPLICATION_CREDENTIALS from local file ${localPath}`);
    return localPath;
  }

  if (isS3fsEnabled()) {
    console.log('Credential mode: s3fs (filesystem path from GOOGLE_APPLICATION_CREDENTIALS)');
    const credentialsRef = (googleCredentials || '').trim();
    if (credentialsRef) {
      const credentialsPath = resolveS3fsCredentialsPath(credentialsRef);
      try {
        await fs.access(credentialsPath);
      } catch (error) {
        throw new Error(`Failed to read mounted credentials from ${credentialsPath}: ${error.message}`);
      }

      process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
      return credentialsPath;
    }
    return;
  }

  console.log('Credential mode: s3-api (download GOOGLE_APPLICATION_CREDENTIALS from object storage)');
  const credentialsRef = (googleCredentials || process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  if (!credentialsRef) {
    console.log('Credential mode: s3-api skipped (GOOGLE_APPLICATION_CREDENTIALS is empty)');
    return;
  }

  const { bucket, key } = resolveBucketAndKey(credentialsRef);
  const outputPath = getDownloadedCredentialsPath(bucket, key);
  //Check if credential file already exist
  if (loadedCredentialsFiles.has(credentialsRef)) {
    console.log(`Reusing existing credentials file: ${credentialsRef}`);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = outputPath;
    return outputPath;
  }

  const s3 = buildS3Client();
  let response;
  try {
    response = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key
      })
    );
  } catch (error) {
    throw new Error(`Failed to fetch credentials from s3://${bucket}/${key}: ${error.message}`);
  }
  if (!response.Body) {
    throw new Error(`S3 object has no body: s3://${bucket}/${key}`);
  }

  const fileBuffer = await streamToBuffer(response.Body);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, fileBuffer, { mode: 0o600 });
  
  process.env.GOOGLE_APPLICATION_CREDENTIALS = outputPath;
  console.log(`Loaded GOOGLE_APPLICATION_CREDENTIALS from s3://${bucket}/${key}`);
  loadedCredentialsFiles.add(credentialsRef);
  return outputPath;
}

module.exports = {
  isS3fsEnabled,
  isLocalNodeEnv,
  buildS3Client,
  resolveBucketAndKey,
  resolveLocalCredentialsPath,
  resolveS3fsCredentialsPath,
  initGoogleCredentialsFromS3IfNeeded,
  streamToBuffer
};
