const assert = require('assert');
const { test } = require('node:test');

function stubModule(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports
  };
}

// Shaped like the real GitHub billing usage-report payload:
// https://docs.github.com/en/rest/billing/billing — usageItems with
// product/sku/quantity/unitType. container-100's September cycle showed
// ~117 core-hours consumed on a 2-core machine and ~9.9 GB-months storage.
function usageReportFixture() {
  return {
    usageItems: [
      // 2-core compute rows reported in wall-clock hours: 58.5h × 2 = 117
      { date: '2026-09-09', product: 'Codespaces', sku: 'Codespaces Compute - 2-core', quantity: 30.0, unitType: 'hours', pricePerUnit: 0.09, grossAmount: 2.7, discountAmount: 2.7, netAmount: 0 },
      { date: '2026-09-16', product: 'Codespaces', sku: 'Codespaces Compute - 2-core', quantity: 1710, unitType: 'minutes', pricePerUnit: 0.0015, grossAmount: 2.565, discountAmount: 2.565, netAmount: 0 },
      // storage under the alternate "Shared Storage" product label
      { date: '2026-09-16', product: 'Shared Storage', sku: 'Codespaces Storage', quantity: 9.9, unitType: 'GB-months', pricePerUnit: 0.07, grossAmount: 0.69, discountAmount: 0.69, netAmount: 0 },
      // unrelated product must be ignored
      { date: '2026-09-10', product: 'Actions', sku: 'Actions Linux - 2-core', quantity: 500, unitType: 'minutes', pricePerUnit: 0.008, grossAmount: 4, discountAmount: 4, netAmount: 0 }
    ]
  };
}

