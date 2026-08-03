# LAB-008: Implementation Plan — GitHub Codespaces Provider

**Spec**: `ai/LAB-008_codespace-provider/spec.md`  
**Last Updated**: 2026-08-02

---

## Guiding Principle: Reuse First

The CodeSandbox provider is the primary reference. Its submodule structure
(`credentials-loader.js`, `client.js`, `session-mapper.js`) is directly
replicated for Codespaces under
`src/services/providers/codespaces/`.

The GCS provider is the reference for:
- `getRowValue` usage patterns
- `parseMetadata` helper (copy as-is)
- `isSessionActive` semantics (active/not-found distinction)
- `executeKeepAlive` return shape (`{ success, action, message, updates }`)

The keep-alive service (`keep-alive-service.js`) and route
(`routes/sessions.js`) are extended, not rewritten.

---

## File Map

### New files

```
src/services/providers/codespaces/
  credentials-loader.js      — token loading; mirrors codesandbox/credentials-loader.js
  client.js                  — GitHub API HTTP client (fetch-based, no SDK)
  session-mapper.js          — maps GitHub codespace object → session row shape
  cli-executor.js            — wraps `gh codespace ssh` with per-spawn GH_TOKEN env

src/services/providers/codespaces-provider.js
  — extends BaseProvider; all provider methods live here
```

### Modified files

```
src/services/provider-factory.js      — register 'codespaces' provider
src/services/credentials-lister.js   — add '.txt' to file filter
src/routes/sessions.js               — 6 targeted changes (detailed below)
src/db/db.js                         — add unique index for codespaces token
Dockerfile                           — install GitHub CLI
```

---

## 1. Dockerfile

Add GitHub CLI installation to the existing `apt-get` block, after
`openssh-client`. Pin to a specific version via the official apt repo:

```dockerfile
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 make g++ openssh-client fuse s3fs ca-certificates curl gnupg \
  && mkdir -p /usr/share/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
     | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) \
     signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
     https://cli.github.com/packages stable main" \
     | tee /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*
```

---

## 2. `src/services/providers/codespaces/credentials-loader.js`

**Reuse**: copy `codesandbox/credentials-loader.js` as the structural template.

**Differences from CodeSandbox loader**:

| Aspect | CodeSandbox | Codespaces |
|--------|-------------|------------|
| Error code prefix | `CODESANDBOX_` | `CODESPACES_` |
| Missing cred error | `CODESANDBOX_CREDENTIALS_MISSING` | `CODESPACES_NO_CREDENTIAL` |
| File parse | JSON only | JSON (`{"token": "ghp_xxx"}`) **or** plain text (`ghp_xxx`) |
| Token field | `credentialData.token` | `credentialData.token` (JSON) or trimmed string (plain text) |
| Cache key | same pattern | same pattern |

**Plain-text detection**: after reading the file buffer, attempt `JSON.parse`.
If it throws, treat the entire buffer as the raw token (trimmed). This handles
both formats with no format flag needed.

**Fingerprint**: same as CodeSandbox — `sha256:${sha256(token)}`.

**Exports**: `loadCodespacesCredentials(credentialRef)` → `{ token, credentialRef, credentialFingerprint }`.

---

## 3. `src/services/providers/codespaces/client.js`

**Reuse**: `buildS3Client` pattern from `google-credentials-loader.js` (HTTP
client builder returning a reusable instance), but for GitHub REST API.

No SDK. Uses Node.js built-in `fetch` (Node 18+, already in base image).

```javascript
const BASE_URL = 'https://api.github.com';
const API_VERSION = '2026-03-10';

// Returns headers for a given token — token is per-call, not cached globally
function githubHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION
  };
}
```

**Retry logic** (GET only, 429 responses, per NFR-2):

```javascript
async function githubGet(path, token, attempt = 1) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: githubHeaders(token) });
  if (res.status === 429 && attempt <= 3) {
    const delay = [1000, 2000, 4000][attempt - 1];
    await new Promise(r => setTimeout(r, delay));
    return githubGet(path, token, attempt + 1);
  }
  return res;
}
```

POST/DELETE use a single `githubRequest(method, path, token, body)` with no
retry — avoids duplicate side effects.

**Exported methods**:

