# Story: LAB-009 - Provider Credential Status and Availability

## 1. Jira Story

- Story Key: `LAB-009`
- Type: `Story`
- Priority: `Medium`
- Component: `API / Provider Abstraction / Credentials`
- Labels: `credentials`, `providers`, `quota`, `billing`, `availability`

## 2. User Story

As a user, I want to know the status of the credentials for each supported provider, including whether a credential is available, expired, invalid, or capacity-limited, so I can choose a provider that can still create or run a VM session.

## 3. Goal

Add provider-level credential availability reporting to the orchestrator.

The API should let clients:
- List credentials for each provider with a normalized status.
- Distinguish usable credentials from invalid, expired, revoked, unavailable, or quota-exhausted credentials.
- See provider-specific availability details when the upstream platform exposes them, such as remaining included hours, credit usage, storage usage, spending-limit state, concurrent VM capacity, or last validation time.
- Understand when a provider cannot expose remaining time or credit information through a public API.

The core of the contract is a flat, normalized quota report per credential:

- `provider`: provider identifier (`gcs`, `codesandbox`, `codespaces`).
- `credential`: credential name (file name or alias).
- `quotaUnit`: the unit the quota is measured in (hours, core-hours, credits, currency, counts, GB-month, etc.).
- `quotaPeriod`: the period the quota resets over (day, week, month, billing cycle, or none for instantaneous limits).
- `usage`: how much has been consumed so far in that unit/period.

## 4. Background

The project currently lists credential files for Google Cloud Shell, CodeSandbox, and GitHub Codespaces. These list endpoints primarily show which credential files exist; they do not validate whether each credential can still provision or manage a remote VM session.

Provider availability is not uniform:
- Google Cloud Shell documents a weekly free usage quota, but the public Cloud Shell API does not document a remaining-hours field.
- CodeSandbox documents VM credit rates and free-plan concurrent VM limits, but the public SDK documentation does not expose remaining credits or account balance fields.
- GitHub Codespaces documents included monthly compute/storage for personal accounts and exposes some runtime/session state through the Codespaces API. Billing/usage visibility depends on account type, permissions, and GitHub billing APIs.

This story should introduce a normalized contract that can represent both exact availability data and explicitly unknown data.

## 5. Problem Statement

Current behavior:
- Users can list credential files for GCS, CodeSandbox, and Codespaces.
- Users cannot tell if a listed credential is valid before attempting session creation.
- Users cannot tell whether a provider account is expired, revoked, out of free-tier capacity, or blocked by billing/quota constraints.
- Availability details are not normalized across providers.

Required behavior:
- Users can query credential status per provider.
- Each credential returns a clear status and provider-specific evidence.
- Quota consumption is reported in a normalized shape: quota unit, quota period, and usage, so clients can render any provider without provider-specific parsing.
- A single credential can report multiple quota dimensions when the provider meters more than one resource (for example, Codespaces compute core-hours plus storage GB-month).
- The API should not fabricate remaining hours or credits when upstream APIs do not expose them; `usage` is `null` with an explanatory limitation instead.
- Existing session creation and credential listing behavior must remain backward compatible.

## 6. Scope

In scope:
- Add a normalized credential status model shared by providers.
- Add one or more API endpoints for provider credential status checks.
- Validate credentials by calling provider-specific low-impact APIs.
- Return provider-specific availability details when available.
- Return `unknown` detail fields with explanatory reasons when remaining quota, credits, or expiration cannot be determined.
- Cache status checks for a short configurable TTL to avoid excessive upstream API calls.
- Avoid exposing raw token values, private keys, or sensitive account identifiers.
- Document provider-specific limitations.

Out of scope:
- Purchasing credits, upgrading plans, changing billing settings, or requesting quota increases.
- Creating new Codespaces from this story.
- Guaranteeing a future session can be created after a status check; upstream quota and billing state can change between check and create.
- Provider UI scraping to obtain data not exposed through documented APIs.

