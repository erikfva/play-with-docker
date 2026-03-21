# Google Cloud Shell Integration Analysis

## Project Overview

This is a **multi-provider VPS orchestrator** that exposes a unified API to manage temporary virtual development environments. Currently, it supports **Google Cloud Shell (GCS)** and has scaffolding for Play with Docker (PWD) as additional providers.

The project uses an **adapter/factory pattern** to abstract provider-specific logic behind a common interface.

---

## How Google Cloud Shell is Used

### 1. **Architecture Pattern**

The project uses a **Provider Adapter Pattern**:

```
Express API Routes 
    ↓
Provider Factory (getProvider)
    ↓
GCS Provider Adapter (src/services/providers/gcs-provider.js)
    ↓
GCS Service (src/services/gcs-service.js) - Google Cloud Shell API
```

### 2. **Core Components**

#### **A. GCS Provider Adapter** ([src/services/providers/gcs-provider.js](src/services/providers/gcs-provider.js))

Implements the provider contract with four main methods:

- **`createSession()`** - Starts a new Cloud Shell environment
- **`refreshSession(sessionRow)`** - Polls Cloud Shell status and retrieves SSH connection details
- **`executeCommand(sessionRow, command)`** - Runs commands via SSH
- **`terminateSession(sessionRow)`** - Cleans up SSH keys when session ends

#### **B. GCS Service** ([src/services/gcs-service.js](src/services/gcs-service.js))

Direct integration with Google Cloud Shell API (v1) using the `googleapis` library:

```javascript
const { google } = require('googleapis');
const cloudshell = google.cloudshell('v1');
```

**Key API Operations:**

| Operation | Google API Method | Purpose |
|-----------|-------------------|---------|
| Start Session | `cloudshell.users.environments.start()` | Create new Cloud Shell environment |
| Get Status | `cloudshell.users.environments.get()` | Poll environment state & SSH details |
| Add Public Key | `cloudshell.users.environments.addPublicKey()` | Register SSH key for access |
| Remove Public Key | `cloudshell.users.environments.removePublicKey()` | Revoke SSH key on session cleanup |

#### **C. SSH Service** ([src/services/ssh-service.js](src/services/ssh-service.js))

Bridges the gap between the managed Cloud Shell environment and command execution:

- **`generateKeyPair()`** - Creates RSA 2048-bit SSH keypairs using system `ssh-keygen`
- **`executeCommand(connectionInfo, command, privateKey)`** - Uses `ssh2` client to execute commands remotely

### 3. **Session Workflow**

```
1. Client POST /api/v1/sessions (provider: "gcs")
   ↓
2. GcsProvider.createSession()
   ↓
3. GCS API: cloudshell.users.environments.start()
   └─ Returns: environment name (e.g., "users/user@example.com/environments/default")
   └ Status: STARTING
   ↓
4. Store in SQLite with:
   - id: internal UUID
   - provider: "gcs"
   - providerSessionId: environment name
   - status: STARTING
   ↓
5. Client polls GET /api/v1/sessions/:id
   ↓
6. GcsProvider.refreshSession()
   ↓
7. GCS API: cloudshell.users.environments.get()
   └─ Returns: { status, sshHost, sshUsername, sshPort, webHost }
   ↓
8. Once status === "RUNNING":
   ↓
9. Client sends: POST /api/v1/sessions/:id/command
   ↓
10. GcsProvider.executeCommand()
    ├─ Generate SSH keypair (once)
    ├─ GCS API: addPublicKey(publicKey)
    ├─ SSH: executeCommand() via ssh2 client
    └─ Store keys in session for future use
    ↓
11. Command output returned to client
```

### 4. **Key Technical Details**

#### **Authentication**
- Uses Google Service Account (specified via `GOOGLE_APPLICATION_CREDENTIALS`)
- Scopes: `https://www.googleapis.com/auth/cloud-platform`
- Automatically instantiated via `GoogleAuth` in each request

```javascript
const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform']
});
```

#### **Environment Naming**
- Default environment format: `users/{email}/environments/default`
- Extracts service account email from credentials

#### **SSH Access**
- Cloud Shell exposes SSH server with dynamic credentials
- Public keys are registered per environment
- SSH execution is stateless; any client with the private key can connect
- Port is typically 22 (configurable)

