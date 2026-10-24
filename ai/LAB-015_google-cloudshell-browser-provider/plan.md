# LAB-015: Implementation Plan — Google Cloud Shell Browser-Session Provider

**Spec**: `ai/LAB-015_google-cloudshell-browser-provider/spec.md`
**Research**: `ai/LAB-14_google-cloudshell/research.md`
**Prototype**: `scripts/cloudshell/cloudshell.py`
**Last Updated**: 2026-10-24

---

## Guiding Principle: Port the Proven Prototype, Don't Rediscover

`scripts/cloudshell/cloudshell.py` already implements the full working flow
(validate → XSRF → setupsession → relay_login → websocket bridge → `ssh` as the
account name). This plan ports that logic into Node behind the `BaseProvider`
interface, following the Codespaces provider's module layout. The **order of
implementation matters**: get the raw transport working against the live account
first (probe scripts), then wrap it in the provider, then wire routes/DB/keep-alive.
Never touch the existing `gcs` provider.

---

## File Map

### New files

```
src/services/providers/gcsbrowser/
  credentials-loader.js   — storageState loader + fingerprint (DB-first, vps table)
  web-client.js           — shell.cloud.google.com RPC (XSRF, ca, environments, setupsession, jwt/login)
  relay.js                — websocket bridge (ws package) + local TCP listener + ProxyCommand
  state.js                — private SSH key + temp cookie/access-token files (0700), lazy refresh

src/services/providers/gcsbrowser-provider.js
  — extends BaseProvider; all provider methods live here

scripts/cloudshell/  (already exists)
  proxycmd.py  — reused unchanged as the ssh ProxyCommand shim
```

### Modified files

```
src/services/provider-factory.js      — register 'gcsbrowser'
src/services/credentials-lister.js   — no change needed if 'gcsbrowser' maps to a folder it already scans; else add
src/services/vps-credential-utils.js — add 'gcsbrowser' to SUPPORTED_PROVIDERS + validation/fingerprint
src/db/db.js                         — add unique index for gcsbrowser token
src/routes/sessions.js               — 4 targeted changes (detailed below)
src/services/vps-credentials-routes.js (or wherever available-credential lives) — add provider to strategy
scripts/seed-credentials.js          — add folder mapping `gcsbrowser/` → 'gcsbrowser'
package.json                         — add `ws` (pinned)
src/services/keep-alive-service.js   — no change needed (STOPPED-skip already generic)
```

---

## 1. Dependency: `ws`

Add the WebSocket client. Node has no stdlib WS client, and the relay handshake is
RFC6455. `ws` is the standard, tiny, battle-tested package.

```bash
npm install ws@^8
```

Alternative (rejected for v1, recorded): hand-roll RFC6455 over `net`/`tls` — the
prototype proves it's ~120 lines, but `ws` is less code, handles ping/pong/masking
edge cases, and is already in most production trees.

The Dockerfile already ships `python3` + `openssh-client`; **no system packages
change**.

---

## 2. `src/services/providers/gcsbrowser/web-client.js`

Port of `cloudshell.py`'s `CloudShell` HTTP surface. Node global `fetch` (Node 20).