## 7. Functional Requirements

1. The API must expose credential status checks for all current provider identifiers: `gcs`, `codesandbox`, and `codespaces`.
2. The API must support checking a single credential reference and listing the status of all discovered credentials for a provider.
3. The status response must use a normalized top-level status enum.
4. Supported normalized statuses must include at least:
   - `AVAILABLE`
   - `UNAVAILABLE`
   - `INVALID`
   - `EXPIRED`
   - `QUOTA_EXHAUSTED`
   - `LIMITED`
   - `UNKNOWN`
5. The response must include `provider`, `credential` (file name or alias), `credentialFingerprint` when available, `status`, `checkedAt`, and `quotas[]`.
6. The response must include `expiresAt` only when the provider exposes or the token format safely encodes an expiration time.
7. The response must include quota entries (`quotas[]` with `quotaUnit`, `quotaPeriod`, `usage`) for measurable capacity, such as remaining hours, used minutes, credits, storage, concurrent VM capacity, or account/billing state.
8. Availability fields that cannot be measured must be returned as `null` with a `reason` in `details.limitations`.
9. Status checks must not create new provider VM sessions.
10. Status checks must not execute arbitrary user commands in existing remote VMs.
11. Provider implementations must use low-impact validation calls:
    - GCS: validate credentials and call Cloud Shell environment/account APIs only as needed.
    - CodeSandbox: instantiate the SDK client and call a safe account/sandbox listing or token validation operation if exposed by the SDK.
    - Codespaces: validate the token with GitHub API calls such as user/codespaces listing and optional billing endpoints when permissions allow.
12. Errors must be translated into safe provider error codes without exposing secrets.
13. Status checks must be cacheable by provider and credential fingerprint.
14. The cache TTL must be configurable and default to a short duration, such as 5 minutes.
15. The implementation must preserve existing credential list endpoints and session lifecycle behavior.
16. Each credential entry must report quota information as one or more quota entries, each containing at minimum: `quotaUnit`, `quotaPeriod`, and `usage`.
17. `usage` must be a number when the upstream source exposes consumption, or `null` with an entry in `details.limitations` when it cannot be determined.
18. Providers metering multiple resources must return one quota entry per resource (for example, Codespaces compute plus storage).
19. Instantaneous or non-renewing limits (for example, concurrent VM capacity) must use `quotaPeriod: null` rather than a fake period.
20. Units must use normalized names: `hours`, `core-hours`, `credits`, `currency`, `GB-month`, `count` — not provider-specific strings.

## 8. Proposed API Surface

### 8.1 List Provider Credential Status

```http
GET /api/v1/sessions/{provider}/credentials/status
```

Alternative route if provider-specific endpoints remain grouped by provider name:

```http
GET /api/v1/sessions/credentials/status?provider=codespaces
```

Example response:

```json
{
  "provider": "codespaces",
  "credentials": [
    {
      "provider": "codespaces",
      "credential": "codespaces/account-a.txt",
      "credentialFingerprint": "sha256:...",
      "status": "AVAILABLE",
      "checkedAt": "2026-08-16T00:00:00.000Z",
      "expiresAt": null,
      "quotas": [
        {
          "quotaUnit": "core-hours",
          "quotaPeriod": "month",
          "usage": 13.6,
          "limit": 120,
          "remaining": 106.4
        },
        {
          "quotaUnit": "GB-month",
          "quotaPeriod": "month",
          "usage": 0.4,
          "limit": 15,
          "remaining": 14.6
        }
      ],
      "details": {
        "accountType": "personal",
        "billingState": "within_included_usage",
        "limitations": [
          {
            "field": "quotas[0].usage",
            "reason": "Usage comes from the public-preview billing usage summary endpoint and requires billing permissions; it is null when inaccessible."
          }
        ]
      }
    }
  ]
}
```

