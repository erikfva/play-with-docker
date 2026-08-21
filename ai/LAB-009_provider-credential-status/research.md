# Research: LAB-009 - Provider Credential Status and Availability

## 1. Research Date

2026-08-16

## 2. Research Question

For each current provider in the orchestrator (`gcs`, `codesandbox`, and `codespaces`), determine:

1. What free-tier, quota, credit, or included-usage model applies to VM/session usage?
2. Whether credentials can be checked for validity, expiration, or revocation through documented APIs or libraries.
3. Whether remaining hours, credits, storage, or other availability details can be retrieved programmatically.
4. What should be exposed in a normalized credential status API without fabricating unsupported data.

## 3. Sources

### Google Cloud Shell

- Cloud Shell quotas and limits: https://docs.cloud.google.com/shell/docs/quotas-limits
- Cloud Shell REST API reference: https://docs.cloud.google.com/shell/docs/reference/rest/v1

### CodeSandbox

- CodeSandbox SDK pricing: https://codesandbox.io/docs/sdk/pricing
- CodeSandbox SDK clients: https://codesandbox.io/docs/sdk/clients
- CodeSandbox SDK overview: https://codesandbox.io/docs/sdk
- CodeSandbox SDK sandbox management: https://codesandbox.io/docs/sdk/manage-sandboxes

### GitHub Codespaces

- About billing for GitHub Codespaces: https://docs.github.com/en/codespaces/billing/reference/about-billing-for-github-codespaces
- GitHub REST API - Codespaces: https://docs.github.com/en/rest/codespaces/codespaces
- GitHub REST API - Billing: https://docs.github.com/en/rest/billing/billing
- Billing usage summary endpoint (public preview): `GET /users/{username}/settings/billing/usage/summary` with header `X-GitHub-Api-Version: 2026-03-10`; filter entries where `product = Codespaces`.

## 4. Executive Summary

The providers do not expose equal availability data.

- Google Cloud Shell has a documented free weekly usage quota, but the Cloud Shell API documentation does not expose a remaining-hours field. The API can validate whether credentials work and whether an environment can be accessed, but remaining weekly quota appears UI-only in the documented Cloud Shell quota page.
- CodeSandbox documents VM credit rates and a free-plan concurrent VM limit for SDK usage, but the SDK docs reviewed do not document a balance, remaining-credit, token-expiration, or quota-status API. Credential checks can validate token usability through SDK operations, but exact remaining credits should be reported as unknown unless CodeSandbox adds or documents an account/billing endpoint.
- GitHub Codespaces documents included monthly compute/storage for personal accounts (compute is measured in core-hours, not clock hours). GitHub APIs can validate tokens and list codespaces, which is especially important because this project adopts existing codespaces instead of creating them. A public-preview billing usage summary endpoint (`/users/{username}/settings/billing/usage/summary`) can expose actual usage filtered by `product = Codespaces`, but support and fields vary by owner type and permissions. The implementation should treat billing data as optional.

Recommended product behavior: expose a normalized status model with exact provider evidence when available, static reference limits from documentation, local orchestrator constraints, and explicit `unknown` limitations when an upstream API does not expose remaining usage.

## 5. Provider Findings

## 5.1 Google Cloud Shell (`gcs`)

### Free-tier and availability model

Google Cloud Shell is documented as providing:

- Default weekly Cloud Shell quota: 50 hours.
- Session cap: 12 hours.
- Non-interactive session cap: 40 minutes.
- Persistent `$HOME` disk: 5 GB free persistent storage.
- `$HOME` deletion after 120 days of no Cloud Shell access.

The quota page states that quota can be viewed in the Cloud Shell UI through session information and usage quota.

### Credential validation options

The current provider already uses Google APIs to:

- Authorize access to Cloud Shell environments.
- Start/get Cloud Shell environments.
- Add/remove public keys.