- `createCodespace(token, params)` — `POST /user/codespaces`

  Body shape (from official docs):
  ```json
  {
    "repository_id": 1296269,
    "ref": "main",
    "machine": "basicLinux32gb",
    "geo": "UsWest",
    "idle_timeout_minutes": 30,
    "display_name": "My session",
    "retention_period_minutes": 43200
  }
  ```
  GitHub returns **201** (success) or **202** (partial failure, retrying in background).
  Both status codes return the same codespace object body — treat both as success,
  read the body and persist the session row. Poll `getCodespace` to wait for `Available`.

- `getCodespace(token, name)` — `GET /user/codespaces/{codespace_name}` → 200

- `deleteCodespace(token, name)` — `DELETE /user/codespaces/{codespace_name}` → **202 with empty body**
  Do not attempt to parse the response body. Treat 404 as already-deleted (safe to proceed).

- `startCodespace(token, name)` — `POST /user/codespaces/{codespace_name}/start` → **200** with codespace object
  The returned `state` will be `Starting`, not `Available`. After calling start,
  poll `getCodespace` until state is `Available` or until boot timeout (90s).
  Note: start requires `codespace` scope on classic PATs (v1 only uses classic PATs).

- `validateToken(token)` — `GET /user` → 200 with `{ login }` or 401/403

---

## 4. `src/services/providers/codespaces/session-mapper.js`

**Reuse**: identical structure to `codesandbox/session-mapper.js`.

Maps a GitHub codespace API object to the session row shape:

```javascript
function mapToSession(codespace, credentialRef, credentialFingerprint) {
  return {
    provider: 'codespaces',
    providerSessionId: codespace.name,           // GitHub's unique codespace name
    envName: codespace.display_name || codespace.name,
    sshCommand: `gh codespace ssh -c ${codespace.name}`,
    webHost: null,                               // always null per spec
    status: mapState(codespace.state),
    credentialRef,
    credentialFingerprint,
    metadata: {
      githubState: codespace.state,
      machine: codespace.machine?.name || null,
      cpus: codespace.machine?.cpus || null,
      memoryGB: codespace.machine
        ? Math.round(codespace.machine.memory_in_bytes / (1024 ** 3))
        : null,
      storageGB: codespace.machine
        ? Math.round(codespace.machine.storage_in_bytes / (1024 ** 3))
        : null,
      idleTimeoutMinutes: codespace.idle_timeout_minutes || null,
      retentionPeriodMinutes: codespace.retention_period_minutes || null,
      location: codespace.location || null,
      webIdeUrl: codespace.web_url || null,
      sshHost: null,
      lastUsedAt: codespace.last_used_at || null
    }
  };
}
```

**State map** (complete 17-state, per FR-5 spec):

```javascript
const STATE_MAP = {
  Available: 'RUNNING', Awaiting: 'RUNNING', Exporting: 'RUNNING',
  Starting: 'STARTING',
  ShuttingDown: 'STOPPING',
  Shutdown: 'STOPPED', Archived: 'STOPPED', Unavailable: 'STOPPED', Moved: 'STOPPED',
  Created: 'PENDING', Provisioning: 'PENDING', Queued: 'PENDING',
  Unknown: 'PENDING', Updating: 'PENDING', Rebuilding: 'PENDING',
  Failed: 'FAILED',
  Deleted: 'TERMINATED'
};

function mapState(state) {
  const mapped = STATE_MAP[state];
  if (!mapped) {
    console.warn(`[Codespaces] Unknown GitHub state: "${state}" — defaulting to PENDING`);
    return 'PENDING';
  }
  return mapped;
}
```

---

## 5. `src/services/providers/codespaces/cli-executor.js`

Wraps `gh codespace ssh` execution. Token isolation: every `execFile` call
passes `GH_TOKEN` via the `env` option — never mutates `process.env`.

**Command passing**: `command` is passed as a single string argument after `--`.
The remote shell receives and interprets it, so pipes, redirects, and other shell
metacharacters work as expected (e.g. `docker ps | grep nginx`). This is intentional
— `gh codespace ssh` forwards the argument to the remote shell.

