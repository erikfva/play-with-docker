# Story: LAB-004 - List Available Google Application Credentials

## 1. Jira Story

- Story Key: `LAB-004`
- Type: `Story`
- Priority: `Medium`
- Component: `API / Credentials`
- Labels: `gcs`, `credentials`, `s3`, `discovery`

## 2. Summary

As a client application, I want to retrieve a list of available Google Application Credentials files (`.json` service account keys) that can be used to create GCS sessions, so I can let users select which service account to use instead of hardcoding a single credential file.

## 3. Problem Statement

Current behavior:
- The server loads a single Google credential file determined by `GOOGLE_APPLICATION_CREDENTIALS` at startup (S3 API mode) or from the FUSE mount (s3fs mode).
- Clients have no way to discover which credential files are available.
- When multiple service accounts are stored in the S3 bucket (e.g., `sa-prod.json`, `sa-staging.json`, `sa-dev.json`), there is no API to list them.
- The `x-google-credentials` header allows per-request override, but clients must know the valid key names in advance.

Required behavior:
- A new endpoint `GET /api/v1/sessions/google-credentials` returns a list of available credential files.
- The list is derived from the configured credential source (S3 bucket listing or filesystem directory).
- Clients can use this list to populate a dropdown or validation set before creating sessions.

## 4. Scope

In scope:
- New `GET /api/v1/sessions/google-credentials` endpoint (token-protected).
- S3 mode: list `.json` objects under the configured `S3_BUCKET` prefix.
- s3fs mode: list `.json` files under the `GOOGLE_APPLICATION_CREDENTIALS` directory or `S3_MOUNT_DIR`.
- Response includes file names/keys and optionally a display label.

Out of scope:
- Credential file content inspection or validation.
- Credential file upload/delete management endpoints.
- Automatic credential rotation or expiry notification.
- Caching of the credentials list (initial implementation fetches fresh per request).

## 5. Functional Requirements

1. New endpoint `GET /api/v1/sessions/google-credentials` must require server token authentication (`x-server-token` or `Authorization: Bearer`).

2. The endpoint must inspect the current credential mode and list available `.json` files accordingly:

   **S3 API mode** (`S3FS_ENABLED=0`):
   - Use the S3 client to call `ListObjectsV2` (or `ListObjects`) on `S3_BUCKET`.
   - Return all keys ending in `.json` (case-sensitive).
   - If `GOOGLE_APPLICATION_CREDENTIALS` is an `s3://bucket/key` URL, use its bucket; otherwise use `S3_BUCKET`.
   - Support an optional `prefix` query parameter to scope the listing (e.g., `?prefix=service-accounts/`).

   **s3fs mode** (`S3FS_ENABLED=1`):
   - Determine the credentials directory:
     - If `GOOGLE_APPLICATION_CREDENTIALS` points to a file, use its parent directory.
     - Fall back to `S3_MOUNT_DIR` if set.
   - Use `fs.readdir` to list files in that directory.
   - Return all entries ending in `.json` (case-sensitive).

3. Response format:

   ```json
   {
     "credentials": [
       {
         "key": "service-accounts/sa-prod.json",
         "displayName": "sa-prod.json"
       },
       {
         "key": "service-accounts/sa-staging.json",
         "displayName": "sa-staging.json"
       }
     ],
     "mode": "s3-api",
     "default": "service-accounts/sa-prod.json"
   }
   ```

   - `key`: the value to pass in `x-google-credentials` header or to use as `GOOGLE_APPLICATION_CREDENTIALS`.
   - `displayName`: short filename for UI display.
   - `mode`: either `"s3-api"` or `"s3fs"` for client awareness.
   - `default`: the currently configured `GOOGLE_APPLICATION_CREDENTIALS` value (resolved to a relative key in S3 mode, or filename in s3fs mode).

4. If the credential source is inaccessible (S3 error, directory not found), return a `503` with an appropriate error message.

5. If no `.json` files are found, return an empty `credentials` array (not an error).

6. Only `.json` files are returned; other file types in the directory/bucket are ignored.

## 6. Error Handling

| Scenario | Status Code | Response Body |
|---|---|---|
| S3 listing fails (network, permissions) | `503` | `{ "error": "Failed to list credentials", "code": "S3_LIST_FAILED" }` |
| s3fs directory does not exist | `503` | `{ "error": "Credentials directory not found", "code": "DIR_NOT_FOUND" }` |
| No `.json` files found | `200` | `{ "credentials": [], "mode": "...", "default": "..." }` |
| Missing `S3_BUCKET` in S3 mode | `500` | `{ "error": "S3_BUCKET is not configured", "code": "S3_BUCKET_MISSING" }` |

## 7. Testing Considerations

- Mock S3 `ListObjectsV2` to verify filtering of `.json` files and handling of `prefix`.
- Mock filesystem `readdir` to verify s3fs mode listing.
- Test empty results (no `.json` files).
- Test error propagation when S3 or filesystem is unavailable.
- Verify endpoint requires server token (reuse existing `requireServerToken` middleware).

## 8. Dependencies

- No new npm packages required; uses existing `@aws-sdk/client-s3` for S3 listing.
- New file: `src/services/credentials-lister.js`.
- Modified file: `src/routes/sessions.js` (add route).
- Optional: update `README.md` and `ai/project-overview.md` to document the new endpoint.
