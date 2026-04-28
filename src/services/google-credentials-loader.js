const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const loadedCredentialsFiles = new Set();

function isS3fsEnabled() {
  const raw = String(process.env.S3FS_ENABLED ?? '1').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
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
  if (isS3fsEnabled()) {
    console.log('Credential mode: s3fs (filesystem path from GOOGLE_APPLICATION_CREDENTIALS)');
    return;
  }

  console.log('Credential mode: s3-api (download GOOGLE_APPLICATION_CREDENTIALS from object storage)');
  const credentialsRef = (googleCredentials || process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  if (!credentialsRef) {
    console.log('Credential mode: s3-api skipped (GOOGLE_APPLICATION_CREDENTIALS is empty)');
    return;
  }

  const outputPath = path.join(os.tmpdir(), credentialsRef);
  //Check if credential file already exist
  if (loadedCredentialsFiles.has(credentialsRef)) {
    console.log(`Reusing existing credentials file: ${credentialsRef}`);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = outputPath;
    return outputPath;
  }

  const { bucket, key } = resolveBucketAndKey(credentialsRef);
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
  
  if(!process.env.GOOGLE_APPLICATION_DEFAULT_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_DEFAULT_CREDENTIALS = outputPath;
  }

  process.env.GOOGLE_APPLICATION_CREDENTIALS = outputPath;
  console.log(`Loaded GOOGLE_APPLICATION_CREDENTIALS from s3://${bucket}/${key}`);
  loadedCredentialsFiles.add(credentialsRef);
  return outputPath;
}

module.exports = {
  isS3fsEnabled,
  buildS3Client,
  resolveBucketAndKey,
  initGoogleCredentialsFromS3IfNeeded
};