```javascript
const { execFile } = require('child_process');

const BOOT_TIMEOUT_MS = 90_000;
const COMMAND_TIMEOUT_MS = 30_000;

async function executeInCodespace(codespaceName, command, token, options = {}) {
  const timeout = options.timeout ?? COMMAND_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      ['codespace', 'ssh', '-c', codespaceName, '--', command],
      {
        timeout,
        env: { ...process.env, GH_TOKEN: token }   // per-spawn isolation
      },
      (error, stdout, stderr) => {
        if (error) {
          if (error.killed || error.signal === 'SIGTERM') {
            return reject(Object.assign(
              new Error(`Command timed out after ${timeout}ms`),
              { code: 'CODESPACES_COMMAND_TIMEOUT' }
            ));
          }
          return reject(error);
        }
        resolve({ output: (stdout + stderr).trim() });
      }
    );
  });
}

module.exports = { executeInCodespace, BOOT_TIMEOUT_MS, COMMAND_TIMEOUT_MS };
```

---

## 6. `src/services/providers/codespaces-provider.js`

Extends `BaseProvider`. Mirrors `codesandbox-provider.js` in structure.
Reuses `parseMetadata`, `parseBoolean`, `parsePositiveInteger`,
`isNotFoundError` — copy these private helpers from the CodeSandbox provider
as-is.

### `getKeepAliveConfig(sessionRow)`

```javascript
getKeepAliveConfig(sessionRow) {
  const metadata = parseMetadata(sessionRow?.metadata);
  const keepAlive = metadata.keepAlive || {};

  // Precedence: per-session → env var → provider default (true)
  const enabled = parseBoolean(
    keepAlive.enabled ?? process.env.CODESPACES_KEEP_ALIVE_ENABLED,
    true  // provider default is enabled
  );

  if (!enabled) {
    return { enabled: false, intervalMinutes: null, strategy: 'session-disabled' };
  }

  const configuredInterval = parsePositiveInteger(
    process.env.CODESPACES_KEEP_ALIVE_INTERVAL_MINUTES,
    20
  );
  const idleTimeout = parsePositiveInteger(
    metadata.idleTimeoutMinutes ?? process.env.CODESPACES_DEFAULT_IDLE_TIMEOUT_MINUTES,
    30
  );
  // Effective interval: min(configured, idleTimeout - 10), floor at 1
  const intervalMinutes = Math.max(1, Math.min(configuredInterval, idleTimeout - 10));

  return {
    enabled: true,
    intervalMinutes,
    strategy: 'gh-cli-command',
    runOnStart: false   // per spec: do not fire immediately
  };
}
```

### `isSessionActive(sessionRow)`

Returns `true` if the remote codespace exists and is not `Deleted`.
Returns `false` only on a definitive 404 (already gone).
Throws on transient errors so the recovery service skips rather than deletes.

```javascript
async function isSessionActive(sessionRow) {
  const providerSessionId = getRowValue(sessionRow, 'providerSessionId');
  const credentialRef = getRowValue(sessionRow, 'credentialRef')
    || parseMetadata(sessionRow.metadata).credentialRef;

  if (!providerSessionId || !credentialRef) return false;

  const { token } = await loadCodespacesCredentials(credentialRef);
  try {
    const codespace = await githubClient.getCodespace(token, providerSessionId);
    return codespace.state !== 'Deleted';
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;   // transient — recovery skips this session
  }
}
```

### `createSession(options)`

Sequence:
1. Validate `machine` and `geo` enums → 400 if invalid, before any API call.
2. Load credentials → `CODESPACES_NO_CREDENTIAL` if missing.
3. Validate token → `CODESPACES_TOKEN_INVALID` / `CODESPACES_TOKEN_INSUFFICIENT_SCOPE`.
4. Fingerprint check:
   - Active session found (`RUNNING`, `STARTING`, `PENDING`, `STOPPING`) → throw `ConflictError` (`CODESPACES_ALREADY_ACTIVE`).
   - `STOPPED` session found → delete remote via `githubClient.deleteCodespace` (treat 404 as already-gone), **then** delete the DB row. The DB deletion must complete successfully before proceeding — it releases the unique index slot so the new session insert doesn't hit a constraint violation.