```javascript
class CloudShellWebClient {
  constructor({ cookieJar, stateDir, timeoutMs = 45000 }) {}

  // -- cookie store -----------------------------------------------------
  // Port CookieStore from cloudshell.py: RFC6265-ish domain/path/secure match,
  // header_for(url), update_from_headers(Set-Cookie). Manual redirect loop is
  // CRITICAL: urllib/undici's automatic redirect handler DROPS the Cookie header
  // on rebuild, which breaks Google's 302 chains (LAB-14 §5.1a).

  async request(url, { method='GET', body, followRedirects=true }) {}
  //   - builds headers: UA, referer=shell.cloud.google.com/, origin, x-requested-with
  //   - manual redirect loop (max 8 hops), re-reads cookies per hop, feeds Set-Cookie back

  // -- RPC --------------------------------------------------------------
  async xsrf()                // GET /newtoken?authuser=0 (follow) → regex token
  async eligibility()         // GET /cloudshell/ca (follow) → 200+[] = allowed
  async getEnvironment()      // GET /cloudshell/environments/get?request=["users/me/environments/default"]
  async listEnvironments()    // GET /cloudshell/environments/list?request=["users/me"]
  async setupsession({ envId, sshPublicKeyBlob })
  //   POST /cloudshell/setupsession  body=[null,null,[2,blob],["default"]]
  //   field 4 = env **id** ('default'), NOT the resource path (400 otherwise)
  //   field 3 = [enum, base64 SSH wire blob] — NOT PEM text
  //   handles [null,null,<code>] rejection (code 7 = quota/limit/region)
  async relayLogin({ accessToken, targetHost, environmentName })
  //   GET ssh.cloud.google.com/cloudshell/jwt?redirect_uri=...&state=<b64>
  //   parse window.location from HTML → unescape JS escapes (\x26 = '&')
  //   GET the login URL WITHOUT following redirects → Set-Cookie: CloudShellAuthorization
  async abandon()             // POST /cloudshell/devshell/abandon body=[null]
}
```

Key implementation notes (from LAB-14):

- **XSSI guard**: every response body starts `)]}'` — strip before `JSON.parse`.
- **`environments/get` returns the env array flat**; `setupsession` nests it at
  `[3]`. Accept both.
- **Field 7** of the environment is the `authorized_keys`-style array — the
  registered key lands there (LAB-14 §8.1), and it persists across sessions.
- **State mapping**: `state 1`=STOPPED, `2`=STARTING, `3`=RUNNING.

---

## 3. `src/services/providers/gcsbrowser/relay.js`

Port of the `RelayBridge` + `ws_connect` from `cloudshell.py`, using `ws`.

```javascript
const WebSocket = require('ws');

// Open wss://970-<host>/_cloudshell/tcp/22?_cloudshellAccessToken=<token>
// with headers: Origin: https://shell.cloud.google.com, Cookie: <CloudShellAuthorization>
// 503 in handshake => missing/invalid auth cookie => call relayLogin again and retry.
function connectRelay({ relayHost, accessToken, authCookie }) {}

// Single-connection local TCP listener (127.0.0.1:0) that pipes to the websocket:
//   tcp ←→ ws binary frames (opcode 0x2), ping → pong (0x9 → 0xA)
class RelayBridge {
  async listen();          // returns local port
  async serveOnce();       // accepts ONE ssh connection, bridges both directions
  async close();
}
```

The `ssh` command uses `ProxyCommand`:

```
ssh -o "ProxyCommand=python3 -I <repo>/scripts/cloudshell/proxycmd.py <port>" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o IdentitiesOnly=yes -o BatchMode=yes -o LogLevel=ERROR \
    -i <privateKey> <sshUser>@<host> <command...>
```

- **Username**: `sshUser` from `environments/get` field 4 — the **account name**
  (e.g. `etecnologysys`). `cloudshelluser` gets `Permission denied` (LAB-14 §8).
- **Host**: bare `cs-…cloudshell.dev` for the `ssh` target; the **`970-`-prefixed**
  host for the websocket.
- One bridge per SSH invocation (single-connection); tear down in `finally`.

---

## 4. `src/services/providers/gcsbrowser/state.js`

Owns the persistent, per-credential artifacts:

| Path (under `GCSBROWSER_STATE_DIR/<fingerprint>/`) | Contents | Sensitivity |
|---|---|---|
| `id_ecdsa`, `id_ecdsa.pub` | SSH keypair generated **once per credential** | private key = command exec |
| `cookies.json` | the **minimized** storageState (23 cookies, no `origins`; written from `credentialcontent` by the loader, 0600) | live session |

- Generated keypair is registered at `setupsession`; it **persists in the
  environment's key array across sessions** (LAB-14 §8.1), so subsequent sessions
  reuse it without re-registering.
- `_cloudshellAccessToken` / `CloudShellAuthorization` are **NOT written here** as
  durable state — they live in memory (and optionally `metadata` as a throwaway)
  and are refreshed lazily on every operation (`ensureRelayAuth()`).
