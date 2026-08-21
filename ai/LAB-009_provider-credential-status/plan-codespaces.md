# LAB-009: Implementation Plan — Codespaces Credential Status

**Spec**: `ai/LAB-009_provider-credential-status/spec.md` (§10.3)
**Research**: `research.md` (§5.3)
**Shared infra**: `plan-shared.md` — read first for envelope, cache, precedence
**Last Updated**: 2026-08-21

---

## Guiding Principle

Codespaces status has three layers, checked in order of reliability:
1. **Token validity** — `GET /user` (already implemented in `client.js`).
2. **Adoptability** — `GET /user/codespaces` (already implemented). This
   project is adopt-don't-create, so zero codespaces means the credential
   cannot run a session even though the token is perfectly valid.
3. **Billing usage** — public-preview endpoint, best-effort; any failure
   degrades to `null` + limitation and never invalidates the credential.

Included compute is reported as **core-hours**, matching GitHub's official
documentation, which uses that exact term on multiple pages (plans page,
billing reference table, and the Codespaces troubleshooting guide — sources
in §1). Consumption accrues at the machine-type multiplier rate (×2 for a
2-core machine, ×4 for 4-core, …), so a 4-core codespace depletes the
120 core-hour allowance in roughly 30 clock hours. The billing page's
shorthand "120 hrs" refers to the same core-hour allowance. See §4 for how
this is presented.

## File Map

### Modified files

```
src/services/providers/codespaces/client.js           — add getBillingUsageSummary()
src/services/providers/codespaces-provider.js         — add getCredentialStatus(loaded)
```

No DB or route changes beyond the shared plan. No CLI executor involvement —
status checks never SSH into VMs.

---

## 1. Official API surface used

### Billing usage summary (public preview)

Confirmed from `https://docs.github.com/en/rest/billing/usage`:

```
GET /users/{username}/settings/billing/usage/summary
```

- Status: **public preview** — subject to change; parse defensively.
- Required token permission: **"Plan" user permissions (read)** for
  fine-grained PATs, or an authenticated classic PAT with `read:user`.
- Response shape (confirmed from official example):

```json
{
  "timePeriod": { "year": 2025 },
  "user": "monalisa",
  "usageItems": [
    {
      "product":      "Actions",
      "sku":          "actions_linux",
      "unitType":     "minutes",
      "pricePerUnit": 0.008,
      "grossQuantity": 1000,
      "grossAmount":   8,
      "discountQuantity": 0,
      "discountAmount":   0,
      "netQuantity":  1000,
      "netAmount":       8
    }
  ]
}
```

**Critical field name**: usage volume is in **`grossQuantity`** (not
`usageQuantity`, not `quantity` — both of those names are absent from the
documented schema). Parse using `row.grossQuantity`.

The `unitType` for Codespaces compute entries is not shown in the Actions
example above. The plan uses `unit.includes('hour')` as a defensive filter.
If GitHub returns a different string (e.g. `"compute-hours"`), the defensive
guard still catches it.

### Free-quota reference values (confirmed from billing docs)

| Plan | Included compute | Included storage |
|---|---|---|
| GitHub Free | 120 core-hours/month | 15 GB-month |
| GitHub Pro | 180 core-hours/month | 20 GB-month |

Confirmed as **core hours** across official documentation:
- `docs.github.com/en/get-started/learning-about-github/githubs-plans` —
  "120 GitHub Codespaces core hours per month" / "180 …core hours…".
- `docs.github.com/en/billing/reference/product-usage-included` —
  "Core hours (per month): 120 / 180".
- `docs.github.com/en/codespaces/troubleshooting/troubleshooting-included-usage` —
  "Codespaces compute is counted in core hours, which is the sum of the time a
  codespace is active, multiplied by the multiplier for the codespace's machine
  type." Same page: storage is counted in GB-hours for billing but expressed
  against the GB-month quota.

Report the plan's included core-hours as the quota `limit` with
`quotaUnit: 'core-hours'`; document the machine-multiplier effect in the
limitation text, and never present remaining core-hours as clock runtime
without dividing by core count.

---