5. Build create params from `options`, applying env var defaults.
6. `POST /user/codespaces` → `CODESPACES_CREATION_FAILED` on error.
7. Call `mapToSession(codespace, credentialRef, credentialFingerprint)` to get the base
   session object, then inject the `keepAlive` config into `session.metadata` after
   the mapper returns (mapper builds its own metadata; keepAlive is added on top):
   `session.metadata.keepAlive = keepAliveConfig`.

**Enum validation** (before any API call):

```javascript
const VALID_MACHINES = new Set([
  'basicLinux32gb', 'standardLinux32gb', 'standardLinux',
  'premiumLinux', 'largePremiumLinux', 'xLargePremiumLinux'
]);
const VALID_GEOS = new Set(['UsEast', 'UsWest', 'EuropeWest', 'SoutheastAsia']);
```

### `refreshSession(sessionRow)`

Extracts `providerSessionId` via `getRowValue` and loads `token` from the stored
`credentialRef` via `loadCodespacesCredentials`. Then calls
`githubClient.getCodespace(token, providerSessionId)`. Returns:

```javascript
{
  status: mapState(codespace.state),
  webHost: null,
  sshCommand: `gh codespace ssh -c ${codespace.name}`,
  metadata: { ...existingMetadata, githubState: codespace.state, lastUsedAt: codespace.last_used_at }
}
```

No caching in v1 — called on every `GET /:id`.

### `executeCommand(sessionRow, command)`

Sequence:
1. Check `status` from `sessionRow`:
   - `FAILED` / `TERMINATED` → reject immediately with clear error (no credentials needed).
2. Load credentials from stored `credentialRef` → `CODESPACES_NO_CREDENTIAL` if missing.
   Credentials must be loaded before any GitHub API call including the auto-start below.
3. If `STOPPED` → call `githubClient.startCodespace(token, name)` then poll `getCodespace`
   every 3 seconds until state is `Available` (up to `BOOT_TIMEOUT_MS = 90s`) →
   `CODESPACES_START_TIMEOUT` on failure.
4. `cliExecutor.executeInCodespace(name, command, token)` with `COMMAND_TIMEOUT_MS = 30s`.
5. Return `{ output: result.output }`. No `updates` key is needed — the route does
   `result.updates || {}` so omitting it is safe. Codespaces has no SSH keys or
   sshCommand to persist back from command execution.

### `executeKeepAlive(sessionRow)`

Reuses `executeInCodespace` shape. Returns same `{ success, action, message, updates }`
shape as other providers so the keep-alive service works without changes.

```javascript
async executeKeepAlive(sessionRow) {
  const status = normalizeStatus(sessionRow.status);
  if (['STOPPED', 'STOPPING', 'TERMINATED', 'FAILED'].includes(status)) {
    // Return success:true so the keep-alive service does NOT count this as
    // a failure. A deliberate skip must never increment consecutiveFailures —
    // returning success:false would mark the session FAILED after 3 intervals
    // (keep-alive-service.js MAX_CONSECUTIVE_FAILURES).
    return { success: true, action: 'skipped', message: `Session is ${status}, keep-alive skipped`, updates: {} };
  }

  const providerSessionId = getRowValue(sessionRow, 'providerSessionId');
  const credentialRef = getRowValue(sessionRow, 'credentialRef')
    || parseMetadata(sessionRow.metadata).credentialRef;

  if (!providerSessionId || !credentialRef) {
    return { success: false, action: 'missing-session-data', message: 'Missing providerSessionId or credentialRef', updates: {} };
  }

  const { token } = await loadCodespacesCredentials(credentialRef);
  const result = await executeInCodespace(
    providerSessionId,
    'echo keep-alive',
    token,
    { timeout: BOOT_TIMEOUT_MS }  // boot-aware for sleeping codespaces
  );

  return {
    success: true,
    action: 'keep-alive-sent',
    message: result.output,
    updates: { status: 'RUNNING' }
  };
}
```

### `terminateSession(sessionRow)`

1. Extract `providerSessionId` via `getRowValue` and load `token` from stored `credentialRef` via `loadCodespacesCredentials`.
2. Call `githubClient.deleteCodespace(token, providerSessionId)`.
3. If 404 → log "already gone", return normally (safe to proceed).
4. On other errors → throw (route preserves the DB row per CodeSandbox pattern).

