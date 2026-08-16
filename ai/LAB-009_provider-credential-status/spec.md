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
- The API should not fabricate remaining hours or credits when upstream APIs do not expose them.
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
5. The response must include `provider`, `credentialRef`, `credentialFingerprint` when available, `status`, `checkedAt`, and `details`.
6. The response must include `expiresAt` only when the provider exposes or the token format safely encodes an expiration time.
7. The response must include `availability` fields for measurable capacity, such as remaining hours, used minutes, credits, storage, concurrent VM capacity, or account/billing state.
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
      "credentialRef": "codespaces/account-a.txt",
      "credentialFingerprint": "sha256:...",
      "status": "AVAILABLE",
      "checkedAt": "2026-08-16T00:00:00.000Z",
      "expiresAt": null,
      "availability": {
        "remainingHours": null,
        "remainingCredits": null,
        "usedIncludedMinutes": 42,
        "includedMinutes": 7200,
        "storageUsedGbMonth": 0.4,
        "concurrentSessionsLimit": null,
        "activeSessions": 1
      },
      "details": {
        "accountType": "personal",
        "billingState": "within_included_usage",
        "limitations": [
          {
            "field": "remainingHours",
            "reason": "GitHub billing APIs may expose used minutes but do not guarantee a normalized remaining-hours field for every token/account type."
          }
        ]
      }
    }
  ]
}
```

### 8.2 Check One Credential

```http
GET /api/v1/sessions/{provider}/credentials/status/{credentialRef}
```

Because credential refs may contain slashes, the final route design may prefer a query parameter:

```http
GET /api/v1/sessions/{provider}/credentials/status?credentialRef=codespaces/account-a.txt
```

## 9. Normalized Response Model

```json
{
  "provider": "gcs",
  "credentialRef": "google/account-a.json",
  "credentialFingerprint": "sha256:...",
  "status": "UNKNOWN",
  "checkedAt": "2026-08-16T00:00:00.000Z",
  "expiresAt": null,
  "availability": {
    "canCreateSession": null,
    "remainingHours": null,
    "remainingCredits": null,
    "usedMinutes": null,
    "includedMinutes": null,
    "storageUsedGbMonth": null,
    "concurrentSessionsLimit": null,
    "concurrentVmsRemaining": null,
    "sandboxesHourlyRemaining": null,
    "sandboxesHourlyResetAt": null,
    "activeSessions": null
  },
  "details": {
    "validated": true,
    "limitations": [
      {
        "field": "remainingHours",
        "reason": "Cloud Shell documents quota in the UI but the Cloud Shell REST API does not document a remaining-hours response field."
      }
    ]
  }
}
```

## 10. Provider-Specific Acceptance Criteria

### 10.1 Google Cloud Shell

- Given a valid Google credential file, when the user checks credential status, then the API validates that the credential can call Google APIs required by the GCS provider.
- The response must include `status: AVAILABLE` when credentials are valid and Cloud Shell APIs respond successfully.
- The response must include `remainingHours: null` with a limitation reason unless a documented API source for remaining Cloud Shell quota is implemented.
- The response must include documented static limits in `details.referenceLimits`, including the default 50-hour weekly Cloud Shell quota and 5 GB persistent disk limit.
- Invalid, revoked, or malformed credentials must return `INVALID` or `EXPIRED` when the provider error clearly identifies that state.

### 10.2 CodeSandbox

- Given a valid CodeSandbox token, when the user checks credential status, then the API validates the token through the SDK `API.getMetaInfo()` (`GET /meta/info`) or a documented safe API call.
- The response must include `status: INVALID` when `getMetaInfo()` returns `401`/`403`, because that means the token is expired, revoked, or lacks required scopes.
- The response must include `status: AVAILABLE` when the token is valid and live rate-limit headroom is free (`concurrent_vms.remaining > 0` and `sandboxes_hourly.remaining > 0`).
- The response must include `status: QUOTA_EXHAUSTED` when `getMetaInfo()` succeeds but `concurrent_vms.remaining == 0` or `sandboxes_hourly.remaining == 0`, and must include the hourly `reset` time in `availability.sandboxesHourlyResetAt` when present.
- The response must include live rate-limit headroom from `getMetaInfo().rate_limits` in `availability`: `concurrentSessionsLimit` (from `concurrent_vms.limit`), `concurrentVmsRemaining`, `sandboxesHourlyRemaining`, and `sandboxesHourlyResetAt`.
- The response must include documented credit rates by VM tier in `details.referencePricing`.
- The response must not claim exact remaining credits; the SDK exposes no credit-balance field, so `remainingCredits` must be `null` with a limitation reason. A token can pass all live quota checks and still fail at VM creation if paid credits are exhausted, so the API must not imply a credit-balance guarantee.
- If the selected token already has an active orchestrator session, the response should include local `activeSessions` and mark status as `LIMITED` when the existing one-session-per-token constraint prevents creating another session.

### 10.3 GitHub Codespaces

- Given a valid GitHub token, when the user checks credential status, then the API validates the token by calling GitHub user and codespaces endpoints.
- The response must include whether at least one existing codespace is available to adopt, because this project follows an adopt-don't-create flow.
- If no codespace can be adopted, the response should return `UNAVAILABLE` or `LIMITED` with a detail explaining that a codespace must exist before session creation.
- The response should include local active session count for the credential fingerprint.
- When GitHub billing APIs are accessible with the token and account type, the response should include available billing/usage fields such as included minutes, paid minutes, or storage usage.
- When billing APIs are inaccessible or do not expose remaining usage for the token, the response must include `remainingHours: null` with a limitation reason.
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