## 2. `client.js` — `getBillingUsageSummary(token, login)`

```javascript
/**
 * Public-preview billing usage summary for a personal user account.
 * Requires "Plan" user read permissions.
 * May freely return 403/404 for tokens without billing access.
 *
 * @param {string} token - GitHub PAT
 * @param {string} login - GitHub username (from GET /user response)
 * @returns {Promise<object>} parsed response body
 * @throws {ProviderError} on HTTP error — caller treats any throw as "billing unavailable"
 */
async function getBillingUsageSummary(token, login) {
  // IMPORTANT: do NOT pass a third argument to githubGet().
  // The existing signature is githubGet(path, token, attempt = 1).
  // Passing an options object as the third arg would set attempt = { headers: ... }
  // and break the exponential-backoff retry counter.
  //
  // The API version header ('X-GitHub-Api-Version: 2026-03-10') is already
  // injected by githubHeaders() for every request — no override needed here.
  return githubGet(
    `/users/${encodeURIComponent(login)}/settings/billing/usage/summary`,
    token
    // no third argument
  );
}
```

Add to `module.exports`.

**Why not go through `read-cache.js`**: that cache is keyed by token
fingerprint + codespace name and has a 30-second TTL. Billing data is a
different concern with a different key shape; it lives under the shared 5-minute
status cache instead (via `finalizeEntry` in the dispatcher).

---

## 3. Private helpers in `codespaces-provider.js`

```javascript
/**
 * Returns a safe, redacted reason string from an error for use in limitation text.
 * Never includes token fragments, credential values, or long alphanumeric runs.
 */
function safeReason(error) {
  const msg = error?.message || 'unknown error';
  return redactTokensFromMessage(msg);  // redactTokensFromMessage from plan-shared.md
}

/**
 * Returns a compact error code string safe for limitation text.
 * Prefers the ProviderError code, falls back to HTTP status.
 */
function safeErrorCode(error) {
  return error?.code
    || (error?.statusCode ? `HTTP_${error.statusCode}` : null)
    || (error?.status     ? `HTTP_${error.status}`     : null)
    || 'UNKNOWN_ERROR';
}

/**
 * Returns true ONLY for terminal auth failures thrown by client.js's buildError:
 * invalid token (401), insufficient scope (403), suspended account (403).
 *
 * Deliberately EXCLUDES CODESPACES_RATE_LIMIT_EXCEEDED (buildError maps
 * rate-limited 403s and 429s to this code with statusCode 429) and
 * CODESPACES_API_ERROR — those are transient and must re-throw so the
 * dispatcher surfaces UNKNOWN without caching. They must never report a
 * healthy token as INVALID.
 */
function isTerminalAuthError(error) {
  return (
    error?.code === 'CODESPACES_TOKEN_INVALID' ||
    error?.code === 'CODESPACES_TOKEN_INSUFFICIENT_SCOPE' ||
    error?.code === 'CODESPACES_ACCOUNT_SUSPENDED'
  );
}

/**
 * Returns n if finite, otherwise null.
 */
function numOrNull(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Round to one decimal place.
 */
function round1(n) {
  return Math.round(n * 10) / 10;
}
```

---

## 4. `getCredentialStatus(loaded)` on `CodespacesProvider`

