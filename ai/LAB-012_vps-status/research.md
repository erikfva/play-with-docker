# Research: Codespaces Quota (use/remainder) Incorrect — container-100

**Date:** 2026-09-24
**Account investigated:** `container-100` (GitHub user, Free plan)
**Trigger:** `getCredentialStatus` reported compute `usage: 68 / limit: 120 / remaining: 52`,
  storage `usage: null / remaining: null`, `status: AVAILABLE` — while GitHub shows the
  quota nearly exhausted.
**Fix commit:** `0339994` — `fix(codespaces): correct quota usage from month-to-date billing report`

---

## 1. Reported symptom

```json
{"quotas": [{"name": "Codespaces compute (core-hours)", "limit": 120, "usage": 68, "quotaUnit": "core-hours", "remaining": 52, "quotaPeriod": "month"}, {"name": "Codespaces storage (GB-month)", "limit": 15, "usage": null, "quotaUnit": "GB-month", "remaining": null, "quotaPeriod": "month"}], "status": "AVAILABLE", "details": {"plan": "free", "adoptable": 1, "validated": true, ...}, "provider": "codespaces", "credential": "container-100"}
```

Two defects visible in one payload: compute usage understated, storage usage entirely absent.

## 2. Ground truth (live GitHub UI, verified via Playwright)

Using the Playwright `storageState` session at `/mnt/s3/github/container-100/github.json`
(headless Chromium, `chromium-1243/chrome-linux64/chrome`), navigated to the account's real pages:

- **`https://github.com/codespaces`** — one codespace, `super chainsaw`, `2-core • 8GB RAM • 32GB`,
  from `github/codespaces-blank`, "Last used 2 days ago".
- **`https://github.com/settings/billing`** — Current metered usage **$11.20** gross
  (Sep 1–30, 2026), fully offset by **$11.20** included-usage discounts (billed $0).
- **"More details" → Included usage and credits** (cycle "resets in 7 day(s)"):

| Included quota | Discount value | Discount consumed | Implied consumption |
|---|---|---|---|
| 120 included Codespaces core hours | ~$10.80 off | **$10.52** | $10.52 ÷ ($10.80/120) ≈ **~117 core-hours used → ~3 left** |
| 15 GB included Codespaces storage | ~$1.05 off | **$0.69** | $0.69 ÷ ($1.05/15) ≈ **~9.9 GB used → ~5 left** |

So the true state was **~117/120 core-hours and ~9.9/15 GB-months consumed — nearly
exhausted, not half-full**, and `status: AVAILABLE` was wrong in the strong sense
(a quota verdict, not just imprecise numbers).

## 3. Root causes (code, pre-fix)

All in `src/services/providers/codespaces/client.js` + `src/services/providers/codespaces-provider.js`:

1. **Missing required date params — single-day data treated as month-to-date.**
   `getBillingUsageSummary` called
   `GET /users/{login}/settings/billing/usage/summary` with **no query string**.
   Per the [billing usage-summary docs](https://docs.github.com/en/rest/billing/billing#get-billing-usage-summary-for-a-user),
   that endpoint **requires `year`, `month`, and `day`** and returns one day's summary.
   The bare call returned an arbitrary/default slice that was summed as if it were the
   whole month (hence a plausible-but-wrong 68).
2. **Product-gated filter dropped storage rows.** `extractCodespacesUsage` kept only rows
   with `product === 'codespaces'`. Codespaces storage is billed under alternate labels
   (`Shared Storage` product / `Codespaces Storage` sku), so storage always fell through
   to `null` → `remaining: null`.
3. **Quantity-field guesswork.** The parser read `grossQuantity ?? usageQuantity ?? quantity`.
   Real payloads use `quantity` (gross, before included-plan discounts) alongside
   `discountQuantity`/`netQuantity`; `grossQuantity` is only an alias in some shapes, and
   summing a net field would understate usage against the included limit.
4. **No unit/core-count awareness.** Compute rows may be wall-clock minutes/hours for a
   specific machine (`2-core` in the sku) that must be scaled to core-hours before comparing
   to the 120/180 included limits. The old unit check (`hour`/`core` vs `gb`/`storage`)
   neither scaled nor normalized.
5. **No exhaustion verdict.** Even a literal `remaining: 0` still returned `AVAILABLE`;
   there was no `QUOTA_EXHAUSTED` path for Codespaces (unlike CodeSandbox's rate-limit/credit handling).

## 4. Fix (commit 0339994)

**`src/services/providers/codespaces/client.js`**
- `getBillingUsageSummary(token, login, { year, month, day })` — always sends
  `?year=&month=&day=` (defaults to today UTC).
- New `getBillingUsageReport(token, login, { year, month })` — single-call whole-month
  query via `GET /users/{login}/settings/billing/usage`.
- New `getMonthlyCodespacesUsage()` — report first; bounded-concurrency per-day summary
  aggregation only as fallback on 404/403. Auth/rate-limit errors propagate instead of
  hiding behind partial data. Returns `{ usageItems, billingSource, billingPeriod }`.

**`src/services/providers/codespaces-provider.js`**
- SKU-driven `extractCodespacesUsage`: matches `codespace`/`shared storage` across
  product+sku (not product equality); storage classified by sku/unit before compute;
  per-machine compute scaled by sku core count (`2-core` × hours, minutes→hours);
  **gross** `quantity` preferred, `netQuantity` never used; unknown units sum as compute
  rather than being dropped.
- `remaining` rounded to 1 decimal (avoids `5.100000000000001` floats).
- Zero remaining on either quota → **`QUOTA_EXHAUSTED`**.
- Quota entries and `details` carry `billingPeriod` (`YYYY-MM`).

**`tests/codespaces-quota.test.js`** (7 tests, all passing):
- 2-core aggregation → 117 used / 3 left; storage 9.9 / 5.1; `AVAILABLE` with headroom.
- Over-limit (123) → `remaining: 0`, `QUOTA_EXHAUSTED`.
- Gross-vs-net semantics (`netQuantity: 0` ignored, `quantity: 68` used).
- Billing-unavailable → null quotas + limitation, still `AVAILABLE`.
- Client: report-preferred path, per-day fallback on 404, date-param enforcement.

## 5. Verification

- New suite: **7/7 pass** (`node --test tests/codespaces-quota.test.js`).
- Post-fix parser output for container-100's shape (~117/120, ~9.9/15) is consistent with
  the live UI discount ratios ($10.52/$10.80, $0.69/$1.05).
- Pre-existing failures in `codespaces-credentials-loader`, `vps-status-refresh`, and parts
  of `codespaces-provider` tests are **environmental** (`Cannot find module 'express'` /
  `'@aws-sdk/client-s3'` — `node_modules` not installed in this container) and identical on
  the clean tree; unrelated to this change.

## 6. Follow-ups / open questions

- **Fixture from a real response.** The parser was written without a recorded payload.
  Capture one redacted `usage-report` body (field names, sku strings, unit values) into
  `tests/fixtures/` so future GitHub schema drift is caught by tests, not production.
- **Billing-permission limitation text.** The `quotas[0].usage` limitation still says the
  read "requires the token to have billing read permission on a personal account context"
  — accurate, but consider surfacing `billingSource` (`usage-report` vs
  `daily-summary-fallback`) in `details` when the fallback path was taken, since fallback
  totals are less trustworthy.
- **`QUOTA_EXHAUSTED` precedence in `vps-status-service`.** `finalizeWithLocalState` already
  ranks `QUOTA_EXHAUSTED` above `AVAILABLE`/`LIMITED`, so the new verdict flows through —
  but no test covers a Codespaces `QUOTA_EXHAUSTED` traveling through the refresh/persist path.
- **Org/enterprise accounts.** `referenceLimits` still hardcode Free (120/15) / Pro (180/20)
  with only a limitation note for other plans; org accounts have no included quota by
  default, so `remaining` there is reference-only. Unchanged by this fix, noted for LAB-012 scope.

## 7. Sources

- [Get billing usage summary for a user](https://docs.github.com/en/rest/billing/billing#get-billing-usage-summary-for-a-user)
- [GitHub REST API — Billing reference](https://docs.github.com/en/rest/billing/billing)
- Live account pages (session `/mnt/s3/github/container-100/github.json`):
  `https://github.com/codespaces`, `https://github.com/settings/billing`,
  `https://github.com/settings/billing/usage`