- Everything `0700`/`0600`.

---

## 5. `src/services/providers/gcsbrowser/credentials-loader.js`

Mirror `codespaces/credentials-loader.js` (DB-first via `vps`), adapted for
storageState JSON.

```javascript
// loadGcsBrowserCredentials(credentialRef) → { cookiePath, cookieJar, credentialRef, credentialFingerprint }
//   1. db-credentials-loader.loadCredentialByRef('gcsbrowser', ref)
//      → { credentialContent, credentialFingerprint }  (throws VPS_NOT_FOUND if absent)
//   2. MINIMIZE the storageState to only the cookies the Cloud Shell flow uses:
//        keep  domain in ('.google.com', 'accounts.google.com')   → 23 cookies (17+6)
//        drop  '.youtube.com' (11), '.google.com.bo' (10), 'myaccount.google.com' (3),
//              'ogs.google.com' (1), 'www.google.com' (1)          → 26 dropped
//        drop  the entire 'origins' array (localStorage is not used by the shell host)
//      VERIFIED 2026-10-24 end-to-end: the 23-cookie minimized set cold-starts the VM
//      (STOPPED → setupsession → RUNNING) and runs commands over the relay.
//      NOTE: '.google.com' ALONE (17) passes myaccount/XSRF but FAILS environments/list
//      (302 → sign-in); the 6 'accounts.google.com' cookies (SID/HSID/SSID/APISID/
//      SAPISID/__Host-GAPS) are required for the shell RPC.
//   3. write minimized credential to stateDir/<fingerprint>/cookies.json (0600)
//   4. validate shape: { cookies: [..] }, cookies non-empty, has SID/__Secure-1PSID
//   5. fingerprint = sha256 of canonicalized JSON of the MINIMIZED cookie set
//      (stable across whitespace; distinct from the raw-file fingerprint — intentional)
```

- **No global env mutation** — unlike `google-credentials-loader.js`, this loader
  never sets `GOOGLE_APPLICATION_CREDENTIALS`.
- **Store only what is used.** The source `google.json` carries 49 cookies across 8
  domains (plus `origins`); the Cloud Shell flow uses 23 of them on 2 domains, and
  none of the `origins`. The credential content persisted in `vps` is the minimized
  form — 23 cookies, no `origins` — never the raw file. This halves what's stored,
  drops all YouTube/regional/account-page session data from the database, and keeps
  the `vps` row to the exact surface the provider exercises.
- Fingerprint uniqueness → one active session per credential via the DB index.
- 5-minute TTL cache like `db-credentials-loader.js`; invalidate on VPS write.

---

## 6. `src/services/providers/gcsbrowser-provider.js`

The provider. Implements all `BaseProvider` methods. Module layout mirrors
`codespaces-provider.js` (provider + `getKeepAliveConfig` + helpers).

### `getKeepAliveConfig(sessionRow)`
```javascript
{
  enabled: resolveBool(metadata.keepAlive?.enabled, envBool(GCSBROWSER_KEEP_ALIVE_ENABLED, true)),
  intervalMinutes: min(
    resolveInt(envInt(GCSBROWSER_KEEP_ALIVE_INTERVAL_MINUTES, 10)),
    (metadata.idleTimeoutMinutes ?? envInt(GCSBROWSER_DEFAULT_IDLE_TIMEOUT_MINUTES, 20)) - 10
  ),  // floored at 1
  strategy: 'relay-command',
  runOnStart: false
}
```

### `getCredentialStatus(loaded)`
Reuse the `gcs-provider.js` shape (weekly 50h quota, 5GB storage, 12h session cap,
40min non-interactive cap as `referenceLimits`), but validate by calling
`webClient.getEnvironment()` with the storageState instead of `googleapis`.
Map: 200 → `AVAILABLE`; 302/401 feed → `EXPIRED`; malformed → `INVALID`;
403 → `UNAVAILABLE`.

### `isSessionActive(sessionRow)`
```javascript
const env = await webClient.getEnvironment();
return ['RUNNING','STARTING','PENDING'].includes(env.stateName);
// NOT_FOUND → false (mirrors gcs-provider)
```