> [!NOTE]
> Codespaces included compute is metered in **core-hours**, not wall-clock hours. A 4-core machine consumes the 120 core-hour allowance in roughly 30 hours of runtime.

### 8.2 Check One Credential

```http
GET /api/v1/sessions/{provider}/credentials/status/{credentialRef}
```

Because credential refs may contain slashes, the final route design may prefer a query parameter:

```http
GET /api/v1/sessions/{provider}/credentials/status?credentialRef=codespaces/account-a.txt
```

## 9. Normalized Response Model

Each credential entry is shaped around five core fields — `provider`, `credential`, `quotaUnit`, `quotaPeriod`, `usage` — grouped in a `quotas[]` array because one credential can meter several resources:

```json
{
  "provider": "gcs",
  "credential": "google/account-a.json",
  "credentialFingerprint": "sha256:...",
  "status": "UNKNOWN",
  "checkedAt": "2026-08-16T00:00:00.000Z",
  "expiresAt": null,
  "quotas": [
    {
      "quotaUnit": "hours",
      "quotaPeriod": "week",
      "usage": null,
      "limit": 50,
      "remaining": null
    }
  ],
  "details": {
    "validated": true,
    "limitations": [
      {
        "field": "quotas[0].usage",
        "reason": "Cloud Shell documents the weekly quota in the UI, but the Cloud Shell REST API does not expose used or remaining hours."
      }
    ]
  }
}
```

Field rules:
- `credential`: file name or alias of the credential (the value previously called `credentialRef`; `credentialFingerprint` remains for uniqueness).
- `usage`: consumed amount so far, in `quotaUnit` over `quotaPeriod`. Number or `null`.
- `limit` / `remaining`: optional. Included only when a documented limit exists (`limit`) or when usage plus a known limit allows derivation (`remaining = limit − usage`).
- `quotaPeriod`: `day` | `week` | `month` | `billing-cycle` | `hourly-window` | `null` for instantaneous limits.
- `quotaUnit`: normalized names only: `hours`, `core-hours`, `credits`, `currency`, `GB-month`, `count`.

### Per-provider quota mapping

| Provider | quotaUnit | quotaPeriod | usage source | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `gcs` | `hours` | `week` | `null` (UI-only; not exposed by REST API) | `limit: 50` is the documented weekly default |
| `codesandbox` | `credits` | `billing-cycle` | `null` (SDK exposes no balance) | Runtime burn rate by VM tier goes in `details.referencePricing` |
| `codesandbox` | `count` | `hourly-window` | derived as `limit − rate_limits.sandboxes_hourly.remaining` | Live from `getMetaInfo()`; `resetAt` in entry details |
| `codesandbox` | `count` | `null` (instantaneous) | derived as `limit − rate_limits.concurrent_vms.remaining` | Live concurrent-VM headroom |
| `codespaces` | `core-hours` | `month` | billing usage summary endpoint (`product = Codespaces`), public preview | `null` without billing permissions; core-hours, not clock hours |
| `codespaces` | `GB-month` | `month` | billing usage summary endpoint, public preview | Same permission caveats |

Local orchestrator state stays outside `quotas[]`: active session counts and the one-session-per-token constraint surface as `status: LIMITED` with `details.localActiveSessions`.

## 10. Provider-Specific Acceptance Criteria

### 10.1 Google Cloud Shell

- Given a valid Google credential file, when the user checks credential status, then the API validates that the credential can call Google APIs required by the GCS provider.
- The response must include `status: AVAILABLE` when credentials are valid and Cloud Shell APIs respond successfully.
- The response must include a `quotas[]` entry with `quotaUnit: "hours"`, `quotaPeriod: "week"`, `usage: null`, and `limit: 50`, with a limitation reason for the null usage unless a documented API source for remaining Cloud Shell quota is implemented.
- The response must include documented static limits in `details.referenceLimits`, including the 5 GB persistent disk limit.
- Invalid, revoked, or malformed credentials must return `INVALID` or `EXPIRED` when the provider error clearly identifies that state.

