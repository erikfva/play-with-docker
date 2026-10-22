# LAB-013: Implementation Plan — Available Credential Selection

**Spec**: `ai/LAB-013_available-credential/spec.md`
**Last Updated**: 2026-10-21

---

## Starting Point

`src/services/available-credential-service.js`, `GET /api/v1/vps/available-credential`, and both test
files already exist. This plan is therefore mostly **correction**, not construction: the skeleton
(candidate query, annotation, strategy selection, error contract, route wiring) is sound and stays.

Four behaviours differ from the spec, plus one removal:

| # | Spec | Current code | Work |
|---|---|---|---|
| 1 | In-use excludes for every provider, GCS matched on the stored credential reference (FR-3, US-3) | `ENFORCES_TOKEN_UNIQUENESS = new Set(['codesandbox','codespaces','gcloud'])` — `'gcloud'` never matches the provider id `'gcs'`, so GCS is never excluded; `inUseKnown` is `false` for GCS | Step 2 |
| 2 | Only quotas metered in `core-hours` rank (FR-5) | `isComputeQuota` matches any name/unit containing `compute`, or `core`+`hour` | Step 3 |
| 3 | No `source` field in the response (FR-6) | Response includes `source: 'db'` | Step 4 |
| 4 | 409 details carry a `reason` (FR-8) | Details have `provider`/`considered`/`inUse`/`unusable` only | Step 5 |
| 5 | Registry rows are the only candidates — no file fallback (FR-2, FR-7) | `listLegacyCandidates` / `loadLegacyCandidate` / `computeLegacyGcsFingerprint` / `allowLegacyFiles` | Step 1 |

---

## Reuse Map

| Need | Reuse as-is from |
|:---|:---|
| Candidate SQL shape, camelCase aliasing | `available-credential-service.listDbCandidates` — already correct, unchanged |
| Registration ordering | Existing `ORDER BY v.createdat ASC, v.id ASC` in `listDbCandidates` — unchanged; FR-2 depends on it |
| Terminal-status sets | `available-credential-service.TERMINAL_SESSION_STATUSES` — already matches `db.js:134/167`, `vps-status-service.js:101`, `credential-status-service.js:82`; unchanged |
| Non-terminal-session SQL predicate | Copy the `COALESCE(status, '') NOT IN (…)` form from `vps-status-service.js:106` / `routes/vps.js:38` |
| `ProviderError` with `code`/`statusCode`/`details` | `src/services/errors/provider-errors.js` |
| `mapErrorToHttp` error serialization | `src/utils/http-helpers.js` — route already uses it; no route change |
| `validateProvider` + the `VPS_INVALID_PARAM` rewrite | `src/routes/vps.js` `GET /available-credential` — already correct, unchanged |
| Route placement before `/:id` | Already declared before the `/:id` routes — unchanged |
| `db.all` query wrapper (`?` → `$n` rewriting) | `src/db/db.js` |
| Lazy `require('../db/db')` inside the service | Existing pattern in the service — keeps the module unit-testable without Postgres |
| Route-test harness (`stubModule`, `requestApp`) | `tests/available-credential-route.test.js` — unchanged |
| Service-test harness (`stubDb`, `candidate()`, `withStatus()`, `computeQuota()`) | `tests/available-credential.test.js` — reused, helper signatures preserved |
| `'core-hours'` as the canonical unit string | `providers/codespaces-provider.js:251` — `quotaUnit: 'core-hours'`; the strict matcher keys off exactly this |

**Not reused (deliberately):** `credentials-lister.js`, the per-provider credential loaders, and the
`PROVIDER_PREFIXES` map. They existed only to support the file fallback that FR-2/FR-7 remove.

---

## File Map

### Modified

```
src/services/available-credential-service.js   — steps 1–5 (all service changes)
tests/available-credential.test.js             — assertions for steps 1–5
tests/http/LAB-013-available-credential.http   — envelope + GCS in-use scenarios
ai/project-overview.md                         — endpoint section: drop fallback/source, fix GCS rule
```

### Unmodified

```
src/routes/vps.js                              — already satisfies FR-7's route contract
tests/available-credential-route.test.js       — stubs the service; no spec-visible change
src/db/db.js                                   — no schema change: sessions.credentialRef and
                                                 sessions.credentialFingerprint already exist (db.js:120–121)
```