#### **Session State Management**
Database schema in SQLite:
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  provider TEXT,
  providerSessionId TEXT,
  envName TEXT,
  status TEXT,
  webHost TEXT,
  sshCommand TEXT,
  privateKey TEXT,
  publicKey TEXT,
  metadata TEXT (JSON),
  createdAt DATETIME,
  updatedAt DATETIME
);
```

### 5. **Error Handling**

Normalized provider errors in [src/services/errors/provider-errors.js](src/services/errors/provider-errors.js):

- `SessionNotReadyError` - Environment not yet in RUNNING state
- `UnsupportedProviderError` - Unknown provider requested
- Custom HTTP status codes per error type

### 6. **Configuration**

#### **Credential Modes** (documented in [README.md](README.md))

**Mode A: s3fs enabled** (`S3FS_ENABLED=1`)
- FUSE mount: S3 bucket to container filesystem
- `GOOGLE_APPLICATION_CREDENTIALS` = filesystem path to key file

**Mode B: s3fs disabled** (`S3FS_ENABLED=0`)
- App downloads credentials from S3 at startup using AWS SDK
- `GOOGLE_APPLICATION_CREDENTIALS` interpreted as:
  - `s3://bucket/key.json`, or
  - `key.json` relative to `S3_BUCKET`

### 7. **Current Limitations & Roadmap**

#### **Fully Implemented** ✅
- Google Cloud Shell provider
- Session creation and status polling
- SSH key lifecycle management
- Command execution via SSH
- Multi-provider architecture

#### **Not Yet Implemented** ⏳
- Play with Docker (PWD) provider (scaffolded as stub returning 501)
- AWS provider (planned for Phase 4+)
- Integration tests for provider contracts
- Swagger/OpenAPI documentation update

---

## API Usage Example

### Create a GCS Session
```bash
curl -X POST http://localhost:3000/api/v1/sessions \
  -H "Content-Type: application/json" \
  -H "X-Server-Token: $(echo -n 'server-secret' | sha256sum)" \
  -d '{"provider": "gcs"}'
```

Response:
```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "provider": "gcs",
  "providerSessionId": "users/service-account@project.iam.gserviceaccount.com/environments/default",
  "status": "STARTING"
}
```

### Poll Session Status
```bash
curl http://localhost:3000/api/v1/sessions/a1b2c3d4-e5f6-7890-abcd-ef1234567890 \
  -H "X-Server-Token: $(echo -n 'server-secret' | sha256sum)"
```

Response (once ready):
```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "provider": "gcs",
  "status": "RUNNING",
  "sshCommand": "ssh user@cloud-shell-host -p 22",
  "metadata": {
    "sshHost": "cloud-shell-host",
    "sshPort": 22,
    "sshUsername": "user",
    "publicKeys": [...]
  }
}
```

### Execute Command
```bash
curl -X POST http://localhost:3000/api/v1/sessions/a1b2c3d4-e5f6-7890-abcd-ef1234567890/command \
  -H "Content-Type: application/json" \
  -H "X-Server-Token: $(echo -n 'server-secret' | sha256sum)" \
  -d '{"command": "echo Hello from Cloud Shell"}'
```

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `googleapis` | ^171.4.0 | Google Cloud Shell API client |
| `ssh2` | ^1.17.0 | SSH command execution |
| `sqlite3` | ^5.1.7 | Session persistence |
| `express` | ^5.2.1 | REST API framework |
| `@aws-sdk/client-s3` | ^3.1011.0 | Credential fetching in s3-api mode |
| `dotenv` | ^17.3.1 | Environment variable management |

---

## Summary

This project abstracts Google Cloud Shell as a **virtual machine provider** through:

1. **API Integration**: Direct use of Google's Cloud Shell REST API for environment management
2. **SSH Bridge**: SSH keypair generation and remote execution layer
3. **Session Management**: Stateful tracking in SQLite with provider-agnostic contracts
4. **Multi-Provider Support**: Extensible adapter pattern for future VM sources (PWD, AWS, etc.)

The current implementation treats Cloud Shell environments as short-lived VPS-like remote systems accessible via SSH and managed through a REST API.