A credential status check can safely validate a credential by using the same Google auth stack and a low-impact Cloud Shell API call, such as `users.environments.get` or an equivalent environment access check. The implementation should avoid starting an environment unless status semantics explicitly allow wake/start behavior.

### Programmatic remaining-hours availability

The Cloud Shell REST API reference lists resources and methods for:

- `v1.operations`: `cancel`, `delete`, `get`, `list`
- `v1.users.environments`: `addPublicKey`, `authorize`, `get`, `removePublicKey`, `start`

The reviewed REST API documentation does not describe fields for:

- Remaining weekly quota hours.
- Used quota hours.
- Account credits.
- Credential expiration.
- Billing status.

The quota page references UI visibility for usage quota, but not an API response field.

### Recommended status response

For a valid credential:

```json
{
  "provider": "gcs",
  "status": "AVAILABLE",
  "availability": {
    "remainingHours": null,
    "remainingCredits": null,
    "includedHoursPerWeek": 50,
    "storageLimitGb": 5
  },
  "details": {
    "validated": true,
    "limitations": [
      {
        "field": "remainingHours",
        "reason": "Cloud Shell documents the weekly quota and UI quota display, but the Cloud Shell REST API docs do not expose a remaining-hours field."
      }
    ]
  }
}
```

For invalid credentials, map Google auth errors to:

- `INVALID` for malformed credentials or authentication failure.
- `EXPIRED` when an OAuth/token error clearly indicates expiration and refresh cannot recover.
- `UNAVAILABLE` for Cloud Shell API disabled, permission denied, or project/account access problems.
- `UNKNOWN` for transient Google API failures.

### Implementation notes

- Do not scrape the Cloud Shell UI for quota data.
- Include static documented limits as reference data, not as live remaining availability.
- If the provider starts an environment as part of validation, document that the check can consume quota. Prefer non-starting validation first.

## 5.2 CodeSandbox (`codesandbox`)

### Free-tier and availability model

The CodeSandbox SDK pricing documentation describes SDK usage through CodeSandbox plans.

Documented free-plan and credit information reviewed:

- Free plan: `Build (free)`.
- Free-plan concurrent VM limit: 10 concurrent VMs.
- VM credits are priced at `$0.01486` per credit.
- Runtime billing granularity is by minute.
- VM credit rates by tier:
  - `Pico`: 5 credits/hour.
  - `Nano`: 10 credits/hour.
  - `Micro`: 20 credits/hour.
  - `Small`: 40 credits/hour.
  - `Medium`: 80 credits/hour.
  - `Large`: 160 credits/hour.
  - `XLarge`: 320 credits/hour.

The project already enforces a stricter local constraint: one active CodeSandbox session per token fingerprint.

### Credential validation options

The current implementation uses `@codesandbox/sdk` (v2.4.2) authenticated with API tokens loaded from credential files. A credential status check can validate a token and read live quota signals by:

- Loading the token through the existing credential loader.
- Creating or retrieving the cached SDK `API` client.
- Calling `GET /meta/info` through `API.getMetaInfo()`, which requires authentication and returns the token's live `rate_limits` and `auth` context. A `401`/`403` here means the token is expired, revoked, or lacks scopes, so the credential cannot create a VM.
- Optionally calling `API.listRunningVms()` to get the live `concurrent_vm_count` and `concurrent_vm_limit`, corroborating free parallel-VM capacity.

These calls are low-impact: `getMetaInfo()` is a metadata read and `listRunningVms()` only lists existing VMs; neither creates or starts a VM, so they do not consume creation quota.

Inspecting the installed SDK type definitions (`@codesandbox/sdk@2.4.2`) shows the relevant surface:

- `API.getMetaInfo(): MetaInformation` — `GET /meta/info`
- `API.listRunningVms()` — returns `{ concurrent_vm_count, concurrent_vm_limit, vms[] }`

### Programmatic remaining-credit availability