function loadProviderWithBilling({ billingBody, plan = 'free', codespaces = [{ name: 'cs-1', state: 'Shutdown' }] } = {}) {
  const dbPath = require.resolve('../src/db/db');
  const providerPath = require.resolve('../src/services/providers/codespaces-provider');
  const clientPath = require.resolve('../src/services/providers/codespaces/client');
  const loaderPath = require.resolve('../src/services/providers/codespaces/credentials-loader');
  const executorPath = require.resolve('../src/services/providers/codespaces/cli-executor');

  delete require.cache[providerPath];

  stubModule(dbPath, {
    get: async () => null,
    run: async () => undefined,
    all: async () => [],
    pool: { end: async () => undefined },
    ready: Promise.resolve()
  });
  stubModule(loaderPath, {
    loadCodespacesCredentials: async () => ({
      token: 'ghp_test',
      credentialRef: 'container-100',
      credentialFingerprint: 'sha256:test'
    })
  });

  const calls = { summaries: [], reports: [] };
  stubModule(clientPath, {
    validateToken: async () => ({ login: 'container-100', plan: { name: plan } }),
    listCodespaces: async () => codespaces,
    getBillingUsageSummary: async (token, login, opts) => {
      calls.summaries.push(opts);
      return { usageItems: [] };
    },
    getBillingUsageReport: async () => {
      calls.reports.push(true);
      if (billingBody instanceof Error) throw billingBody;
      return billingBody;
    },
    // Mirror the real getMonthlyCodespacesUsage contract: report wins,
    // errors propagate so the provider records a limitation.
    getMonthlyCodespacesUsage: async () => {
      calls.reports.push(true);
      if (billingBody instanceof Error) throw billingBody;
      const items = Array.isArray(billingBody?.usageItems) ? billingBody.usageItems : [];
      const now = new Date();
      return { usageItems: items, billingSource: 'usage-report', billingPeriod: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}` };
    },
    getCodespace: async () => ({ state: 'Shutdown' }),
    startCodespace: async () => ({}),
    stopCodespace: async () => ({})
  });
  stubModule(executorPath, {
    executeInCodespace: async () => ({ output: 'ok' }),
    BOOT_TIMEOUT_MS: 90000,
    COMMAND_TIMEOUT_MS: 30000
  });

  const CodespacesProvider = require('../src/services/providers/codespaces-provider');
  return { provider: new CodespacesProvider(), calls };
}

test('quota: aggregates 2-core compute to core-hours and reads storage under Shared Storage', async () => {
  const { provider } = loadProviderWithBilling({ billingBody: usageReportFixture() });
  const result = await provider.getCredentialStatus({ token: 'ghp_test' });

  const compute = result.quotas[0];
  assert.equal(compute.quotaUnit, 'core-hours');
  assert.equal(compute.limit, 120);
  // 30h×2 cores + (1710min/60)×2 cores = 60 + 57 = 117
  assert.equal(compute.usage, 117);
  assert.equal(compute.remaining, 3);

  const storage = result.quotas[1];
  assert.equal(storage.quotaUnit, 'GB-month');
  assert.equal(storage.usage, 9.9);
  assert.equal(storage.remaining, 5.1);

  // still has headroom → AVAILABLE (container-100's real ~117/120 is near the edge)
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.details.billingPeriod, `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`);
});

test('quota: zero remaining compute escalates to QUOTA_EXHAUSTED', async () => {
  const body = usageReportFixture();
  body.usageItems.push(
    { date: '2026-09-20', product: 'Codespaces', sku: 'Codespaces Compute - 2-core', quantity: 3, unitType: 'hours', pricePerUnit: 0.09, grossAmount: 0.27, discountAmount: 0, netAmount: 0.27 }
  );
  const { provider } = loadProviderWithBilling({ billingBody: body });
  const result = await provider.getCredentialStatus({ token: 'ghp_test' });

  assert.equal(result.quotas[0].usage, 123);
  assert.equal(result.quotas[0].remaining, 0);
  assert.equal(result.status, 'QUOTA_EXHAUSTED');
});

test('quota: ignores netQuantity and uses gross quantity', async () => {
  const { provider } = loadProviderWithBilling({
    billingBody: {
      usageItems: [
        { date: '2026-09-09', product: 'Codespaces', sku: 'Codespaces Compute', quantity: 68, netQuantity: 0, discountQuantity: 68, unitType: 'hours', pricePerUnit: 0.09, grossAmount: 6.12, discountAmount: 6.12, netAmount: 0 }
      ]
    }
  });
  const result = await provider.getCredentialStatus({ token: 'ghp_test' });
  assert.equal(result.quotas[0].usage, 68);
  assert.equal(result.quotas[0].remaining, 52);
});

test('quota: unavailable billing degrades to null quotas with a limitation, still AVAILABLE', async () => {
  const err = new Error('Not Found');
  err.code = 'CODESPACES_NOT_FOUND';
  err.statusCode = 404;
  const { provider } = loadProviderWithBilling({ billingBody: err });
  const result = await provider.getCredentialStatus({ token: 'ghp_test' });

  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.quotas[0].usage, null);
  assert.equal(result.quotas[0].remaining, null);
  assert.equal(result.quotas[1].usage, null);
  assert.ok(result.limitations.some((l) => l.field === 'quotas[0].usage'));
});

test('client: monthly usage prefers the single-call usage report', async () => {
  // Load the real client with only fetch stubbed: proves the report path is
  // hit (usage?year=&month=) and returns the normalized envelope.
  delete require.cache[require.resolve('../src/services/providers/codespaces/client')];
  const clientPath = require.resolve('../src/services/providers/codespaces/client');
  const origFetch = global.fetch;
  const seen = [];
  global.fetch = async (url) => {
    seen.push(String(url));
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(usageReportFixture()) };
  };
  try {
    delete require.cache[clientPath];
    const realClient = require('../src/services/providers/codespaces/client');
    const body = await realClient.getMonthlyCodespacesUsage('tok', 'login', { now: new Date(Date.UTC(2026, 8, 24)) });
    assert.equal(body.billingSource, 'usage-report');
    assert.equal(body.billingPeriod, '2026-09');
    assert.ok(Array.isArray(body.usageItems) && body.usageItems.length === 4);
  } finally {
    global.fetch = origFetch;
    delete require.cache[clientPath];
  }
  assert.equal(seen.length, 1);
  assert.ok(seen[0].includes('/settings/billing/usage?'), `must hit usage report, got ${seen[0]}`);
  assert.ok(seen[0].includes('year=2026&month=9'), `got ${seen[0]}`);
});

test('client: falls back to per-day summaries when the report endpoint 404s', async () => {
  delete require.cache[require.resolve('../src/services/providers/codespaces/client')];
  const clientPath = require.resolve('../src/services/providers/codespaces/client');
  const origFetch = global.fetch;
  const seen = [];
  global.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes('/settings/billing/usage?')) {
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => JSON.stringify({ message: 'Not Found' }) };
    }
    if (u.includes('/settings/billing/usage/summary?')) {
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ usageItems: [{ product: 'Codespaces', sku: 'Codespaces Compute', quantity: 1, unitType: 'hours' }] }) };
    }
    throw new Error(`unexpected ${u}`);
  };
  try {
    delete require.cache[clientPath];
    const realClient = require('../src/services/providers/codespaces/client');
    // now = Sep 3 → 3 daily calls after the failed report call
    const body = await realClient.getMonthlyCodespacesUsage('tok', 'login', { now: new Date(Date.UTC(2026, 8, 3)), concurrency: 10 });
    assert.equal(body.billingSource, 'daily-summary-fallback');
    assert.equal(body.billingPeriod, '2026-09');
    assert.equal(body.usageItems.length, 3);
  } finally {
    global.fetch = origFetch;
    delete require.cache[clientPath];
  }
  assert.equal(seen.filter((u) => u.includes('/settings/billing/usage/summary?')).length, 3);
});

test('client: daily summary requires year/month/day params', async () => {
  const realClient = require('../src/services/providers/codespaces/client');
  const origFetch = global.fetch;
  const seen = [];
  global.fetch = async (url) => {
    seen.push(String(url));
    return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ usageItems: [] }) };
  };
  try {
    await realClient.getBillingUsageSummary('tok', 'login', { year: 2026, month: 9, day: 8 });
  } finally {
    global.fetch = origFetch;
  }
  assert.equal(seen.length, 1);
  assert.ok(seen[0].includes('year=2026&month=9&day=8'), `got ${seen[0]}`);
});