The DB transition (`UPDATE SET status = 'TERMINATED'`) happens in the **route**,
not here.

---

## 7. `src/services/provider-factory.js`

```javascript
const CodespacesProvider = require('./providers/codespaces-provider');

const providers = {
  gcs: new GcsProvider(),
  pwd: new PwdProvider(),
  codesandbox: new CodeSandboxProvider(),
  codespaces: new CodespacesProvider()   // ← add
};
```

---

## 8. `src/services/credentials-lister.js`

Both `listCredentialsS3` and `listCredentialsFs` currently filter for `.json`
only. Both must be updated — there are **two separate filter sites** with different
variable shapes:

```javascript
// listCredentialsS3 (around line 34) — filters on key string:
// before:
.filter((key) => key.toLowerCase().endsWith('.json'))
// after:
.filter((key) => {
  const lower = key.toLowerCase();
  return lower.endsWith('.json') || lower.endsWith('.txt');
})

// listCredentialsFs (around line 51) — filters on dirent object (entry.name):
// before:
.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
// after:
.filter((entry) => {
  const lower = entry.name.toLowerCase();
  return entry.isFile() && (lower.endsWith('.json') || lower.endsWith('.txt'));
})
```

---

## 9. `src/db/db.js`

After the existing `idx_sessions_codesandbox_active_token` index creation, add:

```javascript
// Deduplicate check (same pattern as CodeSandbox)
const duplicateCodespacesSessions = await all(`
  SELECT credentialFingerprint, COUNT(*) AS activeCount,
         ARRAY_AGG(id ORDER BY createdAt DESC, id DESC) AS sessionIds
  FROM sessions
  WHERE provider = 'codespaces'
    AND credentialFingerprint IS NOT NULL
    AND COALESCE(status, '') NOT IN ('TERMINATED', 'FAILED')
  GROUP BY credentialFingerprint
  HAVING COUNT(*) > 1
`);

if (duplicateCodespacesSessions.length > 0) {
  throw new Error(
    `Cannot create Codespaces token uniqueness index while duplicate non-terminal sessions exist. ` +
    `Terminate older duplicates first.`
  );
}

await run(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_codespaces_active_token
  ON sessions (credentialFingerprint)
  WHERE provider = 'codespaces'
    AND credentialFingerprint IS NOT NULL
    AND COALESCE(status, '') NOT IN ('TERMINATED', 'FAILED')
`);
```

---

## 10. `src/routes/sessions.js`

Six targeted changes — existing behavior for all other providers is untouched.

### 10-A: Credential ref extraction (create route)

Add alongside the existing `getCodeSandboxCredentialRef`:

```javascript
function getCodespacesCredentialRef(req) {
  return req.headers['x-codespaces-credentials'] || req.body?.credentialRef || null;
}