The SDK does **not** expose a credit-balance field. Confirmed from the v2.4.2 type definitions: there is no method or type for remaining credits, used credits, account balance, plan name, plan expiration, or free-tier usage consumed. `credit_basis` appears on each running VM in `listRunningVms()` but is a per-VM pricing reference, not a balance.

However, the SDK **does** expose live quota/rate-limit headroom that directly answers "can this token still create a VM now?" The `MetaInformation.rate_limits` block returned by `getMetaInfo()` contains:

- `concurrent_vms: { limit?, remaining? }`
- `sandboxes_hourly: { limit?, remaining?, reset? }`
- `requests_hourly: { limit?, remaining?, reset? }`
- `auth: { scopes, team, version }`

Interpretation against the user goal of knowing if a token can create a VM due to quota or expiration:

- `getMetaInfo()` fails (`401`/`403`) → token expired/revoked/invalid → cannot create.
- `concurrent_vms.remaining == 0` or `sandboxes_hourly.remaining == 0` → blocked by live rate-limit quota; `reset` gives the hourly refill time. This is the "quota expiration" the user cares about, and it is fully knowable.
- both remaining counters `> 0` → capacity quota is free; token can create a VM right now from a rate-limit standpoint.

Important limitation: a `remaining > 0` result means rate-limit capacity is free, but the SDK does **not** reveal whether the account still has billable credit balance. A token could pass both rate-limit checks and still fail at `createSandbox()`/`startVm()` if it ran out of paid credits. That credit-balance failure is only observable at creation time, not through any status call.

### Recommended status response

For a valid token with free rate-limit capacity and no active local session:

```json
{
  "provider": "codesandbox",
  "status": "AVAILABLE",
  "availability": {
    "canCreateSession": true,
    "remainingCredits": null,
    "concurrentSessionsLimit": 10,
    "concurrentVmsRemaining": 9,
    "sandboxesHourlyRemaining": 49,
    "sandboxesHourlyResetAt": "2026-08-16T01:00:00.000Z",
    "localActiveSessions": 0
  },
  "details": {
    "validated": true,
    "referencePricing": {
      "Pico": { "creditsPerHour": 5 },
      "Nano": { "creditsPerHour": 10 },
      "Micro": { "creditsPerHour": 20 },
      "Small": { "creditsPerHour": 40 },
      "Medium": { "creditsPerHour": 80 },
      "Large": { "creditsPerHour": 160 },
      "XLarge": { "creditsPerHour": 320 }
    },
    "limitations": [
      {
        "field": "remainingCredits",
        "reason": "The SDK exposes live rate-limit headroom (concurrent_vms, sandboxes_hourly, requests_hourly) but no account credit-balance field. A token can pass these checks and still fail at VM creation if paid credits are exhausted."
      }
    ]
  }
}
```

For a valid token with exhausted live rate-limit quota:

```json
{
  "provider": "codesandbox",
  "status": "QUOTA_EXHAUSTED",
  "availability": {
    "canCreateSession": false,
    "concurrentVmsRemaining": 0,
    "sandboxesHourlyRemaining": 0,
    "sandboxesHourlyResetAt": "2026-08-16T01:00:00.000Z"
  },
  "details": {
    "reason": "CodeSandbox live rate-limit quota is exhausted; next refill time is in sandboxesHourlyResetAt."
  }
}
```

For a valid token that already has a non-terminal local session:

```json
{
  "provider": "codesandbox",
  "status": "LIMITED",
  "availability": {
    "localActiveSessions": 1,
    "canCreateNewSession": false
  },
  "details": {
    "reason": "This orchestrator enforces one active CodeSandbox session per token and will reuse the existing session."
  }
}
```

For an expired, revoked, or unauthorized token:

```json
{
  "provider": "codesandbox",
  "status": "INVALID",
  "availability": {
    "canCreateSession": false
  },
  "details": {
    "reason": "getMetaInfo() returned 401/403: token expired, revoked, or lacks required scopes."
  }
}
```

