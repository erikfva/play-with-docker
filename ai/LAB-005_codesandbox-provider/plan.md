# Plan: LAB-005 - Add CodeSandbox Provider

## 1. Technical Context

Current project shape:
- Provider abstraction lives under `src/services/providers/`.
- Provider registration lives in `src/services/provider-factory.js`.
- Session API routes live in `src/routes/sessions.js`.
- Session records are stored in PostgreSQL through `src/db/db.js`.
- Current implemented provider is `gcs`.
- `pwd` remains a deprecated stub.

CodeSandbox integration target:
- Use `@codesandbox/sdk`.
- Use CodeSandbox sandbox creation for session creation.
- Use SDK command execution instead of SSH.
- Use SDK resume/connect behavior before command execution when needed.
- Use SDK delete for session termination.

Reference docs:
- SDK quickstart and API key setup: https://codesandbox.io/docs/sdk
- Sandbox creation: https://codesandbox.io/docs/sdk/create
- Commands: https://codesandbox.io/docs/sdk/commands
- Resume: https://codesandbox.io/docs/sdk/resume
- Delete: https://codesandbox.io/docs/sdk/delete
- Lifecycle management: https://codesandbox.io/docs/sdk/manage-sandboxes
- VM specs: https://codesandbox.io/docs/sdk/specs
- Pricing and plan limits: https://codesandbox.io/docs/sdk/pricing

## 2. Implementation Steps

### Step 1: Add Dependency

Add the CodeSandbox SDK:

```bash
npm install @codesandbox/sdk
```

This updates:
- `package.json`
- `package-lock.json`

Pin the installed version and avoid broad version assumptions in provider code.

### Step 2: Add Provider Folder

Create:

```text
src/services/providers/codesandbox/
```

Initial helper files:

```text
src/services/providers/codesandbox/client.js
src/services/providers/codesandbox/session-mapper.js
```

Rationale:
- Keep SDK client creation and response mapping separate from provider lifecycle methods.
- Make SDK behavior mockable for tests.

### Step 3: Add Provider Implementation

Create:

```text
src/services/providers/codesandbox-provider.js
```

The provider should extend `BaseProvider` and implement:
- `createSession(options)`
- `refreshSession(sessionRow)`
- `executeCommand(sessionRow, command)`
- `terminateSession(sessionRow)`
- `getKeepAliveConfig()`
- `executeKeepAlive(sessionRow)`
- `isSessionActive(sessionRow)`

Initial keep-alive config:

```js
getKeepAliveConfig() {
  return {
    enabled: false,
    intervalMinutes: null,
    strategy: 'provider-managed-hibernation'
  };
}
```

Reasoning:
- Current keep-alive is SSH-oriented.
- CodeSandbox supports provider-managed hibernation/resume.
- Command execution can resume the sandbox when needed.

### Step 4: SDK Client Helper

Implement `src/services/providers/codesandbox/client.js`.

Requirements:
- Import `CodeSandbox` from `@codesandbox/sdk`.
- Prefer `process.env.CODESANDBOX_API_KEY`.
- Fall back to `process.env.CSB_API_KEY`.
- Validate API key during provider operation, not at module load.
- Export a factory or lazy singleton so tests can replace/mock the SDK.

Configuration errors should be translated into provider-safe errors, not raw thrown SDK or environment errors.

### Step 5: Session Mapper

Implement `src/services/providers/codesandbox/session-mapper.js`.

Map SDK sandbox objects into the app's existing session model:

```json
{
  "provider": "codesandbox",
  "providerSessionId": "sandbox-id",
  "envName": "sandbox-id-or-title",
  "sshCommand": null,
  "webHost": null,
  "status": "RUNNING",
  "metadata": {
    "sandboxId": "sandbox-id",
    "title": "my-sandbox",
    "cluster": "...",
    "bootupType": "RUNNING",
    "isUpToDate": true,
    "privacy": "public-hosts",
    "vmTier": "Nano"
  }
}
```

Rules:
- Do not assume every SDK field exists.
- Store provider-specific values in `metadata`.
- Keep normalized top-level fields compatible with GCS session rows.
- Do not set `sshCommand` unless CodeSandbox exposes a supported SSH path later.

### Step 6: Provider Creation Behavior

Support request options:
- `templateId`
- `title`
- `description`
- `tags`
- `privacy`
- `vmTier`
- `hibernationTimeoutSeconds`

Environment defaults:

```env
CODESANDBOX_TEMPLATE_ID=...
CODESANDBOX_DEFAULT_PRIVACY=public-hosts
CODESANDBOX_DEFAULT_VM_TIER=Nano
CODESANDBOX_HIBERNATION_TIMEOUT_SECONDS=300
```

Request values override environment defaults.

Creation flow:
1. Validate API key.
2. Build SDK create options.
3. Use `sdk.sandboxes.create(...)`.
4. Optionally connect or create a session if needed to prove readiness.
5. Map SDK sandbox to normalized provider session shape.
6. Return normalized session data to the existing route layer.

### Step 7: Command Execution Behavior

Use CodeSandbox SDK Commands API.