```javascript
async getCredentialStatus(loaded) {
  const limitations = [];
  const quotas = [];

  // ── Step 1: identity (GET /user) ─────────────────────────────────────────
  let login, plan;
  try {
    const user = await client.validateToken(loaded.token);  // existing function
    login = user.login;

    // user.plan is present on personal accounts authenticated with a PAT.
    // Shape: { name: 'free'|'pro', space, private_repos, collaborators }
    // For org-owned tokens or managed accounts it may be absent.
    plan = user.plan?.name ?? null;
  } catch (error) {
    // Whitelist ONLY terminal auth failures as INVALID (both 401 and 403 auth
    // codes mean no usable session can ever be produced). Everything else —
    // most importantly CODESPACES_RATE_LIMIT_EXCEEDED from buildError's
    // rate-limit mapping — must re-throw so the dispatcher wraps it as
    // UNKNOWN without caching. Rate limiting is transient, not an auth state.
    if (isTerminalAuthError(error)) {
      return {
        status: 'INVALID',
        validated: false,
        quotas: [],
        expiresAt: null,
        limitations: [limitation('status', safeReason(error))]
      };
    }
    throw error;
  }

  // Reference limits based on plan. org/enterprise accounts → no free quota;
  // unknown plan → fall back to free defaults and flag it.
  let refLimits;
  if (plan === 'pro') {
    refLimits = { computeCoreHoursPerMonth: 180, storageGbMonth: 20 };
  } else {
    refLimits = { computeCoreHoursPerMonth: 120, storageGbMonth: 15 };
    if (plan !== 'free') {
      limitations.push(limitation(
        'details.referenceLimits',
        `Account plan is '${plan ?? 'unknown'}'. Reference limits shown are for ` +
        'GitHub Free personal accounts. Organization/enterprise accounts have no ' +
        'included Codespaces quota by default.'
      ));
    }
  }

  // ── Step 2: adoptability (GET /user/codespaces) ──────────────────────────
  const spaces   = await client.listCodespaces(loaded.token);  // existing function
  const adoptable = Array.isArray(spaces) ? spaces.length : 0;

  // ── Step 3: billing usage (best-effort, public preview) ──────────────────
  let usage = null;
  try {
    const body = await client.getBillingUsageSummary(loaded.token, login);
    usage = extractCodespacesUsage(body);
  } catch (error) {
    limitations.push(limitation(
      'quotas[0].usage',
      `Billing usage summary unavailable (${safeErrorCode(error)}). ` +
      'Requires "Plan" user read permission on the token and a personal account context.'
    ));
  }

  // ── Quota entries ─────────────────────────────────────────────────────────

  // Compute: core-hours (official documentation unit), consumed at the
  // machine-type multiplier rate
  const computeUsage   = usage?.computeHours ?? null;
  const computeLimit   = refLimits.computeCoreHoursPerMonth;
  const computeRemain  = computeUsage != null
    ? Math.max(0, computeLimit - computeUsage)
    : null;

  quotas.push(quotaEntry({
    quotaUnit:  'core-hours',
    quotaPeriod: 'month',
    usage:     numOrNull(computeUsage),
    limit:     computeLimit,
    remaining: numOrNull(computeRemain)
  }));
  limitations.push(limitation(
    'quotas[0]',
    'Included compute is metered in core-hours, not clock hours: consumption ' +
    "accrues at the codespace machine's core-count multiplier (a 4-core machine " +
    'depletes the allowance twice as fast as a 2-core machine). Remaining ' +
    'core-hours overstate possible clock runtime unless divided by core count.'
  ));

  // Storage: GB-month
  const storageUsage  = usage?.storageGbMonths ?? null;
  const storageLimit  = refLimits.storageGbMonth;
  const storageRemain = storageUsage != null
    ? Math.max(0, storageLimit - storageUsage)
    : null;

  quotas.push(quotaEntry({
    quotaUnit:  'GB-month',
    quotaPeriod: 'month',
    usage:     numOrNull(storageUsage),
    limit:     storageLimit,
    remaining: numOrNull(storageRemain)
  }));

  // ── Status ────────────────────────────────────────────────────────────────
  if (adoptable === 0) {
    return {
      status: 'UNAVAILABLE',
      validated: true,
      quotas,
      limitations,
      expiresAt: null,
      details: {
        referenceLimits: refLimits,
        plan,
        adoptable: 0,
        reason: "This orchestrator uses adopt-don't-create flow. The GitHub " +
                'account must already have at least one codespace before a ' +
                'session can be created.'
      }
    };
  }

  return {
    status:    'AVAILABLE',
    validated: true,
    quotas,
    limitations,
    expiresAt: null,
    details: {
      referenceLimits:      refLimits,
      plan,
      adoptable,
      adoptedCodespaceState: spaces[0]?.state ?? null  // raw GitHub state string
    }
  };
}
```

---

## 5. `extractCodespacesUsage(body)` — defensive preview parsing

