# LAB-009: Implementation Plan — GCS Credential Status

**Spec**: `ai/LAB-009_provider-credential-status/spec.md` (§10.1)
**Research**: `research.md` (§5.1)
**Shared infra**: `plan-shared.md` — read first for envelope, cache, precedence
**Last Updated**: 2026-08-21

---

## Guiding Principle

GCS is the weakest data source of the three providers: the Cloud Shell REST API
can prove **credential validity** but exposes no used/remaining weekly-quota
field. The checker's job is therefore: validate hard, report quota honestly as
`usage: null` with a limitation, and never start an environment.

## File Map

### Modified files

```
src/services/gcs-service.js            — add getEnvironmentAccess() (read-only; no start)
src/services/providers/gcs-provider.js — add getCredentialStatus(loaded)
```

No new modules — this provider has no subfolder and stays flat.
No DB or route changes beyond the shared plan.

---

## 1. Official API surface used

Confirmed from `https://cloud.google.com/shell/docs/reference/rest/v1/users.environments`:

**`GET https://cloudshell.googleapis.com/v1/{name=users/*/environments/*}`**  
→ returns an `Environment` resource with fields:
`name`, `id`, `dockerImage`, `state` (enum), `webHost`, `sshUsername`,
`sshHost`, `sshPort`, `publicKeys[]`

No quota, no billing, no remaining-hours field anywhere in this resource.
The weekly quota is documented only in the Cloud Shell UI.

**Official `State` enum** (confirmed from the REST reference):

| Value | Meaning |
|---|---|
| `STATE_UNSPECIFIED` | Unknown state |
| `SUSPENDED` | Environment not running; can be started |
| `PENDING` | Starting, not yet ready |
| `RUNNING` | Running and accepting connections |
| `DELETING` | Being deleted |

These are the only possible values returned by `environments.get`.

---

## 2. `gcs-service.js` — new read-only function

Reuses the existing private helpers `getAuthClient` and `getEnvironmentName`
already used by `getCloudShellStatus`. The call is
`cloudshell.users.environments.get` — it does **not** wake a suspended
environment and consumes no quota.

```javascript
/**
 * Low-impact credential/environment probe.
 * Returns { envName, state } when an environment exists; throws on auth or API errors.
 * State is the raw GCS enum: 'STATE_UNSPECIFIED' | 'SUSPENDED' | 'PENDING' |
 *   'RUNNING' | 'DELETING'
 * Never calls environments.start().
 */
async function getEnvironmentAccess(options = {}) {
  const auth = await getAuthClient(options.credentialsPath);

  // getEnvironmentName signature: (auth, credentialsPath?)
  // auth is the primary source; credentialsPath used as a fallback only
  // when auth has no client_email. Always pass auth as the first arg.
  const name = await getEnvironmentName(auth, options.credentialsPath);

  const res = await cloudshell.users.environments.get({ name, auth });
  //                 ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  // IMPORTANT: the existing gcs-service.js module uses:
  //   const { google } = require('googleapis');
  //   const cloudshell = google.cloudshell('v1');
  // The correct call is cloudshell.users.environments.get(...)
  // NOT cloudshellClient.projects.locations.environments.get(...)
  // which does not exist in the googleapis Node.js client.

  return { envName: name, state: res.data.state };
}
```

Export alongside existing functions in `module.exports`.

The function does **not** wrap the API call in try/catch — errors propagate
to `getCredentialStatus` where they are classified by `mapGoogleError`.

---

## 3. `gcs-provider.js` — `getCredentialStatus(loaded)`

`loaded` comes from the shared dispatcher: `{ credentialRef, credentialsPath }`
resolved via `initGoogleCredentialsFromS3IfNeeded`, which already validates
that the file exists and parses as valid JSON.