### 10.2 CodeSandbox

- Given a valid CodeSandbox token, when the user checks credential status, then the API validates the token through the SDK `API.getMetaInfo()` (`GET /meta/info`) or a documented safe API call.
- The response must include `status: INVALID` when `getMetaInfo()` returns `401`/`403`, because that means the token is expired, revoked, or lacks required scopes.
- The response must include `status: AVAILABLE` when the token is valid and live rate-limit headroom is free (`concurrent_vms.remaining > 0` and `sandboxes_hourly.remaining > 0`).
- The response must include `status: QUOTA_EXHAUSTED` when `getMetaInfo()` succeeds but `concurrent_vms.remaining == 0` or `sandboxes_hourly.remaining == 0`, and must include the hourly `reset` time in the affected quota entry's details (`resetAt`) when present.
- The response must include live rate-limit headroom from `getMetaInfo().rate_limits` as quota entries: an `hourly-window` `count` entry derived from `sandboxes_hourly` (with the hourly `reset` time in entry details) and an instantaneous `count` entry derived from `concurrent_vms`.
- The response must include documented credit rates by VM tier in `details.referencePricing`.
- The response must not claim exact remaining credits; the SDK exposes no credit-balance field, so the `credits` / `billing-cycle` quota entry must have `usage: null` with a limitation reason. A token can pass all live quota checks and still fail at VM creation if paid credits are exhausted, so the API must not imply a credit-balance guarantee.
- If the selected token already has an active orchestrator session, the response should include local `activeSessions` and mark status as `LIMITED` when the existing one-session-per-token constraint prevents creating another session.

### 10.3 GitHub Codespaces

- Given a valid GitHub token, when the user checks credential status, then the API validates the token by calling GitHub user and codespaces endpoints.
- The response must include whether at least one existing codespace is available to adopt, because this project follows an adopt-don't-create flow.
- If no codespace can be adopted, the response should return `UNAVAILABLE` or `LIMITED` with a detail explaining that a codespace must exist before session creation.
- The response should include local active session count for the credential fingerprint.
- When GitHub billing APIs are accessible with the token and account type, the response should include available billing/usage fields such as included minutes, paid minutes, or storage usage.
- When billing APIs are inaccessible or do not expose remaining usage for the token, the response must include the compute quota entry with `usage: null` and a limitation reason.
- When billing data is accessible, compute must be reported as a `core-hours` / `month` quota entry (never wall-clock hours) and storage as `GB-month` / `month`.
- Token permission failures must map to `INVALID` or `UNAVAILABLE` depending on whether authentication or authorization failed.

## 11. Non-Functional Requirements

- Status checks must avoid high-cost or state-changing provider operations.
- Status checks must redact tokens and private key material from logs and responses.
- Upstream provider failures must include actionable but safe error details.
- The endpoint must be resilient to partial failures when listing multiple credentials; one invalid credential must not prevent other credentials from being reported.
- Provider adapters should implement a shared method such as `getCredentialStatus(options)` or a separate credential-status service should dispatch through provider-specific checkers.
- Tests should cover malformed credentials, invalid tokens, unavailable providers, unknown quota fields, and cache behavior.

## 12. Open Questions

1. Should credential status be exposed under the existing session routes or under a new `/api/v1/credentials/status` route?
2. Should status checks run automatically when listing credential files, or only when explicitly requested?
3. Should cached status survive process restarts, or is in-memory caching enough?
4. Should Codespaces billing checks support organization/enterprise owners, or only personal accounts initially?
5. Should static provider reference limits be included in every response, or only in provider metadata/discovery?
6. The `credential` field accepts a file name or alias. Should the orchestrator introduce an alias registry (mapping friendly names to credential refs), or should aliases be deferred and `credential` always carry the file name/ref for now?