### Implementation notes

- `getMetaInfo()` is the primary live quota signal and also serves as the token-validity check; a `401`/`403` maps to `INVALID`, while a successful `rate_limits` block drives the `AVAILABLE` vs `QUOTA_EXHAUSTED` decision.
- `concurrentSessionsLimit` can be populated from `concurrent_vms.limit` (live) when present, falling back to the documented free-plan default of 10 concurrent VMs.
- The free-plan concurrent VM limit is a provider reference default; the live `concurrent_vms.limit` from the API is authoritative when returned.
- The local one-session-per-token rule may still block new sessions even when CodeSandbox's upstream quota is free; report it as `LIMITED` separately from provider quota.
- Credit balance is intentionally reported as `null` with a limitation reason because the SDK does not expose it.

## 5.3 GitHub Codespaces (`codespaces`)

### Free-tier and availability model

GitHub Codespaces billing documentation describes included monthly usage for personal accounts:

- GitHub Free personal accounts: 15 GB-month storage and 120 core-hours of compute per month.
- GitHub Pro personal accounts: 20 GB-month storage and 180 core-hours of compute per month.
- Organizations and enterprises: no free quota by default.

> [!IMPORTANT]
> "120 hours" isn't always 120 clock hours. Included compute is measured in **core-hours**, not wall-clock hours.
>
> Codespaces uses core-hours. For example:
>
> - 2-core machine running 10 hours → 20 core-hours
> - 4-core machine running 10 hours → 40 core-hours
> - 8-core machine running 10 hours → 80 core-hours
>
> So if you're using a 4-core Codespace, your 120-core-hour allowance is roughly 30 hours of actual runtime. Any implementation surfacing `includedMonthlyComputeHours` must treat the value as core-hours and must not present it as wall-clock runtime without dividing by the machine's core count.

Billing model:

- Compute is billed by core-hour and varies by machine type/core count.
- Storage is measured in GB-hours and billed as GB-month.
- If no valid payment method exists, usage stops after included quota is consumed.
- If payment is configured, budgets can cap spending.
- Once quota or budget is exhausted, billable codespaces cannot be created or resumed.

This project's implementation diverges from normal create flows: it adopts the first existing codespace for a token and never creates a new codespace. Therefore, availability must include whether the credential has an existing codespace that can be adopted.

### Credential validation options

GitHub PATs can be validated through documented REST calls already used by the project:

- `GET /user` to validate token identity.
- `GET /user/codespaces` to list available codespaces for the authenticated user.
- `GET /user/codespaces/{codespace_name}` to inspect a specific codespace.

The project also uses `gh codespace ssh` for command execution with per-spawn `GH_TOKEN`, but credential status checks should prefer REST API validation and should not SSH into the VM.

### Programmatic usage and remaining availability

GitHub exposes Codespaces runtime state through the Codespaces API. This can determine whether a token has adoptable environments and whether they are available, stopped, starting, or failed.

Billing API support is less uniform:

- GitHub has REST billing endpoints, but exact Codespaces billing endpoint availability, response fields, and required permissions depend on current GitHub API version, account owner type, and token permissions.
- User-level or owner-level billing data may require account owner privileges and may not be accessible from a normal codespaces-scoped PAT.

### Billing usage from the command line / REST API

GitHub provides a billing usage REST API that can be queried and filtered for Codespaces entries. GitHub documents this endpoint as currently being in **public preview**, so fields and availability may change:

```bash
gh api \
  -H "X-GitHub-Api-Version: 2026-03-10" \
  /users/YOUR_USERNAME/settings/billing/usage/summary
```

Then look for entries where:

- `product = Codespaces`

This gives programmatic access to actual usage (including Codespaces compute and storage line items) instead of relying only on static included-quota references. For the orchestrator's credential status check, the same call can be made with the loaded PAT through the existing fetch-based `codespaces/client.js` (equivalent to the `gh api` invocation above), keeping it read-only and best-effort.