```javascript
async getCredentialStatus(loaded) {
  const limitations = [];
  const quotas = [
    quotaEntry({
      quotaUnit: 'hours', quotaPeriod: 'week',
      usage: null, limit: 50, remaining: null
    })
  ];
  limitations.push(limitation(
    'quotas[0].usage',
    'Cloud Shell documents the 50-hour weekly quota in the UI only. ' +
    'The Cloud Shell REST API (users.environments resource) contains no ' +
    'used-hours or remaining-hours field; this value cannot be determined programmatically.'
  ));

  let accessResult;
  try {
    accessResult = await gcsService.getEnvironmentAccess({
      credentialsPath: loaded.credentialsPath
    });
  } catch (error) {
    const mapped = mapGoogleError(error);
    return {
      ...mapped,
      quotas,
      limitations: [...limitations, ...(mapped.limitations || [])],
      validated: false
    };
  }

  // 404 is handled inside mapGoogleError (returns AVAILABLE + providerState note)
  // All other successful states mean the credential works.
  const providerState = accessResult.state;  // raw GCS State enum value

  return {
    status: 'AVAILABLE',
    validated: true,
    quotas,
    limitations,
    expiresAt: null,  // service-account JSON keys have no embedded expiry
    details: {
      referenceLimits: {
        weeklyHoursDefault:    50,  // documented default weekly quota
        storageLimitGb:         5,  // 5 GB persistent $HOME disk
        sessionCapHours:       12,  // single session cap
        nonInteractiveCapMins: 40   // non-interactive session cap
      },
      providerState  // e.g. 'RUNNING', 'SUSPENDED', 'PENDING'
    }
  };
}
```

---

## 4. `mapGoogleError(error)` — new private helper in `gcs-provider.js`

The `googleapis` Node.js client wraps HTTP errors as `GaxiosError`. The
relevant detection patterns, in priority order:

```javascript
/**
 * Map a googleapis/google-auth-library error to a credential status result.
 * Returns { status, limitations?, details? } — never throws.
 *
 * Error shapes from googleapis:
 *   - GaxiosError: error.response.status (HTTP code),
 *                  error.response.data.error or data.error.status
 *   - google-auth-library TokenError: error.message contains
 *     'invalid_grant', 'Invalid JWT', etc.
 */
function mapGoogleError(error) {
  const msg     = (error.message || '').toLowerCase();
  const status  = error.response?.status;
  const errData = error.response?.data;
  const errCode = (errData?.error?.status || errData?.error || '').toString().toLowerCase();

  // --- Auth / credential errors -------------------------------------------

  // Expired or revoked OAuth grant. google-auth-library surfaces these as
  // TokenError with these substrings before even making the Cloud Shell call.
  if (msg.includes('invalid_grant') || msg.includes('invalid jwt') ||
      msg.includes('token has been expired or revoked')) {
    return {
      status: 'EXPIRED',
      limitations: [{
        field: 'status',
        reason: 'Google auth token or service-account key is expired or revoked and cannot be refreshed automatically.'
      }]
    };
  }

  // 401 — authentication failed outright
  if (status === 401 || msg.includes('invalid_credentials') || errCode.includes('unauthenticated')) {
    return {
      status: 'INVALID',
      limitations: [{
        field: 'status',
        reason: 'Google API returned 401: credential is malformed, revoked, or uses wrong key material.'
      }]
    };
  }

  // Malformed JSON / parse failure — credential file is broken
  if (msg.includes('unexpected token') || msg.includes('json') && msg.includes('parse')) {
    return {
      status: 'INVALID',
      limitations: [{ field: 'status', reason: 'Credential file could not be parsed as valid JSON.' }]
    };
  }

  // --- Access / permission errors -----------------------------------------

  // 403 — valid identity, but Cloud Shell API disabled for the project, or
  // the service account lacks cloudshell.environments.get permission.
  if (status === 403 || errCode.includes('permission_denied')) {
    return {
      status: 'UNAVAILABLE',
      limitations: [{
        field: 'status',
        reason: 'Google API returned 403: Cloud Shell API may be disabled for this project, ' +
                'or the service account lacks the cloudshell.environments.get permission.'
      }]
    };
  }

  // 404 — environment simply doesn't exist yet (user has never opened Cloud Shell).
  // This is NOT a credential failure — the credential works fine.
  if (status === 404 || errCode.includes('not_found')) {
    return {
      status: 'AVAILABLE',   // credential is valid; environment just hasn't been created
      validated: true,
      limitations: [],
      details: {
        providerState: 'no-environment-yet',
        note: 'No Cloud Shell environment exists for this account yet. ' +
              'One will be created automatically on first use.'
      }
    };
  }

  // --- Transient / infrastructure errors ----------------------------------
  // 5xx, network timeouts, DNS failures — not cached (UNKNOWN)
  if (!status || status >= 500) {
    return {
      status: 'UNKNOWN',
      limitations: [{
        field: 'status',
        reason: `Transient Google API error (${status || 'network'}): ${
          redactTokensFromMessage(error.message || 'unknown error')
        }`
      }]
    };
  }

  // Catch-all for unexpected 4xx
  return {
    status: 'UNKNOWN',
    limitations: [{
      field: 'status',
      reason: `Unexpected Google API response (${status}): ${
        redactTokensFromMessage(error.message || 'unknown error')
      }`
    }]
  };
}
```