### `createSession(options)`
```javascript
const { cookieJar, credentialRef, credentialFingerprint } = await loadGcsBrowserCredentials(options.credentialRef);
const web = new CloudShellWebClient({ cookieJar, stateDir });
await web.eligibility();                    // 403 → GCSBROWSER_NOT_ELIGIBLE
const env = await web.getEnvironment();     // absent → GCSBROWSER_NOT_FOUND
const key = await state.ensureKey(fingerprint);   // generate once, 0600
if (env.state !== RUNNING) await web.setupsession({ envId:'default', sshPublicKeyBlob: key.pubBlob });
env2 = await pollUntilRunning(web, BOOT_TIMEOUT);  // 3s interval, 90s cap → GCSBROWSER_START_TIMEOUT
return {
  provider: 'gcsbrowser',
  providerSessionId: env2.host,             // cs-…cloudshell.dev
  envName: 'default',
  status: 'RUNNING',
  privateKey: key.privateKey,               // stored in row for reuse
  publicKey: key.publicKey,
  metadata: { ...env2, credentialRef, accessToken: THROWAWAY (for immediate use), webHost: editorUrl }
};
```

### `refreshSession(sessionRow)`
```javascript
const env = await webClient.getEnvironment();
return {
  status: env.stateName,
  webHost: env.editorUrl,
  sshCommand: `ssh ${env.sshUser}@${env.host}`,
  metadata: { ...existing, ...env, accessToken: refreshForThisRequestOnly() }
};
```

### `executeCommand(sessionRow, command)`
```javascript
// 1. env = getEnvironment(); if STOPPED → setupsession + poll RUNNING (auto-wake)
//    FAILED/TERMINATED → throw
// 2. accessToken = setupsession(envId, keyBlob).accessToken   // fresh, each time
// 3. authCookie  = relayLogin(accessToken, relayHost)          // fresh, each time
// 4. bridge = new RelayBridge(); port = await bridge.listen()
// 5. spawn ssh with ProxyCommand=proxycmd.py <port>, IdentitiesOnly, BatchMode
//    user = env.sshUser, host = env.host
//    capture stdout+stderr, exit code
// 6. close bridge in finally
// 503 during bridge connect → re-run relayLogin, retry once, else GCSBROWSER_RELAY_FAILED
return { output, updates: { status:'RUNNING' } };
```

### `executeKeepAlive(sessionRow)`
```javascript
// status = getEnvironment()
// STOPPED / STOPPING / TERMINATED / FAILED → { success:true, action:'skip', … } (deliberate skip)
// not RUNNING → { success:false, action:'wait', … }
// else → executeCommand(sessionRow, 'echo "keep-alive $(date)"') via relay
//   success → { success:true, action:'keep-alive-sent', updates:{ status:'RUNNING' } }
//   failure → { success:false, action:'error', error }
```

### `terminateSession(sessionRow)`
```javascript
// 1. webClient.abandon()  (POST /devshell/abandon)  — best-effort; log warn on failure
// 2. return (route hard-deletes the row, like 'gcs')
```

---

## 7. `src/services/provider-factory.js`

```javascript
const GcsBrowserProvider = require('./providers/gcsbrowser-provider');
const providers = {
  gcs: new GcsProvider(),
  gcsbrowser: new GcsBrowserProvider(),
  pwd: new PwdProvider(),
  codesandbox: new CodeSandboxProvider(),
  codespaces: new CodespacesProvider()
};
```

`normalizeProviderName` already defaults to `gcs`; `gcsbrowser` is a distinct key.

---

## 8. `src/services/vps-credential-utils.js`

- Add `'gcsbrowser'` to `SUPPORTED_PROVIDERS`.
- Add `_validateGcsBrowserContent(credentialContent)`:
  - must parse as JSON object
  - must have non-empty `cookies` array and `origins` array
  - must contain at least one of `SID` / `__Secure-1PSID` in `cookies`
  - fingerprint = `sha256:${sha256(JSON.stringify(parsed))}`
  - errors → `GCSBROWSER_CREDENTIALS_INVALID` (400)