Because of this, the implementation should treat billing usage as optional:

- Attempt billing usage calls (for example, the public-preview `/users/{username}/settings/billing/usage/summary` endpoint) only when the token has appropriate permissions and the owner context is known.
- Return live usage fields only when the API response includes them, and interpret compute values as core-hours.
- Otherwise, return static included-usage reference limits plus limitation reasons.

### Recommended status response

For a valid token with at least one adoptable codespace:

```json
{
  "provider": "codespaces",
  "status": "AVAILABLE",
  "availability": {
    "adoptableCodespaces": 1,
    "activeLocalSessions": 0,
    "includedMonthlyComputeHours": 120,
    "includedStorageGbMonth": 15,
    "remainingHours": null,
    "storageUsedGbMonth": null
  },
  "details": {
    "validated": true,
    "adoptFlow": "This project adopts an existing codespace and does not create a new one.",
    "limitations": [
      {
        "field": "includedMonthlyComputeHours",
        "reason": "Included compute is measured in core-hours, not clock hours; actual runtime depends on the codespace machine's core count (e.g., a 4-core machine gets roughly 30 clock hours out of a 120 core-hour allowance)."
      },
      {
        "field": "remainingHours",
        "reason": "Codespaces billing usage requires billing API permissions and may not be available for every token or account type."
      }
    ]
  }
}
```

For a valid token with no existing codespaces:

```json
{
  "provider": "codespaces",
  "status": "UNAVAILABLE",
  "availability": {
    "adoptableCodespaces": 0,
    "canCreateSession": false
  },
  "details": {
    "reason": "This orchestrator uses adopt-don't-create behavior. The GitHub account must already have a codespace before a session can be created."
  }
}
```

For a valid token where billing indicates quota or budget exhaustion:

```json
{
  "provider": "codespaces",
  "status": "QUOTA_EXHAUSTED",
  "availability": {
    "canCreateOrResumeCodespace": false
  },
  "details": {
    "reason": "GitHub reports that included usage or configured budget is exhausted."
  }
}
```

Only return the `QUOTA_EXHAUSTED` state when the GitHub API response clearly supports that conclusion.

### Implementation notes

- The existing `codespaces/client.js` read cache can inspire a short-lived credential-status cache, but credential status may need separate cache keys and TTLs.
- The status API should include local database state because the unique active token index can limit new sessions even when GitHub itself still has capacity.
- Billing checks should be best-effort and must gracefully degrade to `UNKNOWN` fields.
- Permission errors from billing endpoints should not make the whole credential invalid if the token can still list/adopt codespaces.
- When surfacing remaining compute, keep raw core-hours authoritative; if a wall-clock runtime estimate is derived (core-hours ÷ machine core count), label it clearly as an estimate based on the adopted codespace's machine size.

## 6. Cross-Provider Status Model

Recommended normalized fields:

```json
{
  "provider": "codespaces",
  "credentialRef": "codespaces/account-a.txt",
  "credentialFingerprint": "sha256:...",
  "status": "AVAILABLE",
  "checkedAt": "2026-08-16T00:00:00.000Z",
  "expiresAt": null,
  "availability": {
    "canCreateSession": true,
    "canExecuteCommands": true,
    "remainingHours": null,
    "remainingCredits": null,
    "usedMinutes": null,
    "includedMinutes": null,
    "storageUsedGbMonth": null,
    "storageLimitGbMonth": null,
    "concurrentSessionsLimit": null,
    "localActiveSessions": 0,
    "providerActiveSessions": null
  },
  "details": {
    "validated": true,
    "providerState": null,
    "referenceLimits": {},
    "limitations": []
  }
}
```

Recommended status enum:

| Status | Meaning |
| :--- | :--- |
| `AVAILABLE` | Credential validated and provider appears able to support the relevant session action. |
| `LIMITED` | Credential is valid, but local constraints or known provider capacity limits restrict new sessions. |
| `UNAVAILABLE` | Credential may be valid, but required provider resources are missing or inaccessible. |
| `INVALID` | Credential is malformed, revoked, unauthorized, or rejected by authentication. |
| `EXPIRED` | Credential clearly expired and cannot be refreshed automatically. |
| `QUOTA_EXHAUSTED` | Upstream API clearly reports exhausted usage, quota, spending limit, or capacity. |
| `UNKNOWN` | The check could not determine provider availability due to unsupported fields or transient errors. |

## 7. Data Availability Matrix

| Provider | Validate Credential | Live Session/Resource Availability | Remaining Hours/Credits | Static Free-Tier Reference | Recommended Confidence |
| :--- | :--- | :--- | :--- | :--- | :--- |
| GCS | Yes, through Google auth and Cloud Shell API calls | Partial, environment state is available | Not documented in Cloud Shell REST API | 50 hours/week, 5 GB persistent disk | Medium for credential validity, low for remaining quota |
| CodeSandbox | Yes, through `getMetaInfo()` auth check (401/403 means expired/revoked) | Yes, `getMetaInfo()` exposes live `concurrent_vms`, `sandboxes_hourly`, and `requests_hourly` remaining/limit/reset; `listRunningVms()` exposes live concurrent VM count vs limit | Credit balance not exposed; rate-limit headroom is live and answers "can I create now?" | 10 concurrent VMs on Build free, VM credit rates by tier | High for token validity + live rate-limit headroom, low for credit balance |
| Codespaces | Yes, through GitHub REST API | Yes, list/get codespaces exposes existing resources and states | Optional/best-effort via billing usage summary endpoint (`/users/{username}/settings/billing/usage/summary`, public preview) when accessible; compute is measured in core-hours, not clock hours | Personal Free: 120 core-hours + 15 GB-month; Pro: 180 core-hours + 20 GB-month (core-hours, not wall-clock runtime) | High for token/resource state, medium/low for billing depending on permissions |

## 8. Recommended Implementation Strategy

1. Add a provider credential status service that dispatches to provider-specific checkers.
2. Reuse existing credential loaders to resolve and fingerprint credential refs.
3. Add a short TTL cache keyed by provider + credential fingerprint.
4. Include local database state in every status response, especially active sessions by credential fingerprint.
5. Implement GCS validation first with explicit unknown remaining quota fields.
6. Implement Codespaces validation with REST calls for `/user` and `/user/codespaces`, plus optional billing API probes that degrade gracefully.
7. Implement CodeSandbox validation with `API.getMetaInfo()` for token validity and live rate-limit headroom (`concurrent_vms`, `sandboxes_hourly`, `requests_hourly`), plus local active-session detection; keep credit balance unknown.
8. Keep credential listing and status checking separate unless clients explicitly request status checks, because status checks call upstream provider APIs.

## 9. Risks and Gaps

- Provider docs can change, especially billing APIs and free-tier values.
- Billing visibility often requires broader permissions than session management. A credential can be valid for VM operations but unable to read billing details.
- Remaining usage can change immediately after a status check, so the API should describe status as advisory.
- UI-only quota data must not be scraped; scraping would be brittle and may violate provider terms.
- Static free-tier values should be treated as documentation references, not account-specific guarantees.
- Existing credential caches without TTL can make rotated credentials appear valid until process restart unless status checks bypass or invalidate stale cache entries.

## 10. Conclusion

A credential status feature is valuable, but it must clearly separate:

- Credential validity.
- Provider resource availability.
- Local orchestrator constraints.
- Static documented free-tier limits.
- Live remaining quota or credit values.

For the current providers, the safest normalized API should report exact live values only when the provider exposes them through documented APIs. Otherwise, it should return `null` for unavailable measurements and include an explicit limitation reason. This avoids misleading users while still making credential selection much more transparent than the current file-list-only behavior.