The response shape is not contractually stable (public preview), so parse
every field defensively and return `null` for anything that doesn't match.

```javascript
/**
 * Extract Codespaces compute and storage usage from a billing usage summary body.
 * Returns { computeHours, storageGbMonths }, either or both may be null.
 *
 * Key facts (confirmed from official API docs):
 *   - Usage volume is in `grossQuantity` (NOT usageQuantity, NOT quantity).
 *   - `unitType` is the unit string; for Codespaces compute it may contain
 *     'hour' or 'core' (core-hours); for storage it may be 'gb-months' or
 *     'gb-hours' (both contain 'gb'). None of these are contractually
 *     guaranteed for Codespaces line items — filter defensively.
 *   - Filter rows by `product` matching 'codespaces' (case-insensitive).
 */
function extractCodespacesUsage(body) {
  const items = Array.isArray(body?.usageItems) ? body.usageItems
    : Array.isArray(body) ? body    // fallback if API returns bare array
    : [];

  const rows = items.filter((i) =>
    String(i?.product || '').toLowerCase() === 'codespaces'
  );

  let computeHours   = null;
  let storageGbMonths = null;

  for (const row of rows) {
    // grossQuantity is the confirmed field name from the official API schema.
    // Include usageQuantity and quantity as defensive fallbacks only.
    const qty  = numOrNull(
      row.grossQuantity  ??   // ← primary: confirmed field name
      row.usageQuantity  ??   // ← defensive fallback
      row.quantity            // ← defensive fallback
    );
    const unit = String(row.unitType || row.unit || '').toLowerCase();

    if (qty == null) continue;

    if (unit.includes('hour') || unit.includes('core')) {
      computeHours = round1((computeHours ?? 0) + qty);
    } else if (unit.includes('gb') || unit.includes('storage')) {
      storageGbMonths = round1((storageGbMonths ?? 0) + qty);
    }
    // Unknown unit → silently skip (preview drift tolerance)
  }

  return { computeHours, storageGbMonths };
}
```

If `usageItems` is absent or no Codespaces rows exist, returns
`{ computeHours: null, storageGbMonths: null }`. The quota entries then carry
`usage: null` with the limitation text already pushed in step 3.

---

## 6. Status rules

| Condition | Status | Notes |
|---|---|---|
| `GET /user` 401 | `INVALID` | Token invalid / expired |
| `GET /user` 403 (`CODESPACES_TOKEN_INSUFFICIENT_SCOPE`) | `INVALID` | Token lacks `codespace` scope |
| `GET /user` 403 (`CODESPACES_ACCOUNT_SUSPENDED`) | `INVALID` | Account suspended |
| `GET /user` network / 5xx | `UNKNOWN` (re-throw) | Transient; not cached |
| `GET /user` rate-limited (`CODESPACES_RATE_LIMIT_EXCEEDED`, 429) | `UNKNOWN` (re-throw) | Transient; must **never** map to `INVALID` |
| 0 adoptable codespaces | `UNAVAILABLE` | Adopt-flow explanation in details |
| Billing 403/404/error | `AVAILABLE` (degraded) | Limitation added; credential not invalidated |
| Local non-terminal row (incl. `STOPPED`) | `LIMITED` candidate | Via shared precedence |

Precedence examples:
- 0 adoptable + local `STOPPED` session → `UNAVAILABLE` (beats `LIMITED`)
- ≥1 adoptable + local `STOPPED` session → `LIMITED`
- ≥1 adoptable + billing fails → `AVAILABLE` with `usage: null`

`QUOTA_EXHAUSTED` is only emitted on **explicit** upstream evidence (e.g. a
future GitHub API field indicating budget exhaustion). The included-quota limits
we report are static reference documentation — a local `remaining` calculation
crossing zero is not exhaustion evidence and must not produce `QUOTA_EXHAUSTED`.

---

## Reuse Summary

