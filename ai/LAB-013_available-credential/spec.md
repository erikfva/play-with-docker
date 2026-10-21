# LAB-013: Available Credential Selection

**Issue Type**: Story
**Priority**: Medium
**Component**: VPS Management API, Credential Status, Provider System
**Labels**: vps, credentials, availability, providers, selection
**Epic**: Multi-Provider VM Orchestration

> **Origin**: original request — *"implement a new function `getAvailableCredential` to return the best
> credential candidate for the provider; as default return the first available (not in use) credential
> based on its information, for the codespaces add to the selection the credential with more Codespaces
> compute (core-hours)."*

> **Scope note**: only credentials registered in the database (the VPS registry) are considered.
> File-backed / S3 credentials are **out of scope** for this story.

---

## Summary

The system must be able to answer "which credential should I use for provider X right now?" in a single
call, instead of making a caller fetch the credential inventory, interpret each credential's status,
filter out dead and busy credentials, and rank them itself.

The capability has two parts:

1. **A selection function** — `getAvailableCredential(provider)`, returning the single best credential
   candidate for a provider.
2. **An HTTP endpoint** — exposing the same selection to API consumers.

Default behaviour is **first available**: the earliest-registered credential that is neither dead nor
in use. For Codespaces, capacity participates in the ranking: the credential with the **most remaining
Codespaces compute (core-hours)** wins.

---

## Background

Credentials for the `gcs`, `codesandbox` and `codespaces` providers are registered in the VPS registry
and each carries:

- a **name** (the reference callers pass when launching a session),
- a **fingerprint** identifying the underlying token/key,
- a **persisted status** from the last provider check, including quota information (usage, limit,
  remaining) and the time of the check.

Two facts drive selection:

- **One-session-per-token providers**: for Codesandbox and Codespaces a credential already backing a
  live session cannot be handed out again — a launch would be rejected. GCS has no such constraint, but
  selection still excludes a credential with a running session, so one credential is never chosen twice
  while in use.
- **Codespaces accounts have a monthly compute allowance measured in core-hours.** An account can be
  valid and still be close to exhaustion. Choosing by registration order alone routinely selects the
  worst candidate for this provider.

Today none of this is exposed as a decision. Inventory reads return every credential with its raw
status and require the consumer to replicate the filtering and ranking rules, and each consumer that
does so is another place for the rules to drift.

---

## Business Value

- **One call instead of N**: consumers get a usable answer without inventory fan-out or duplicating
  status-parsing logic.
- **Fewer failed launches**: dead and in-use credentials are skipped before a session is requested.
- **Better Codespaces capacity use**: ranking by remaining core-hours spreads consumption across
  accounts instead of burning the earliest-registered one until it is exhausted.
- **One place for the rule**: the definition of "available" stops being re-derived per consumer.

---

## Functional Requirements

### FR-1: Selection function

**As a** backend consumer
**I want** a function that returns the best usable credential for a provider
**So that** I do not have to re-implement filtering and ranking

**Acceptance Criteria**:

- A function `getAvailableCredential` accepts a provider identifier and returns one selection
  descriptor (FR-6) or fails with a well-defined error (FR-8).
- Supported providers: `gcs`, `codesandbox`, `codespaces`. The `pwd` stub provider is not selectable.
- Selection is a **read-only decision**: it does not call a provider API, does not refresh status, and
  does not modify credentials or sessions.
- Selection never returns secret material (tokens, key files, raw credential content).
- The result reports which strategy produced it, so the decision can be audited.

### FR-2: Source of truth

**Acceptance Criteria**:

- **Only credentials registered in the database are considered.** The VPS registry is the sole source of
  candidates for a provider; a credential that exists only as a file (local directory, S3FS mount, or S3
  object) is never selected, even when the registry holds no credential for that provider.
- Consequently, when the registry holds no credential for a provider, the result is "nothing available"
  (FR-8) — not a fallback to file-based credentials.
- Candidate ordering is **registration order** (oldest first, deterministic tiebreak). The default
  strategy is defined in terms of this order, so it must be stable across calls.

### FR-3: Eligibility — credentials that must not be selected

**Acceptance Criteria**:

- A credential whose persisted status is `INVALID`, `EXPIRED`, `QUOTA_EXHAUSTED` or `UNAVAILABLE` is
  **unusable** and must not be selected.
- A credential with **no status** (never checked) or `UNKNOWN` status is **not** excluded. Absence of a
  verdict is not a negative verdict.
- A credential is **in use** when a live (non-terminal) session is attached to it for the same
  provider. **In-use credentials are never selected, for any provider** — `gcs`, `codesandbox` and
  `codespaces` alike. There is no provider exempt from this rule.