Flow:
1. Read CodeSandbox sandbox ID from `sessionRow.providerSessionId`.
2. Resume sandbox if needed with `sdk.sandboxes.resume(id)`.
3. Connect to the sandbox.
4. Run command through `client.commands.run(command)`.
5. Dispose/close SDK client when supported by the SDK.
6. Return normalized command result:

```json
{
  "provider": "codesandbox",
  "sandboxId": "sandbox-id",
  "output": "command output",
  "exitCode": null
}
```

If the SDK does not expose an exit code, return `null` or omit it consistently with route behavior.

### Step 8: Refresh Behavior

Refresh flow:
1. Resolve SDK client.
2. Retrieve or resume sandbox by `providerSessionId`.
3. Map current SDK sandbox data into normalized fields.
4. Return status and metadata for route/database update.

If CodeSandbox reports the sandbox no longer exists, translate to a provider `not found` style error.

### Step 9: Termination Behavior

Termination flow:
1. Read sandbox ID from `providerSessionId`.
2. Call `sdk.sandboxes.delete(sandboxId)`.
3. Return success if provider cleanup succeeds.
4. If delete fails, preserve current route best-effort semantics and return/log a sanitized warning.

Design decision:
- Initial terminate means delete, not hibernate.
- Add a future story for explicit hibernate/resume endpoints if state preservation is required.

### Step 10: Register Provider

Modify:

```text
src/services/provider-factory.js
```

Add:

```js
const CodeSandboxProvider = require('./providers/codesandbox-provider');
```

Register:

```js
codesandbox: new CodeSandboxProvider()
```

Verify:
- `listProviders()` returns `codesandbox`.
- Default provider remains `gcs`.

### Step 11: Error Handling

Update or extend:

```text
src/services/errors/provider-errors.js
```

Needed provider-safe error codes:
- `CODESANDBOX_API_KEY_MISSING`
- `CODESANDBOX_CREATE_FAILED`
- `CODESANDBOX_NOT_FOUND`
- `CODESANDBOX_COMMAND_FAILED`
- `CODESANDBOX_DELETE_FAILED`

Expected mapping:

| Scenario | Status |
|---|---:|
| Missing API key | `500` |
| Create failed | `502` |
| Remote sandbox not found | `404` |
| Command failed | `502` |
| Delete failed | Route best-effort behavior plus warning |

Never include API keys, raw credential values, or full SDK request internals in API responses.

### Step 12: Documentation Updates

Update:

```text
README.md
ai/project-overview.md
```

Document:
- `codesandbox` provider.
- Required API key env var.
- Optional provider defaults.
- CodeSandbox is account/plan/usage-limit dependent.
- Commands use provider SDK, not SSH.
- Termination deletes the sandbox in the initial implementation.

### Step 13: Tests

Unit test targets:
- Provider factory registration.
- Missing API key validation.
- Request options and env defaults mapping.
- Session mapper with partial SDK data.
- Command execution calls resume/connect/run.
- Termination calls delete.

Integration test targets with mocked SDK:
- Create session with `provider: "codesandbox"`.
- List supported providers includes `codesandbox`.
- Get session refreshes CodeSandbox metadata.
- Run command returns normalized output.
- Delete session invokes provider cleanup.
- GCS behavior remains unchanged.
- `pwd` remains registered and unimplemented.

Manual smoke test:

```bash
curl -X POST http://localhost:3000/api/v1/sessions \
  -H "Content-Type: application/json" \
  -H "x-server-token: $SERVER_TOKEN" \
  -d '{"provider":"codesandbox","title":"lab-smoke-test"}'
```

```bash
curl -X POST http://localhost:3000/api/v1/sessions/<SESSION_ID>/command \
  -H "Content-Type: application/json" \
  -H "x-server-token: $SERVER_TOKEN" \
  -d '{"command":"pwd && node --version"}'
```

```bash
curl -X DELETE http://localhost:3000/api/v1/sessions/<SESSION_ID> \
  -H "x-server-token: $SERVER_TOKEN"
```

## 3. Environment Variables

Required:

```env
CODESANDBOX_API_KEY=...
```

Accepted alias:

```env
CSB_API_KEY=...
```

Optional:

```env
CODESANDBOX_TEMPLATE_ID=...
CODESANDBOX_DEFAULT_PRIVACY=public-hosts
CODESANDBOX_DEFAULT_VM_TIER=Nano
CODESANDBOX_HIBERNATION_TIMEOUT_SECONDS=300
```

## 4. Implementation Order

1. Install `@codesandbox/sdk`.
2. Add SDK client helper.
3. Add session mapper.
4. Add provider implementation.
5. Register provider in provider factory.
6. Add provider-specific errors.
7. Add/update tests.
8. Update README and project overview.
9. Run automated checks.
10. Run manual smoke test with a real CodeSandbox API key when available.

## 5. Open Questions

1. Should termination delete CodeSandbox sandboxes permanently, or should clients be able to choose hibernate instead?
2. Should the API expose CodeSandbox preview hosts in the normalized session response?
3. Should `templateId` be required for predictable environments, or should default sandbox creation be accepted?
4. Should CodeSandbox provider support a per-request account/workspace token later, or only server-level credentials?