| Existing component | Used by checker | How |
|---|---|---|
| `client.validateToken` | Step 1 | Unchanged; `user.plan?.name` read from response |
| `client.listCodespaces` | Step 2 | Unchanged |
| `githubGet(path, token)` | `getBillingUsageSummary` | Called with two args only — no third arg |
| `buildError` / error codes in `client.js` | `isTerminalAuthError` | Inspects `error.code`; excludes transient rate-limit/API errors |
| `loadCodespacesCredentials` | Dispatcher load step | Unchanged |
| Shared `quotaEntry` / `limitation` helpers | All quota entries | Per `plan-shared.md` |
| Shared envelope / cache / routes / precedence | Everything | Per `plan-shared.md` |

---

## Key Decisions

- **`user.plan?.name` from `validateToken`**: no second API call needed. The
  `GET /user` response already includes `plan.name` for personal accounts.
  `fetchPlanSafe` was a phantom — remove it entirely.
- **`grossQuantity` is the correct field**: confirmed from the official billing
  API schema. `usageQuantity` and `quantity` are defensive fallbacks only.
- **`githubGet` two-arg call**: the existing function signature is
  `githubGet(path, token, attempt = 1)`. A third argument would corrupt the
  retry counter. The `X-GitHub-Api-Version` header is already set globally in
  `githubHeaders()` — no per-call override is needed.
- **Core-hours, verified against official docs**: the plans page, billing
  reference table, and troubleshooting guide all use "core hours"; consumption
  is active-time × machine-type multiplier (×2 … ×32). `quotaUnit` stays
  `'core-hours'` per spec FR-20 normalized names. Remaining core-hours are
  never presented as clock runtime without dividing by core count. The billing
  page's "120 hrs" shorthand refers to the same core-hour allowance.
- **Storage `remaining` derived when possible**: both `storageUsage` and
  `storageLimit` are known quantities when billing data is accessible, so
  `remaining = max(0, limit − usage)` is computed (same as compute).
- **Billing 403 never downgrades the credential**: permission failures from the
  billing endpoint are silently absorbed as `usage: null` + limitation text.
- **Org/enterprise accounts deferred** (spec open question #4): `plan` returns
  null or an org-level string → free-plan defaults used, flagged in limitations.

---

## Test Checklist

- Valid token + ≥1 codespace → `AVAILABLE`, two quota entries; first entry has
  `quotaUnit: 'core-hours'`, second `quotaUnit: 'GB-month'`.
- Valid token + 0 codespaces → `UNAVAILABLE` with adopt-flow reason.
- `GET /user` 401 → `INVALID` (not re-thrown, not UNKNOWN).
- `GET /user` 403 scope error → `INVALID`.
- `GET /user` 403 account suspended → `INVALID`.
- `GET /user` network/5xx → re-thrown → dispatcher returns `UNKNOWN`, not cached.
- `GET /user` rate-limited (`CODESPACES_RATE_LIMIT_EXCEEDED`) → re-thrown →
  `UNKNOWN`, **not** `INVALID` (regression guard for the 429-mapping bug).
- Billing 403/404 → status driven by steps 1–2 only; both quota entries have
  `usage: null`; one limitation added.
- Billing returns garbage body → `extractCodespacesUsage` returns all-null;
  status unaffected.
- `grossQuantity` field used: fixture with `{ grossQuantity: 45.5, unitType: 'hours' }`
  → `computeHours === 45.5`.
- `usageQuantity` fallback: fixture with `{ usageQuantity: 10, unitType: 'hours' }`
  and no `grossQuantity` → `computeHours === 10`.
- Multiple Codespaces rows sum correctly; non-Codespaces rows ignored.
- `plan === 'pro'` → `computeCoreHoursPerMonth: 180`, `storageGbMonth: 20`.
- `plan === null` → free defaults + plan-unknown limitation.
- Local `STOPPED` row → `LIMITED` candidate applied via shared precedence.
- `remaining` derived correctly for both compute and storage when usage is known.
- `unitType: 'core-hours'` rows are counted as compute (matches `'core'` filter).
- Mock `fetch` at the `client.js` boundary (existing test pattern); include a
  preview-shape drift fixture to verify graceful degradation when field names
  change.
- Verify `getBillingUsageSummary` calls `githubGet` with exactly two arguments
  (no third arg that would corrupt retry count).