function requireCodespacesCredentialRef(req) {
  const ref = getCodespacesCredentialRef(req);
  if (!ref) throw new ProviderError(
    'Codespaces credential reference required in x-codespaces-credentials or credentialRef',
    { code: 'CODESPACES_NO_CREDENTIAL', statusCode: 401 }
  );
  return ref;
}
```

In the `POST /` handler, add a branch:

```javascript
} else if (providerName === 'codespaces') {
  credentialRef = requireCodespacesCredentialRef(req);
}
```

**Note on `dockerHost` in create response**: the existing handler always includes
`dockerHost: created.metadata?.dockerHost || null`. For Codespaces this is always
`null` and is harmless. The spec documents the minimal shape `{ id, provider,
providerSessionId, status }` but the `dockerHost: null` field will still be present
in the response — this is acceptable and requires no route change.

### 10-B: `GET /codespaces-credentials`

Add after the existing `codesandbox-credentials` route — identical pattern:

```javascript
router.get('/codespaces-credentials', async (req, res) => {
  try {
    const result = await listAvailableCredentials('codespaces');
    return res.json(result);
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to list credentials');
  }
});
```

### 10-C: `GET /` — add `?provider=` filter

```javascript
router.get('/', async (req, res) => {
  const { status, provider } = req.query;
  const conditions = [];
  const params = [];

  if (status)   { conditions.push('status = ?');   params.push(status); }
  if (provider) { conditions.push('provider = ?'); params.push(provider); }

  const sql = conditions.length
    ? `SELECT * FROM sessions WHERE ${conditions.join(' AND ')}`
    : 'SELECT * FROM sessions';

  // ... rest unchanged
});
```

### 10-D: `DELETE /:id` — per-provider branching

After `await provider.terminateSession(row)` succeeds:

```javascript
if (row.provider === 'codespaces') {
  await db.run("UPDATE sessions SET status = 'TERMINATED' WHERE id = ?", [row.id]);
} else {
  await db.run('DELETE FROM sessions WHERE id = ?', [row.id]);
}
```

### 10-E: `POST /terminate-all` — per-provider branching

Same pattern inside the loop:

```javascript
if (row.provider === 'codespaces') {
  await db.run("UPDATE sessions SET status = 'TERMINATED' WHERE id = ?", [row.id]);
  result.deleted = true;
} else {
  await db.run('DELETE FROM sessions WHERE id = ?', [row.id]);
  result.deleted = true;
}
```

### 10-F: `GET /:id` — no change needed for Codespaces

The existing `provider.refreshSession(row)` call and DB update work as-is.
No credential header check is needed because Codespaces loads its token from
the stored `credentialRef` column, not from request headers.

---

## 11. `src/services/keep-alive-service.js`

One targeted change to `recoverKeepAlivesOnStartup`:

Add a status pre-check before the `isSessionActive` call:

```javascript
// STOPPED rows are always preserved — skip isSessionActive entirely
const PRESERVED_STATUSES = new Set(['STOPPED']);
if (PRESERVED_STATUSES.has(normalizeStatus(sessionRow.status))) {
  summary.skipped += 1;
  continue;
}

// Only call isSessionActive for non-terminal active states
if (typeof provider.isSessionActive === 'function') {
  // ... existing logic unchanged
}
```

No other changes to the keep-alive service. The existing `runOnStart` flag,
`MAX_CONSECUTIVE_FAILURES`, and stats handling all work for Codespaces without
modification.

---

## Reuse Summary

| Existing component | Reused by Codespaces | How |
|---|---|---|
| `codesandbox/credentials-loader.js` | `codespaces/credentials-loader.js` | Structural template; adapted for plain-text + new error codes |
| `codesandbox/session-mapper.js` | `codespaces/session-mapper.js` | Structural template; different field mapping |
| `codesandbox/client.js` (pattern) | `codespaces/client.js` | Pattern only; GitHub REST replaces CodeSandbox SDK |
| `BaseProvider` interface | `CodespacesProvider` | All 5 methods + 2 helpers implemented |
| `keep-alive-service.js` | unchanged | Works with `runOnStart: false` + new skip logic |
| `credentials-lister.js` | modified | `.txt` filter added |
| `provider-errors.js` | `CodespacesProvider` | `ProviderError`, `ConflictError`, `InvalidCredentialsError` reused as-is |
| `getRowValue` helper | `CodespacesProvider` | Imported from `utils/helpers.js` |
| `parseMetadata`, `parseBoolean`, `parsePositiveInteger` | `CodespacesProvider` | Copied from `codesandbox-provider.js` (private helpers) |
| `isNotFoundError` | `CodespacesProvider` | Copied from `codesandbox-provider.js` |
| Route `mapErrorToHttp` | Route changes | Unchanged, handles `ProviderError` automatically |

---

## Key Decisions Captured

- **No global `GH_TOKEN`**: always passed per `execFile` spawn via `env` option.
- **No state cache in v1**: `refreshSession` hits GitHub API on every call.
- **`runOnStart: false`**: keep-alive never fires immediately on creation or recovery.
- **`STOPPED` sessions preserved on restart**: status pre-check in recovery before `isSessionActive`.
- **Delete ordering**: GitHub API first, DB row second, in all three paths (delete, terminate-all, recovery cleanup).
- **`TERMINATED` rows kept**: route does `UPDATE` not `DELETE` for `codespaces`; `FAILED` rows are not kept.
- **Retry on GET only**: 1s→2s→4s, max 3 attempts, in `client.js`; no retry on POST/DELETE.
- **`STOPPED` on create**: delete remote codespace via API first, then delete DB row, then create fresh.
