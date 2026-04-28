# Plan: LAB-004 - Implement Credentials List Endpoint

## Step 1: Create credentials listing service

Create `src/services/credentials-lister.js`:

```javascript
const fs = require('fs/promises');
const path = require('path');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { isS3fsEnabled, buildS3Client, resolveBucketAndKey } = require('./google-credentials-loader');

async function listCredentialsS3(bucket, prefix) {
  const s3 = buildS3Client();
  const command = new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix || '',
  });

  const response = await s3.send(command);

  const files = (response.Contents || [])
    .map((obj) => obj.Key)
    .filter((key) => key.toLowerCase().endsWith('.json'))
    .map((key) => ({
      key,
      displayName: path.basename(key),
    }));

  return files;
}

async function listCredentialsFs(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => {
      const fullPath = path.join(directory, entry.name);
      return {
        key: fullPath,
        displayName: entry.name,
      };
    });

  return files;
}

async function listAvailableCredentials(prefix) {
  if (isS3fsEnabled()) {
    const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.S3_MOUNT_DIR || '';
    const directory = credentialsPath.endsWith('.json')
      ? path.dirname(credentialsPath)
      : credentialsPath;

    const files = await listCredentialsFs(directory);
    const mode = 's3fs';
    const defaultKey = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';

    return { credentials: files, mode, default: defaultKey };
  }

  // S3 API mode
  const credentialsRef = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  const { bucket } = resolveBucketAndKey(credentialsRef || 'placeholder.json');
  const files = await listCredentialsS3(bucket, prefix);
  const mode = 's3-api';
  const defaultKey = credentialsRef.startsWith('s3://')
    ? credentialsRef.replace(/^s3:\/\/[^/]+\//, '')
    : credentialsRef;

  return { credentials: files, mode, default: defaultKey };
}

module.exports = { listAvailableCredentials };
```

## Step 2: Add route to sessions router

In `src/routes/sessions.js`, add the import and route (before the module.exports):

```javascript
const { listAvailableCredentials } = require('../services/credentials-lister');
```

```javascript
router.get('/google-credentials', async (req, res) => {
  try {
    const prefix = req.query.prefix;
    const result = await listAvailableCredentials(prefix);
    return res.json(result);
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to list credentials');
  }
});
```

The route is already under the `requireServerToken` and `setGoogleCredentials` middleware from `server.js` line 21, so no additional auth wiring is needed.

## Step 3: Update documentation

- Add the new endpoint to the API section in `README.md`.
- Add the endpoint to `ai/project-overview.md` under the API Surface section.

Example for README:

```markdown
List available credentials:
```bash
curl http://localhost:3000/api/v1/sessions/google-credentials \
  -H "x-server-token: $SERVER_TOKEN"
```
```