- In-use detection uses the session-to-credential key each provider actually persists:
  - `codesandbox` / `codespaces` — `sessions.credentialFingerprint` matched against the credential's
    registry fingerprint.
  - `gcs` — GCS sessions do not persist a fingerprint, so the match is on `sessions.credentialRef`
    against the credential's registry name. For GCS the stored `credentialRef` is the registry name
    (it is written from the request's `credentialRef`).
- "Terminal" means the session can never be resumed; the exact status set is provider-specific and must
  agree with the rest of the system.
- A `LIMITED` status — recorded when a credential is consumed by a local active session — is an
  **in-use** signal, not an unusability signal. A credential must become eligible again once its
  session ends and its status is refreshed, without special handling.
- Only eligible candidates (`not in use` **and** `usable`) take part in ranking.

### FR-4: Default strategy — first available

**Acceptance Criteria**:

- For `gcs` and `codesandbox`, the selected credential is the first eligible candidate in registration
  order.
- The strategy is reported as `first-available`.

### FR-5: Codespaces strategy — most remaining compute

**Acceptance Criteria**:

- For `codespaces`, the selected credential is the eligible candidate with the **highest remaining
  Codespaces compute allowance in core-hours**.
- The allowance is read from the credential's persisted status; selection itself does not call GitHub.
- Remaining allowance is taken from the reported remaining value when present, otherwise derived as
  `limit − usage` (never negative).
- **Only a quota whose unit is `core-hours` participates in ranking.** Quotas in any other unit —
  including a quota whose name mentions compute but is metered in minutes, currency, or anything else —
  do not contribute, because ranking on a number in another unit would compare incomparable values. The
  storage quota (`GB-month`) is therefore excluded.
- A credential with no reported compute allowance remains eligible but ranks below any credential with
  a known positive allowance.
- Ties keep registration order.
- The strategy is reported as `max-core-hours`, together with the remaining value used for the
  decision.

### FR-6: Response contract

**Acceptance Criteria** — a successful selection returns:

```json
{
  "provider": "codespaces",
  "strategy": "max-core-hours",
  "credentialRef": "vm-manager232",
  "credential": "vm-manager232",
  "credentialFingerprint": "sha256:...",
  "status": "AVAILABLE",
  "statusCheckedAt": "2026-09-03T10:00:00.000Z",
  "inUse": false,
  "inUseKnown": true,
  "coreHoursRemaining": 106.4
}
```

| Field | Meaning |
|---|---|
| `provider` | Echo of the requested provider |
| `strategy` | `first-available` or `max-core-hours` |
| `credentialRef` | The reference a caller passes to launch a session with this credential |
| `credential` | Human-readable label for the credential |
| `credentialFingerprint` | Credential identity, or `null` when unknown |
| `status` | Status from the last provider check, or `null` when never checked |
| `statusCheckedAt` | When the status was last refreshed, or `null` |
| `inUse` | Whether the selected credential is attached to a live session (always `false` — an in-use credential is never selected) |
| `inUseKnown` | Whether in-use was evaluated for this provider; `true` for all currently supported providers (see Resolved Decisions) |
| `coreHoursRemaining` | Remaining Codespaces compute in core-hours, or `null` |

No secret material — tokens, key material, credential content — may appear in the response.

There is no `source` field: registry rows are the only selectable credentials (FR-2 / FR-7), so a source
discriminator would be a constant.

### FR-7: Database-only scope

**Acceptance Criteria**:

- Selection considers **only** credentials present in the VPS registry. File-backed credentials are not
  candidates in any circumstance.
- A credential stored as a file (local credentials directory, S3FS mount, or S3 object) is not selected
  even when the registry has no credential for that provider.
- This keeps every selection decision traceable to a registry row that carries a name, a fingerprint, and
  a persisted status — the three inputs the eligibility and ranking rules depend on.

### FR-8: Errors

**Acceptance Criteria**:

- Missing, empty, or unsupported provider → **400**, `VPS_INVALID_PARAM`.
- No eligible credential → **409**, `NO_AVAILABLE_CREDENTIAL`, with details describing the provider and
  how many credentials were considered, how many were in use, and how many were unusable.
- The 409 details carry a **reason** that distinguishes an empty registry from credentials that exist
  but are all excluded:
  - `NO_REGISTERED_CREDENTIALS` — the registry holds no credential at all for the provider (a
    deployment that never registered one). Diagnosable from the code alone.
  - `ALL_IN_USE_OR_UNUSABLE` — credentials exist but every one is in use, unusable, or both.
- Missing or invalid server authentication → **401** (standard API auth).

---

## API

`GET /api/v1/vps/available-credential?provider=gcs|codesandbox|codespaces`

- Requires the standard server authentication used by the rest of the API.
- Returns the FR-6 selection descriptor on success.
- Errors follow FR-8.
- Provider matching is exact (case-sensitive); unsupported values include `pwd`.

Example:

```
GET /api/v1/vps/available-credential?provider=codespaces
```

```json
{
  "provider": "codespaces",
  "strategy": "max-core-hours",
  "credentialRef": "vm-manager232",
  "credential": "vm-manager232",
  "credentialFingerprint": "sha256:...",
  "status": "AVAILABLE",
  "statusCheckedAt": "2026-09-03T10:00:00.000Z",
  "inUse": false,
  "inUseKnown": true,
  "coreHoursRemaining": 106.4
}
```

---

## Codespaces credentials in the frontend (`vm-manager`)

Selection must not invent its own notion of "compute left" — the number it ranks on is the same number
the operator already sees. This section records what the frontend displays today, so the selector's
core-hours figure stays consistent with it.

### Where it is displayed

**VPS Credentials page** (`src/app/vps/page.tsx`) — one table row per credential: provider badge, session
badge (`Active` / `Idle`), name + id, status column, created, actions.

The status column for `codespaces` renders, top to bottom:

1. **Inventory block** — the codespaces count on the account (e.g. `2 codespaces`), or
   `No codespaces (create one in GitHub first)` when the account has none, followed by one line per
   codespace showing its state badge and display name.
2. **Quota rings** — one ring per quota that has a computable percentage, filtered to the Codespaces
   compute quota and the Codespaces storage quota (`isCodespacesComputeQuota` / `isCodespacesStorageQuota`).
   Each ring shows the quota name, `usage / limit` in the quota's own unit, and `N core-hours left`.
3. **Checked timestamp** — when the persisted status was last refreshed.

Empty/unknown states: no status at all renders `Not checked`; status `UNKNOWN` renders the badge
`Could not determine`; a status with no computable quota renders the status badge plus
`No quota data` (and any quotas without a percentage as plain `usage / limit` lines).

**Template launch page** (`src/app/templates/[id]/page.tsx`) — the credential dropdown label appends a
capacity hint to each Codespaces credential: ` (NN% left)`, ` (exhausted)`, or
` (N core-hours remaining)` when the limit is unknown. The hint is derived from the **compute quota
only**; storage deliberately does not shift it, so the dropdown agrees with the compute ring on the
VPS page.

### How the displayed numbers are derived

| Displayed value | Derivation |
|---|---|
| Ring fill (percent **used**) | `usage / limit × 100`, clamped to 0–100. Requires a finite `usage` and a finite `limit > 0`; otherwise the quota is rendered without a ring and the credential shows `No quota data`. |
| Ring color | From **that quota's own state**, not the credential's roll-up status: red when the quota's `remaining ≤ 0` or the fill is ≥ 90%, amber at ≥ 70%, green below. This is deliberate — a credential can be `QUOTA_EXHAUSTED` because *storage* is spent while compute still has headroom, and painting the compute ring red would misattribute it. |
| `N core-hours left` | `remaining` when reported, else `limit − usage`. Shown with the quota's unit. A missing value renders as `—`. |
| Dropdown `(NN% left)` | `100 − round(percent used)` on the compute quota, so it is the exact complement of the compute ring. `(exhausted)` at ≤ 0%. |
| Dropdown `(N core-hours remaining)` | Used only when no percentage is computable but `remaining` and `limit` are known. |

### Definition of the compute (core-hours) quota

The frontend's display and the selector's ranking must agree on which quota is "the Codespaces compute
allowance". The canonical entry written by the status check is named `Codespaces compute (core-hours)`
with `quotaUnit: "core-hours"`, `quotaPeriod: "month"`.

- **Frontend match (display)** — the quota's `quotaUnit` or `name`, lowercased, contains `compute`, **or**
  contains both `core` and `hour`. This is the existing UI rule and is unchanged by this story.
- **Selection match (ranking)** — a quota participates only when its unit is `core-hours` (FR-5). The
  two matchers select the same entry today; the difference is deliberate (see Resolved Decisions).
- **Storage must never participate**: `Codespaces storage (GB-month)` (`quotaUnit: "GB-month"`) is a
  separate quota with its own ring; it never contributes to compute capacity or to ranking.
- **Value semantics**: the quota's `usage` is **month-to-date gross consumption**, not a duration.
  Consumption accrues at the machine's core-count multiplier — a 4-core machine depletes the allowance
  twice as fast as a 2-core machine — so remaining core-hours overstate possible clock runtime unless
  divided by core count.
- **Limit** is the plan's included monthly allowance: 120 core-hours on GitHub Free personal accounts,
  180 on Pro. Organization/enterprise accounts have no included allowance by default, so the limit is
  a reference figure there, not a hard cap.
- **Remaining** is `max(0, limit − usage)` as reported by the status check.

### Why this matters for selection

The frontend answers "how much is left?" as a **percentage used**; selection needs **absolute
remaining core-hours** to rank candidates (FR-5). Both derive from the same quota — today the loose and
strict matchers select the identical entry, so UI and ranking agree in practice. A credential the UI
shows as `(exhausted)` is excluded by FR-3's `QUOTA_EXHAUSTED` rule rather than by the ranking. And
ranking must not be influenced by the storage quota, since an account can be `(exhausted)` on storage
while still having compute capacity, and vice versa.

---

## User Stories

### US-1: Default selection is the first available, not-in-use credential

**As a** backend consumer
**I want** selection for CodeSandbox to return the earliest-registered credential that is not dead and
not attached to a live session
**So that** I get a working credential without inspecting the inventory myself

**Acceptance Criteria**:
- Returns the first eligible credential in registration order.
- Skips `INVALID`, `EXPIRED`, `QUOTA_EXHAUSTED`, `UNAVAILABLE`, and in-use credentials.
- Reports `strategy: "first-available"`.
- When every credential is filtered out, fails with 409 `NO_AVAILABLE_CREDENTIAL`.

### US-2: Codespaces prefers the account with the most compute left

**As a** system operator
**I want** Codespaces selection to rank by remaining compute (core-hours)
**So that** launches do not land on an account that is about to exhaust its monthly allowance

**Acceptance Criteria**:
- Returns the eligible credential with the highest remaining core-hours.
- Uses the compute allowance recorded by the last status check.
- Never calls GitHub itself; freshness is the caller's decision (the caller can refresh status first).
- Reports `strategy: "max-core-hours"` and the remaining value considered.
- Falls back to limit − usage when only those are reported.
- Credentials with an unreported allowance rank last among eligible candidates but remain selectable.

### US-3: An in-use GCS credential is skipped like any other

**As a** backend consumer
**I want** GCS selection to exclude a credential that already backs a live Cloud Shell session
**So that** one credential is not handed out twice while a session is still running

**Acceptance Criteria**:
- A GCS credential with a non-terminal session referencing it is **not selected**.
- In-use detection for GCS matches the session's stored credential reference against the credential's
  registry name, because GCS sessions do not persist a fingerprint.
- GCS credentials in `INVALID` / `EXPIRED` / `UNAVAILABLE` are also skipped.
- When every GCS credential is in use or unusable, the call fails with 409
  `NO_AVAILABLE_CREDENTIAL` rather than falling back to an in-use credential.

---

## Non-Goals

- No provider API calls, no status refresh, and no writes to credentials or sessions.
- No file-backed credentials. Selection never falls back to local directories, an S3FS mount, or S3
  objects; only registry rows are candidates (FR-2 / FR-7).
- No enforcement at session creation: launching a session still requires an explicit credential
  reference. Auto-selecting a credential during launch is a separate story.
- No frontend integration in this story.
- No reservation/lease semantics. Two concurrent callers may be told the same credential is available;
  for Codesandbox/Codespaces the one-session-per-token constraint, and for every provider the in-use
  rule re-evaluated on the next call, remain the arbiters at launch time.
- No change to the existing inventory endpoint's payload, pagination, or sorting.

---

## Resolved Decisions

1. **In-use credentials are excluded for every provider, GCS included.** There is no provider exempt
   from the in-use rule. Detection uses the key each provider persists: `credentialFingerprint` for
   Codesandbox/Codespaces, and `credentialRef` (the registry name) for GCS, whose sessions do not store
   a fingerprint. See FR-3 and US-3.
2. **`inUse` is kept; `source` is removed.** `inUse` documents the decision (a selected credential is
   never in use) and `inUseKnown` qualifies it. `source` would be a constant, since only registry rows
   are selectable.
3. **The compute quota must be metered in `core-hours`.** Only a quota whose unit is `core-hours`
   participates in ranking, so a future "compute" quota in another unit (minutes, currency) can never be
   compared against core-hour values. See FR-5 and the frontend section.
4. **An empty registry is distinguishable from a fully-excluded one.** The 409 details carry a reason:
   `NO_REGISTERED_CREDENTIALS` when the provider has no registry row at all, `ALL_IN_USE_OR_UNUSABLE`
   otherwise. See FR-8.

### Follow-up (not blocking)

- **`inUseKnown` is now `true` for every supported provider**, since GCS in-use detection is defined. It
  is retained as an explicit assertion that in-use was evaluated, and to leave room for a provider whose
  sessions carry no usable credential key.
