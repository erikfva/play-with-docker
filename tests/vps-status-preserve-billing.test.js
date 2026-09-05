'use strict';

const assert = require('assert');
const { test } = require('node:test');

const { preserveCodesandboxBilling } = require('../src/services/vps-status-service');

function freshCheckerEntry() {
  return {
    provider: 'codesandbox',
    credential: 'test-cred',
    credentialFingerprint: 'fp123',
    status: 'AVAILABLE',
    checkedAt: new Date().toISOString(),
    expiresAt: null,
    quotas: [
      { name: 'Sandbox creations (hourly window)', quotaUnit: 'count', quotaPeriod: 'hourly-window', usage: 0, limit: 10, remaining: 10 },
      { name: 'Concurrent VMs', quotaUnit: 'count', quotaPeriod: null, usage: 0, limit: 10, remaining: 10 },
      { name: 'Credits (billing cycle)', quotaUnit: 'credits', quotaPeriod: 'billing-cycle', usage: null, limit: null, remaining: null },
    ],
    details: { validated: true, limitations: [], localActiveSessions: 0 }
  };
}

function storedBillingEntry(overrides = {}) {
  return {
    provider: 'codesandbox',
    credential: 'test-cred',
    credentialFingerprint: 'fp123',
    status: 'AVAILABLE',
    checkedAt: '2026-09-04T12:00:00.000Z',
    expiresAt: null,
    quotas: [
      {
        name: 'Credits (billing cycle)',
        quotaUnit: 'credits',
        quotaPeriod: 'billing-cycle',
        usage: 125,
        limit: 400,
        remaining: 275,
        source: 'https://codesandbox.io/t/usage?workspace=ws_test123',
        billingPeriod: '8 August – 8 September 2026',
        fetchedAt: '2026-09-04T12:00:00.000Z',
        ...overrides
      }
    ],
    details: {
      validated: true,
      creditSource: 'https://codesandbox.io/t/usage?workspace=ws_test123',
      creditBillingPeriod: '8 August – 8 September 2026'
    }
  };
}

test('refresh preserves stored billing when checker returns the null placeholder', () => {
  const out = preserveCodesandboxBilling(freshCheckerEntry(), storedBillingEntry());
  const credits = out.quotas.find((q) => q.name === 'Credits (billing cycle)');
  assert.strictEqual(credits.usage, 125);
  assert.strictEqual(credits.limit, 400);
  assert.strictEqual(credits.remaining, 275);
  assert.strictEqual(credits.fetchedAt, '2026-09-04T12:00:00.000Z');
  assert.strictEqual(credits.source, 'https://codesandbox.io/t/usage?workspace=ws_test123');
  assert.strictEqual(out.details.creditSource, 'https://codesandbox.io/t/usage?workspace=ws_test123');
  assert.strictEqual(out.details.creditBillingPeriod, '8 August – 8 September 2026');
  assert.strictEqual(out.status, 'AVAILABLE');
});

test('exhausted stored billing escalates AVAILABLE to QUOTA_EXHAUSTED', () => {
  const out = preserveCodesandboxBilling(
    freshCheckerEntry(),
    storedBillingEntry({ usage: 400, limit: 400, remaining: 0 })
  );
  assert.strictEqual(out.status, 'QUOTA_EXHAUSTED');
  assert.strictEqual(out.quotas.find((q) => q.name === 'Credits (billing cycle)').remaining, 0);
});

test('fresh scraped credits win over stored billing', () => {
  const entry = freshCheckerEntry();
  entry.quotas[2] = {
    name: 'Credits (billing cycle)', quotaUnit: 'credits', quotaPeriod: 'billing-cycle',
    usage: 200, limit: 400, remaining: 200, fetchedAt: '2026-09-05T00:00:00.000Z'
  };
  const out = preserveCodesandboxBilling(entry, storedBillingEntry());
  assert.strictEqual(out.quotas[2].remaining, 200);
  assert.strictEqual(out.quotas[2].fetchedAt, '2026-09-05T00:00:00.000Z');
});

test('no stored billing leaves the checker entry untouched', () => {
  const out = preserveCodesandboxBilling(freshCheckerEntry(), null);
  assert.strictEqual(out.quotas[2].remaining, null);
  assert.strictEqual(out.status, 'AVAILABLE');
});

test('rate-limit QUOTA_EXHAUSTED is never demoted by stored billing', () => {
  const entry = freshCheckerEntry();
  entry.status = 'QUOTA_EXHAUSTED';
  const out = preserveCodesandboxBilling(entry, storedBillingEntry());
  assert.strictEqual(out.status, 'QUOTA_EXHAUSTED');
  assert.strictEqual(out.quotas.find((q) => q.name === 'Credits (billing cycle)').remaining, 275);
});

test('UNKNOWN checker failures keep the stored billing quotas', () => {
  const unknown = {
    provider: 'codesandbox',
    credential: 'test-cred',
    credentialFingerprint: 'fp123',
    status: 'UNKNOWN',
    checkedAt: new Date().toISOString(),
    expiresAt: null,
    quotas: [],
    details: { validated: false, limitations: [{ field: 'status', reason: 'x' }] }
  };
  const out = preserveCodesandboxBilling(unknown, storedBillingEntry());
  assert.strictEqual(out.quotas.length, 1);
  assert.strictEqual(out.quotas[0].remaining, 275);
});
