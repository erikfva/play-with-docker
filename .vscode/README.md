# VSCode Debugging Configuration

This directory contains VSCode configuration files for debugging the Play with Docker API.

## Available Debug Configurations

1. **Launch Play with Docker API** - Starts the application in debug mode
2. **Attach to Play with Docker API** - Attaches to a running instance (useful for Docker debugging)

## Prerequisites

Before debugging, make sure you have:

1. Node.js installed (v14+ recommended)
2. PostgreSQL running and accessible
3. Environment variables configured (see below)
4. Google Cloud credentials (if testing GCS functionality)

## Environment Variables

You'll need to set these in the launch.json file or your environment:

- `NODE_ENV`: Set to "development" for debugging
- `PORT`: Defaults to 3000
- `SERVER_TOKEN`: Your API token for authentication
- `DATABASE_URL_CONN`: PostgreSQL connection string
- `S3FS_ENABLED`: Set to "0" or "1" for credential loading mode
- `S3_BUCKET`: Your S3 bucket name (if using S3 credentials)
- `AWS_ACCESS_KEY_ID`: AWS access key ID
- `AWS_SECRET_ACCESS_KEY`: AWS secret access key

## How to Debug

1. **Launch Configuration**: Press F5 or click the green debug button to start debugging
2. **Attach Configuration**: 
   - First start the app with `npm start` or `node src/server.js`
   - Then use the "Attach to Play with Docker API" configuration

## Breakpoints

You can set breakpoints in:
- `src/server.js` - Application entry point
- `src/routes/sessions.js` - API route handlers
- `src/services/providers/gcs-provider.js` - GCS provider logic
- `src/services/keep-alive-service.js` - Keep-alive mechanism
- Any other service or middleware files

## Troubleshooting

If you encounter issues:

1. Make sure PostgreSQL is running and the database exists
2. Verify the Google credential reference sent with the request is valid and has Cloud Shell API access
3. Check that the S3 configuration is correct if using S3-backed credentials
4. Look at the Debug Console in VSCode for error messages