---

## Step-by-Step Implementation

### Step 1 — Drop the file-backed fallback (FR-2, FR-7)

Delete from `available-credential-service.js`:

- `PROVIDER_PREFIXES`
- `listLegacyCandidates`, `loadLegacyCandidate`, `computeLegacyGcsFingerprint`
- the `allowLegacyFiles` option and the `candidates.length === 0` fallback branch in
  `getAvailableCredential`
- `listLegacyCandidates` from the exports

`getAvailableCredential` candidate sourcing collapses to:

```js
let candidates = injectedCandidates;
if (!candidates) {
  candidates = await listDbCandidates(providerName);
}
```

**Why delete rather than leave dormant:** the fallback is what made `source` meaningful and what made a
GCS legacy file reachable without a fingerprint. Keeping it dead would leave a second, untested
selection path that can silently disagree with the registry.

### Step 2 — In-use detection for every provider (FR-3, US-3)

Replace the `ENFORCES_TOKEN_UNIQUENESS` set with an explicit per-provider key map. GCS sessions do not
persist a fingerprint (`gcs-provider.js:259` returns no `credentialFingerprint`), but they do persist
`credentialRef`, which for GCS is the registry name (`routes/sessions.js:218` falls back to the
request's `credentialRef`, and `X-Google-Credentials` carries the registry name).

```js
/**
 * Key on the sessions table that identifies the credential a session consumes.
 * Codesandbox/Codespaces persist a credential fingerprint; GCS does not, so its
 * sessions are matched on the stored credential reference (the registry name).
 * Every provider is subject to the in-use rule.
 */
const IN_USE_KEY = {
  gcs: 'credentialRef',
  codesandbox: 'credentialFingerprint',
  codespaces: 'credentialFingerprint'
};
```

Rename `listActiveFingerprints` → `listInUseKeys(providerName)`, returning a `Set` of the key values
for that provider:

```js
async function listInUseKeys(providerName) {
  const db = require('../db/db');
  const column = IN_USE_KEY[providerName] || 'credentialFingerprint';
  const terminal = TERMINAL_SESSION_STATUSES[providerName] || ['TERMINATED', 'DELETED', 'FAILED'];
  const placeholders = terminal.map(() => '?').join(', ');
  // Unquoted identifiers fold to lowercase in PostgreSQL; alias restores camelCase.
  const rows = await db.all(
    `SELECT DISTINCT ${column} AS "inUseKey"
     FROM sessions
     WHERE provider = ?
       AND ${column} IS NOT NULL
       AND COALESCE(status, '') NOT IN (${placeholders})`,
    [providerName, ...terminal]
  );
  return new Set((rows || []).map((r) => r['inUseKey']).filter(Boolean));
}
```

`annotateCandidates` then compares the right candidate field, and `LIMITED` remains an in-use signal per
FR-3:

```js
function annotateCandidates(candidates, providerName, inUseKeys) {
  const keyField = IN_USE_KEY[providerName] || 'credentialFingerprint';

  return candidates.map((candidate) => {
    const statusObject = asStatusObject(candidate.status);
    const status = statusObject?.status || null;
    const identity = candidate[keyField] || null;

    // Fingerprint/reference match is authoritative; LIMITED (written by the
    // status service when a local session consumes the token) is a secondary
    // in-use signal.
    const inUse = (identity ? inUseKeys.has(identity) : false) || status === LIMITED_STATUS;
    ...
    return {
      ...candidate,
      status,
      statusObject,
      inUse,
      inUseKnown: true,
      usable: isUsableStatus(status),
      coreHoursRemaining: extractCoreHoursRemaining(statusObject?.quotas)
    };
  });
}
```

Rename the injection option `activeFingerprints` → `inUseKeys` for accuracy; both test files pass it.

**`inUseKnown` is now the constant `true`.** Keep the field (spec FR-6 documents it) and derive it from
`IN_USE_KEY` so it becomes `false` automatically for any future provider without a key:

```js
inUseKnown: Boolean(IN_USE_KEY[providerName])
```

### Step 3 — Strict core-hours quota match (FR-5)

`isComputeQuota` becomes a unit check. This intentionally diverges from the frontend's loose display
matcher (spec, "Definition of the compute (core-hours) quota"):

```js
/**
 * Selection ranks only on quotas metered in core-hours. The frontend's display
 * matcher is deliberately looser; see the spec. A quota named "compute" but
 * metered in minutes or currency must never be compared against core-hours.
 */
function isComputeQuota(q) {
  if (!q || typeof q !== 'object') return false;
  return String(q.quotaUnit || '').trim().toLowerCase() === 'core-hours';
}
```

`extractCoreHoursRemaining` is unchanged — it delegates to `isComputeQuota`, so it now ignores
non-core-hour quotas, including `Codespaces storage (GB-month)`.

### Step 4 — Remove `source` from the response (FR-6)

In the return object of `getAvailableCredential`, drop `source: selected.source`. Keep `source` on the
in-memory candidate objects — it is harmless and the DB path sets `'db'` — but nothing in the public
contract exposes it.

### Step 5 — Add the 409 `reason` (FR-8)

```js
const NO_REGISTERED_CREDENTIALS = 'NO_REGISTERED_CREDENTIALS';
const ALL_IN_USE_OR_UNUSABLE = 'ALL_IN_USE_OR_UNUSABLE';

if (!annotated.length) {
  throw new ProviderError(
    `No available credential for provider '${providerName}'`,
    {
      code: NO_AVAILABLE_CREDENTIAL,
      statusCode: 409,
      details: {
        provider: providerName,
        reason: NO_REGISTERED_CREDENTIALS,
        considered: 0,
        inUse: 0,
        unusable: 0
      }
    }
  );
}

if (!selected) {
  throw new ProviderError(
    `No available credential for provider '${providerName}'`,
    {
      code: NO_AVAILABLE_CREDENTIAL,
      statusCode: 409,
      details: {
        provider: providerName,
        reason: ALL_IN_USE_OR_UNUSABLE,
        considered: annotated.length,
        inUse: annotated.filter((c) => c.inUse).length,
        unusable: annotated.filter((c) => !c.usable).length
      }
    }
  );
}
```

The empty-registry case is checked on `annotated.length` rather than `candidates.length` so an injected
empty list (tests) reports the same reason as a truly empty registry. Export both constants.

### Step 6 — Exports

Final export list:

```js
module.exports = {
  getAvailableCredential,
  // exported for testing
  listDbCandidates,
  listInUseKeys,          // renamed from listActiveFingerprints
  annotateCandidates,
  selectCandidate,
  extractCoreHoursRemaining,
  isComputeQuota,
  isUsableStatus,
  asStatusObject,
  NO_AVAILABLE_CREDENTIAL,
  NO_REGISTERED_CREDENTIALS,
  ALL_IN_USE_OR_UNUSABLE,
  IN_USE_KEY,
  UNUSABLE_STATUSES,
  SUPPORTED_PROVIDERS
};
```

`listLegacyCandidates` is gone (step 1).

---

## Test Updates

### `tests/available-credential.test.js`

Reused unchanged: `stubDb`, `candidate()`, `withStatus()`, `computeQuota()`, and every test that does
not touch the five behaviours below.

| Change | Test |
|---|---|
| Rename option | every `activeFingerprints:` → `inUseKeys:` |
| Rename function | `listActiveFingerprints excludes terminal session statuses` → `listInUseKeys …`; assert the query uses `credentialFingerprint` for codespaces |
| Update | `listDbCandidates maps vps rows into candidates` — drop `candidates[0].source` assertion (line 68) |
| Update | `getAvailableCredential picks the best codespaces credential` — drop `result.source` (line 109) |
| Update | `candidate()` helper — `source` may stay; it is no longer asserted |
| Update | `isComputeQuota matches core-hour units` — `{ quotaUnit: 'core-hours' }` → `true`; `{ name: 'Codespaces compute (core-hours)' }` (no unit) → **`false`**; add `{ quotaUnit: 'core-hours', name: … }` → `true` |
| Update | `extractCoreHoursRemaining` tests — `computeQuota()` already sets `quotaUnit: 'core-hours'`, so they keep passing; add a case proving a `quotaUnit: 'minutes'` quota is ignored |
| **Replace** | `gcs does not exclude a credential because a session uses it` → `gcs excludes a credential that backs a live session`, asserting `inUse` exclusion via **credentialRef** matching and `inUseKnown === true` |
| Update | `inUseKnown is true for providers with token uniqueness` → `inUseKnown is true for every supported provider`, asserting it for `gcs` too |
| Add | all-in-use `gcs` → 409 with `reason: ALL_IN_USE_OR_UNUSABLE` |
| Add | empty candidates → 409 with `reason: NO_REGISTERED_CREDENTIALS` (extend the existing `considered: 0` test) |
| Add | `listInUseKeys('gcs')` selects the `credentialRef` column and the `TERMINATED/DELETED/FAILED` set |

### `tests/available-credential-route.test.js`

Unchanged. It stubs the service, so the 409 `reason` passes through the existing R-04 test untouched.
R-01's fixture should still be dropped if it ever grows a `source` key (it has none today).

### `tests/http/LAB-013-available-credential.http`

- Remove `source` from the documented envelope (§ preamble, §56.4).
- §55/§56 comments: GCS now reports `inUseKnown: true`.
- Add a GCS in-use scenario mirroring §59 (create a GCS session with a registry name, confirm the
  credential is skipped, terminate, confirm it returns).
- §58.3: note that a placeholder Codespaces token yields `INVALID` and is skipped — unchanged.
- **Pre-existing defects to fix while here:** §57.5 is missing its `X-Server-Token` header (would 401),
  and the file has a stray duplicate `X-Server-Token: {{serverToken}}` after the last request.

### `ai/project-overview.md`

The endpoint section currently states the opposite of the spec in three places. Update to:

- source of truth = the registry only; no file-backed fallback;
- GCS in-use *is* enforced, matched on the stored credential reference;
- response has no `source`; `inUseKnown` is `true` for all supported providers;
- add the 409 `reason` values.

---

## Risks & Edge Cases

- **Pre-LAB-010 GCS sessions** stored a file path in `sessions.credentialRef`, not a registry name, so
  they will not match and their credential will look free. Acceptable: those rows predate the registry,
  and the spec's in-use rule is defined against registry identity. Worth a code comment.
- **GCS in-use matching is a string compare on the registry name.** Two registry rows cannot share a
  name (`idx_vps_provider_name` is unique per provider), so there is no ambiguity.
- **`LIMITED` is now redundant for codesandbox/codespaces**, because every registry row has a
  non-null `credentialfingerprint` (schema) and session fingerprints are written from that same value.
  It is retained as a secondary signal to honour FR-3 literally; it costs one comparison.
- **Strict quota matching can rank a credential as 0 capacity** if GitHub ever renames the unit. The
  credential stays eligible and is still selectable — it just loses ties. This is the intended
  trade-off (spec decision 3); the failure mode is a suboptimal pick, not an unavailable one.
- **No schema change is needed.** `sessions.credentialRef` and `sessions.credentialFingerprint` both
  already exist (`db.js:120–121`), and `vps.credentialfingerprint` is `NOT NULL`, so no migration and no
  backfill.
- **Not addressed here:** the frontend's looser display matcher stays as-is (spec decision 3 chose a
  deliberate divergence). If the two ever disagree in practice, tightening `isCodespacesComputeQuota`
  in `vm-manager/src/app/vps/quota-helpers.ts:72` is a follow-up, not part of this story.

---

## Verification

```bash
cd play-with-docker

# Targeted — no Postgres needed (the service stubs ../db/db)
node --test tests/available-credential.test.js tests/available-credential-route.test.js

# Full suite — 23 pre-existing failures require a live Postgres (ECONNREFUSED from src/db/db.js)
npm test
```

Manual smoke: `tests/http/LAB-013-available-credential.http` against a running server
(`localhost:3200`, `SERVER_TOKEN` set) — §55 error matrix, §56 happy paths, §57 exhausted-credential
409, §58 Codespaces ranking, §59 in-use skipping (now incl. GCS).

---

## Order of Work

1. Step 1 (remove fallback) — smallest diff, makes the remaining behaviour unambiguous.
2. Step 3 (strict quota match) — isolated, one function.
3. Step 2 (in-use for every provider) — the substantive change; touches SQL, annotation, exports.
4. Steps 4–5 (response field, 409 reason) — small, spec-visible.
5. Step 6 (exports) + test updates + docs.