**Key detection notes**:
- `google-auth-library` throws before any HTTP call for bad credentials;
  these surface as plain `Error` with meaningful `.message` strings.
  Test with a deliberately expired service-account key to confirm the exact
  message format and adjust the string checks if needed.
- `GaxiosError.response.data.error` may be a string (e.g. `"invalid_grant"`)
  or an object `{ status: "PERMISSION_DENIED", message: "..." }` — the code
  normalises both via `toString().toLowerCase()`.
- `redactTokensFromMessage` is defined in `plan-shared.md` and prevents any
  JWT fragment from leaking into the limitation text.

---

## Reuse Summary

| Existing component | Used by checker | How |
|---|---|---|
| `initGoogleCredentialsFromS3IfNeeded` | Dispatcher load step | Unchanged — resolves ref → credentials path |
| `gcs-service.getAuthClient` | `getEnvironmentAccess` | Same auth stack as session flows |
| `gcs-service.getEnvironmentName(auth, credentialsPath?)` | `getEnvironmentAccess` | Resolves `users/{email}/environments/default` |
| `cloudshell.users.environments.get` | `getEnvironmentAccess` | Existing googleapis client variable in `gcs-service.js` |
| Shared envelope / cache / routes / precedence | Everything | Per `plan-shared.md` |

---

## Key Decisions

- **Never `environments.start()`**: validation must not consume weekly quota or
  wake suspended VMs (spec FR-9, NFR-1). A `SUSPENDED` environment still proves
  the credential is valid — it is reported as `AVAILABLE` with
  `details.providerState: 'SUSPENDED'`.
- **404 ≠ INVALID**: absent environment means the account simply hasn't used
  Cloud Shell. Status stays `AVAILABLE`.
- **Quota honesty**: single `hours/week` entry with `usage: null`, `limit: 50`;
  static limits in `details.referenceLimits`. No scraping.
- **`expiresAt: null`**: service-account JSON keys carry no embedded expiry
  timestamp. OAuth tokens are refreshed transparently by `google-auth-library`.
- **GCS never produces `LIMITED`**: there is no token-uniqueness index on the
  `sessions` table for GCS. Session count is reported in
  `details.localActiveSessions` for information only.

---

## Test Checklist

- Happy path (`RUNNING` or `SUSPENDED` env): `AVAILABLE`, one quota entry,
  limitation text present, `validated: true`, `providerState` set.
- No-environment path (404): still `AVAILABLE`, `providerState: 'no-environment-yet'`.
- Expired grant (`invalid_grant` in error message) → `EXPIRED` + limitation.
- Revoked key (401 / `invalid_credentials`) → `INVALID` + limitation.
- Malformed JSON file → `INVALID` (loader surfaces parse error before API call).
- API-disabled project (403 / `PERMISSION_DENIED`) → `UNAVAILABLE` + limitation.
- Transient 5xx → `UNKNOWN`, **not cached** (verify by checking cache after call).
- `mapGoogleError` never leaks token or key material into limitation strings.
- Mock `cloudshell.users.environments.get` at the `gcs-service.js` module
  boundary (pattern used by existing GCS tests).
