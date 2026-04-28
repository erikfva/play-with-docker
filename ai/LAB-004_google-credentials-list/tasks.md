# Tasks: LAB-004 - List Available Google Application Credentials

## Task 1: Create credentials listing service
- **File**: `src/services/credentials-lister.js` (new)
- **Description**: Create the service that lists available Google credentials in both S3 API and s3fs modes. Implements `listCredentialsS3`, `listCredentialsFs`, and `listAvailableCredentials` functions as described in the plan.
- **Status**: completed

## Task 2: Add credentials endpoint to sessions router
- **File**: `src/routes/sessions.js` (modify)
- **Description**: Import `listAvailableCredentials` and add `GET /api/v1/sessions/google-credentials` route. The route is already under `requireServerToken` and `setGoogleCredentials` middleware from `server.js`, so no additional auth wiring is needed. Use `mapErrorToHttp` for error handling.
- **Status**: completed
- **BlockedBy**: Task 1

## Task 3: Update documentation
- **Files**: `README.md`, `ai/project-overview.md`
- **Description**: Add the new `GET /api/v1/sessions/google-credentials` endpoint to the API section in README.md and to the API Surface section in project-overview.md. Include example curl command.
- **Status**: completed
- **BlockedBy**: Task 2

## Task 4: Verify implementation
- **Description**: Test that the credentials listing works correctly in both S3 API mode and s3fs mode. Verify error handling for S3 failures (503), missing directory (503), missing S3_BUCKET (500), and empty results (200 with empty array). Confirm endpoint requires server token.
- **Status**: completed
- **BlockedBy**: Task 2