---

## 9. `src/db/db.js`

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_gcsbrowser_active_token
ON sessions (credentialFingerprint)
WHERE provider = 'gcsbrowser'
  AND credentialFingerprint IS NOT NULL
  AND COALESCE(status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED');
```

(Placed next to the codesandbox/codespaces index block. Bootstrap refuses creation if
duplicate non-terminal rows exist — same guard as Codespaces.)

---

## 10. `src/routes/sessions.js`

### 10-A: Credential ref extraction (create route)

```javascript
function getGcsBrowserCredentialRef(req) {
  return req.headers['x-gcsbrowser-credentials'] || req.body?.credentialRef || null;
}
function requireGcsBrowserCredentialRef(req) {
  const ref = getGcsBrowserCredentialRef(req);
  if (!ref) throw new ProviderError('…', { code:'GCSBROWSER_NO_CREDENTIAL', statusCode:400 });
  return ref;
}
// in POST '/': add branch  else if (providerName === 'gcsbrowser') { credentialRef = requireGcsBrowserCredentialRef(req); }
```

### 10-B: `GET /gcsbrowser-credentials`

```javascript
router.get('/gcsbrowser-credentials', async (req,res) => {
  const result = await listAvailableCredentials('gcsbrowser');
  return res.json(result);
});
```

### 10-C: DB unique-violation handling

Extend the `dbError.code === '23505'` branch: include `gcsbrowser` in the
`(providerName === 'codesandbox' || providerName === 'codespaces' || providerName === 'gcsbrowser')`
guards so a second active session for the same fingerprint resumes the existing one
(or returns 409 per the spec).

### 10-D: `GET /:id`, `POST /:id/command`, `DELETE /:id`, `terminate-all`

`requireGoogleCredentialRefForRequest` is only invoked for `row.provider === 'gcs'`.
Add the analogous `gcsbrowser` branch where the row's stored `credentialRef` is
used if present (rows already carry `credentialRef`), else require the header —
mirroring the Codespaces pattern (which does **not** require a header on
`terminate-all`; it loads from the row). Keep the existing hard-delete behavior for
`gcsbrowser` in `DELETE` and `terminate-all` (no `TERMINATED` row retention).

---

## 11. VPS integration (`available-credential`)

Add `gcsbrowser` to the registry-aware strategy in the VPS routes module:
- strategy `first-available` (like gcs/codesandbox)
- reuse the session-key exclusion (any credential backing a non-terminal session is
  skipped) — works generically via `credentialRef` match
- `getCredentialStatus` path from §6 feeds the `status` column

---

## 12. `scripts/seed-credentials.js`

Add to `FOLDER_TO_PROVIDER`:

```javascript
gcsbrowser: 'gcsbrowser',
```

Seed the LAB-14 credential with:

```bash
mkdir -p credentials/gcsbrowser/etecnologysys
# Seed the MINIMIZED storageState (23 cookies, no origins) — run through the provider's
# minimization (or a small helper) BEFORE registering, so vps never stores the raw 49-cookie
# file. The raw google.json contains YouTube/regional/account-page session data the provider
# never sends.
node scripts/seed-credentials.js --base-dir credentials --token <SERVER_TOKEN> --url http://localhost:3000
```

---

## 13. `src/services/keep-alive-service.js`

No change. The existing `STOPPED`-skip in `recoverKeepAlivesOnStartup` and the
`runOnStart`/`MAX_CONSECUTIVE_FAILURES` logic are provider-agnostic.

---

## 14. `.env.example` / documentation

Add to `.env.example` (and scripts/README or provider README):

```bash
GCSBROWSER_KEEP_ALIVE_ENABLED=true
GCSBROWSER_KEEP_ALIVE_INTERVAL_MINUTES=10
GCSBROWSER_DEFAULT_IDLE_TIMEOUT_MINUTES=20
GCSBROWSER_BOOT_TIMEOUT_SECONDS=90
GCSBROWSER_COMMAND_TIMEOUT_SECONDS=30
GCSBROWSER_STATE_DIR=/tmp/gcsbrowser-state
```

Update `project-overview.md` provider table and the `scripts/README.md` cloudshell
row to mention the provider.

---

## Implementation Order (gated)

| Step | Deliverable | Gate / test |
|---|---|---|
| 1 | `web-client.js` + cookie store + manual redirect | probe: `list` / `status` against live account, XSRF length logged, no tokens printed |
| 2 | `relay.js` + `state.js` keypair | probe: `exec 'echo hi'` through relay against live VM |
| 3 | `credentials-loader.js` + `vps-credential-utils` + index + `seed-credentials` | seed LAB-14 credential → `POST /api/v1/sessions {provider:'gcsbrowser'}` → RUNNING (**the commit gate**) |
| 4 | `gcsbrowser-provider.js` full methods | `GET /:id`, `command` (incl. auto-wake), `DELETE` |
| 5 | routes (10-A..10-D) + factory + lister | `POST /`, `GET /gcsbrowser-credentials`, `terminate-all`, `?provider=` filter |
| 6 | keep-alive + VPS status + available-credential | idle-window survival test; `available-credential?provider=gcsbrowser` |
| 7 | `abandon` teardown verification | create → delete → `environments/get` state 1 (closes LAB-14 §11 gap) |
| 8 | docs + `.env.example` | README/provider table updated |

---

## Reuse Summary

| Existing component | Reused by gcsbrowser | How |
|---|---|---|
| `scripts/cloudshell/cloudshell.py` | provider | Logic port (cookie store, RPC, relay, key semantics) |
| `scripts/cloudshell/proxycmd.py` | provider | Used unchanged as ssh ProxyCommand |
| `codespaces/credentials-loader.js` | `gcsbrowser/credentials-loader.js` | Structural template (DB-first, vps, fingerprint, TTL) |
| `gcs-provider.js` | `gcsbrowser-provider.js` | `getCredentialStatus` limits shape, `isSessionActive` not-found semantics |
| `vps-credential-utils.js` | validation/fingerprint | Add provider + `_validateGcsBrowserContent` |
| `keep-alive-service.js` | unchanged | STOPPED-skip + runOnStart already generic |
| `routes/sessions.js` | extended | 4 targeted additions, existing hard-delete for gcsbrowser |
| `seed-credentials.js` | extended | add folder mapping |

---

## Key Decisions Captured

- **New provider `gcsbrowser`, not a rewrite of `gcs`** — the service-account flow,
  the `vps` GCS records, and the legacy direct-SSH path stay intact; the two are
  different auth models.
- **`ws` dependency added** (v8, pinned) — only new npm package.
- **No global env mutation** — storageState handled per-request; no
  `GOOGLE_APPLICATION_CREDENTIALS` (unlike legacy GCS).
- **Credential minimization (verified)**: persist only the 23 cookies on
  `.google.com` + `accounts.google.com`, and drop `origins`. Full storageState is
  49 cookies / 8 domains + `origins`; 26 cookies (YouTube, `.google.com.bo`,
  myaccount, ogs, www) and all `origins` are never sent. Verified end-to-end on
  2026-10-24: minimized set cold-starts a STOPPED VM and runs commands over the
  relay. **`.google.com` alone is insufficient** — `environments/list` 302s to
  sign-in without the 6 `accounts.google.com` cookies.
- **Short-lived tokens refreshed lazily on every operation** — never durable.
- **Key generated once per credential, registered at setupsession, private key in
  session row** — re-registration only on auth failure.
- **`runOnStart: false`**, interval `min(10, idle−10)`, strategy `relay-command`.
- **`abandon` is the terminate path** (untested in LAB-14 — this feature tests it);
  hard-delete the row, best-effort.
- **Account-name SSH user** — read from env field 4, never `cloudshelluser`.
- **Manual redirect following** — undici auto-redirect drops the Cookie header.
- **Commit gate = step 3**: nothing is committed until a real `POST /sessions`
  returns RUNNING with the seeded (minimized) credential.
