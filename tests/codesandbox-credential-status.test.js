'use strict';

const assert = require('assert');
const { test } = require('node:test');

// ---------------------------------------------------------------------------
// Helper: inject a module stub into require.cache
// ---------------------------------------------------------------------------
function stubModule(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

// Resolved paths used across all provider tests
const clientPath      = require.resolve('../src/services/providers/codesandbox/client');
const scraperPath     = require.resolve('../src/services/providers/codesandbox/credits-scraper');
const credLoaderPath  = require.resolve('../src/services/providers/codesandbox/credentials-loader');
const providerPath    = require.resolve('../src/services/providers/codesandbox-provider');
const dbPath          = require.resolve('../src/db/db');

// ---------------------------------------------------------------------------
// Intercept resolution of uninstalled packages before anything else loads.
// Node throws during Module._resolveFilename (before checking require.cache)
// when a package is not installed. We hook _resolveFilename to redirect those
// requests to synthetic cache keys, then pre-populate those keys.
// ---------------------------------------------------------------------------
const Module = require('module');
const _origResolve = Module._resolveFilename;
const FAKE_ROOT = '/fake/node_modules';

Module._resolveFilename = function (request, parent, isMain, options) {
  if (
    request === '@codesandbox/sdk' ||
    request.startsWith('@codesandbox/sdk/') ||
    request === '@aws-sdk/client-s3' ||
    request.startsWith('@aws-sdk/')
  ) {
    return `${FAKE_ROOT}/${request}/index.js`;
  }
  return _origResolve.call(this, request, parent, isMain, options);
};

// Pre-populate fake cache entries
class FakeAPI { constructor() {} }
class FakeCodeSandbox { constructor() {} }
require.cache[`${FAKE_ROOT}/@codesandbox/sdk/index.js`] = {
  id: `${FAKE_ROOT}/@codesandbox/sdk/index.js`,
  filename: `${FAKE_ROOT}/@codesandbox/sdk/index.js`,
  loaded: true,
  exports: { API: FakeAPI, CodeSandbox: FakeCodeSandbox, VMTier: {} },
};
require.cache[`${FAKE_ROOT}/@aws-sdk/client-s3/index.js`] = {
  id: `${FAKE_ROOT}/@aws-sdk/client-s3/index.js`,
  filename: `${FAKE_ROOT}/@aws-sdk/client-s3/index.js`,
  loaded: true,
  exports: { S3Client: class S3Client {}, GetObjectCommand: class GetObjectCommand {} },
};

// ---------------------------------------------------------------------------
// Helpers to build a fresh provider with controlled stubs
// ---------------------------------------------------------------------------

/**
 * Builds a getApiClient stub whose getMetaInfo() resolves to `metaResult`.
 * `metaResult` shape: { data, response: { status } }
 */
function makeApiClientStub(metaResult) {
  return {
    getClient: () => ({
      sandboxes: {
        create: async () => { throw new Error('unexpected create call'); },
        resume: async () => { throw new Error('unexpected resume call'); },
      },
    }),
    getApiClient: () => ({
      getMetaInfo: async () => metaResult,
    }),
    clearCache: () => undefined,
  };
}

/** getApiClient stub whose getMetaInfo() throws `err`. */
function makeThrowingApiClientStub(err) {
  return {
    getClient: () => ({ sandboxes: {} }),
    getApiClient: () => ({
      getMetaInfo: async () => { throw err; },
    }),
    clearCache: () => undefined,
  };
}

function makeScraperStub(returnValue) {
  return {
    scrapeCreditsForTeam: async () => returnValue,
    listWebCredentialFiles: () => [],
    clearScrapeCache: () => undefined,
    getCachedScrape: () => null,
    putCachedScrape: () => undefined,
  };
}

function makeThrowingScraperStub(err) {
  return {
    scrapeCreditsForTeam: async () => { throw err; },
    listWebCredentialFiles: () => [],
    clearScrapeCache: () => undefined,
    getCachedScrape: () => null,
    putCachedScrape: () => undefined,
  };
}

const DB_STUB = {
  get: async () => ({ count: 0 }),
  run: async () => undefined,
  all: async () => [],
  pool: { end: async () => undefined },
  ready: Promise.resolve(),
};

/** Registers stubs and returns a fresh CodeSandboxProvider instance. */
function buildProvider(apiClientStub, scraperStub) {
  delete require.cache[providerPath];
  stubModule(dbPath, DB_STUB);
  stubModule(clientPath, apiClientStub);
  stubModule(scraperPath, scraperStub || makeScraperStub(null));
  // Stub credentials-loader so the provider loads without @aws-sdk/client-s3
  stubModule(credLoaderPath, {
    loadCodeSandboxCredentials: async () => ({ token: 'stubbed', credentialRef: 'stub.json', credentialFingerprint: 'sha256:stub' }),
  });
  const CodeSandboxProvider = require('../src/services/providers/codesandbox-provider');
  return new CodeSandboxProvider();
}

/** Canonical happy-path meta object. */
function happyMeta(overrides = {}) {
  return {
    rate_limits: {
      sandboxes_hourly: { limit: 50, remaining: 40, reset: 1234567890 },
      concurrent_vms:   { limit: 10, remaining: 8 },
    },
    auth: { team: 'ws_test123', scopes: ['sandbox_create', 'vm_manage'] },
    ...overrides,
  };
}

// ============================================================================
// Section 1: getApiClient() behaviour — tests against real client.js
// (SDK stub is pre-registered above; real client.js loads cleanly against it)
// ============================================================================

test('getApiClient returns an API instance', () => {
  // Clear client from cache so it reloads fresh with the SDK stub
  delete require.cache[clientPath];
  const codesandboxClient = require('../src/services/providers/codesandbox/client');
  codesandboxClient.clearCache();

  const instance = codesandboxClient.getApiClient('csb_v1_test_token');
  assert.strictEqual(typeof instance, 'object');
  assert.notStrictEqual(instance, null);
});

test('getApiClient returns the same cached instance for the same token', () => {
  delete require.cache[clientPath];
  const codesandboxClient = require('../src/services/providers/codesandbox/client');
  codesandboxClient.clearCache();

  const a = codesandboxClient.getApiClient('csb_v1_same_token');
  const b = codesandboxClient.getApiClient('csb_v1_same_token');
  assert.strictEqual(a, b);
});

test('getApiClient returns different instances for different tokens', () => {
  delete require.cache[clientPath];
  const codesandboxClient = require('../src/services/providers/codesandbox/client');
  codesandboxClient.clearCache();

  const a = codesandboxClient.getApiClient('csb_v1_token_one');
  const b = codesandboxClient.getApiClient('csb_v1_token_two');
  assert.notStrictEqual(a, b);
});

test('clearCache clears both instances and apiInstances maps', () => {
  delete require.cache[clientPath];
  const codesandboxClient = require('../src/services/providers/codesandbox/client');
  codesandboxClient.clearCache();

  const before = codesandboxClient.getApiClient('csb_v1_cache_test');
  codesandboxClient.clearCache();
  const after = codesandboxClient.getApiClient('csb_v1_cache_test');
  // After clearing, a fresh instance is created — not the same reference
  assert.notStrictEqual(before, after);
});

test('getApiClient throws on empty string token', () => {
  delete require.cache[clientPath];
  const codesandboxClient = require('../src/services/providers/codesandbox/client');

  assert.throws(
    () => codesandboxClient.getApiClient(''),
    (err) => err.message === 'CodeSandbox token is required'
  );
});

test('getApiClient throws on whitespace-only token', () => {
  delete require.cache[clientPath];
  const codesandboxClient = require('../src/services/providers/codesandbox/client');

  assert.throws(
    () => codesandboxClient.getApiClient('   '),
    (err) => err.message === 'CodeSandbox token is required'
  );
});

// ============================================================================
// Section 2: getCredentialStatus() — happy path (scraper disabled)
// ============================================================================

test('getCredentialStatus returns AVAILABLE with full quota entries when scraper is disabled', async () => {
  delete process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED;
  delete process.env.CODESANDBOX_SCRAPER_ENABLED;

  const provider = buildProvider(
    makeApiClientStub({ data: happyMeta(), response: { status: 200 } }),
    makeScraperStub(null)
  );

  const result = await provider.getCredentialStatus({ token: 'csb_v1_token' });

  assert.strictEqual(result.status, 'AVAILABLE');
  assert.strictEqual(result.validated, true);
  assert.strictEqual(result.expiresAt, null);

  // quotas[0] — hourly sandbox creation
  assert.strictEqual(result.quotas[0].quotaUnit, 'count');
  assert.strictEqual(result.quotas[0].quotaPeriod, 'hourly-window');
  assert.strictEqual(result.quotas[0].usage, 10);      // 50 - 40
  assert.strictEqual(result.quotas[0].limit, 50);
  assert.strictEqual(result.quotas[0].remaining, 40);
  assert.strictEqual(result.quotas[0].resetAt, 1234567890);

  // quotas[1] — concurrent VMs
  assert.strictEqual(result.quotas[1].quotaUnit, 'count');
  assert.strictEqual(result.quotas[1].quotaPeriod, null);
  assert.strictEqual(result.quotas[1].usage, 2);       // 10 - 8
  assert.strictEqual(result.quotas[1].limit, 10);
  assert.strictEqual(result.quotas[1].remaining, 8);

  // quotas[2] — credits (null when scraper disabled)
  assert.strictEqual(result.quotas[2].quotaUnit, 'credits');
  assert.strictEqual(result.quotas[2].quotaPeriod, 'billing-cycle');
  assert.strictEqual(result.quotas[2].usage, null);
  assert.strictEqual(result.quotas[2].limit, null);
  assert.strictEqual(result.quotas[2].remaining, null);

  // Limitation present for credits quota
  assert.strictEqual(result.limitations.length, 1);
  assert.strictEqual(result.limitations[0].field, 'quotas[2].usage');

  // No account-specific names in limitation message
  assert.ok(!result.limitations[0].reason.includes('etecnologysys'), 'limitation leaks etecnologysys');
  assert.ok(!result.limitations[0].reason.includes('vm-manager123'), 'limitation leaks vm-manager123');

  // details
  const tiers = ['Pico', 'Nano', 'Micro', 'Small', 'Medium', 'Large', 'XLarge'];
  for (const tier of tiers) {
    assert.ok(result.details.referencePricing[tier], `missing tier ${tier}`);
  }
  assert.deepStrictEqual(result.details.authScopes, ['sandbox_create', 'vm_manage']);
  assert.strictEqual(result.details.referenceLimits.freePlanConcurrentVmsDefault, 10);
});

// ============================================================================
// Section 3: getCredentialStatus() — scraper enabled, credits returned
// ============================================================================

test('getCredentialStatus populates credits quota when scraper returns data', async () => {
  process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED = '1';

  const scraped = {
    included: 400, used: 275, remaining: 125,
    billingPeriod: '4 Aug – 4 Sep 2026',
    url: 'https://codesandbox.io/t/usage?workspace=ws_test123',
    team: 'ws_test123',
  };

  const provider = buildProvider(
    makeApiClientStub({ data: happyMeta(), response: { status: 200 } }),
    makeScraperStub(scraped)
  );

  const result = await provider.getCredentialStatus({ token: 'csb_v1_token' });

  assert.strictEqual(result.status, 'AVAILABLE');
  assert.strictEqual(result.quotas[2].usage, 275);
  assert.strictEqual(result.quotas[2].limit, 400);
  assert.strictEqual(result.quotas[2].remaining, 125);
  assert.strictEqual(result.quotas[2].billingPeriod, '4 Aug – 4 Sep 2026');
  assert.ok(result.quotas[2].source, 'source should be set');

  // No credits limitation when scraper succeeds
  const creditLimitation = result.limitations.find(l => l.field === 'quotas[2].usage');
  assert.strictEqual(creditLimitation, undefined);

  delete process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED;
});

// ============================================================================
// Section 4: getCredentialStatus() — scraper enabled, returns null
// ============================================================================

test('getCredentialStatus adds limitation with CODESANDBOX_WEB_CREDENTIALS_DIR hint when scraper returns null', async () => {
  process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED = '1';

  const provider = buildProvider(
    makeApiClientStub({ data: happyMeta(), response: { status: 200 } }),
    makeScraperStub(null)
  );

  const result = await provider.getCredentialStatus({ token: 'csb_v1_token' });

  assert.strictEqual(result.status, 'AVAILABLE');
  assert.strictEqual(result.quotas[2].usage, null);

  const lim = result.limitations.find(l => l.field === 'quotas[2].usage');
  assert.ok(lim, 'credits limitation should be present');
  assert.ok(
    lim.reason.includes('CODESANDBOX_WEB_CREDENTIALS_DIR') || lim.reason.includes('workspace'),
    'limitation should mention how to fix or the workspace URL'
  );

  delete process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED;
});

// ============================================================================
// Section 5: QUOTA_EXHAUSTED via rate limits
// ============================================================================

test('getCredentialStatus returns QUOTA_EXHAUSTED when sandboxes_hourly.remaining is 0', async () => {
  delete process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED;

  const meta = happyMeta({
    rate_limits: {
      sandboxes_hourly: { limit: 50, remaining: 0, reset: 9999 },
      concurrent_vms:   { limit: 10, remaining: 8 },
    },
  });

  const provider = buildProvider(
    makeApiClientStub({ data: meta, response: { status: 200 } })
  );

  const result = await provider.getCredentialStatus({ token: 'csb_v1_token' });
  assert.strictEqual(result.status, 'QUOTA_EXHAUSTED');
});

test('getCredentialStatus returns QUOTA_EXHAUSTED when concurrent_vms.remaining is 0', async () => {
  delete process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED;

  const meta = happyMeta({
    rate_limits: {
      sandboxes_hourly: { limit: 50, remaining: 40, reset: 9999 },
      concurrent_vms:   { limit: 10, remaining: 0 },
    },
  });

  const provider = buildProvider(
    makeApiClientStub({ data: meta, response: { status: 200 } })
  );

  const result = await provider.getCredentialStatus({ token: 'csb_v1_token' });
  assert.strictEqual(result.status, 'QUOTA_EXHAUSTED');
});

test('getCredentialStatus returns QUOTA_EXHAUSTED when both rate-limit counters are 0', async () => {
  delete process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED;

  const meta = happyMeta({
    rate_limits: {
      sandboxes_hourly: { limit: 50, remaining: 0, reset: 9999 },
      concurrent_vms:   { limit: 10, remaining: 0 },
    },
  });

  const provider = buildProvider(
    makeApiClientStub({ data: meta, response: { status: 200 } })
  );

  const result = await provider.getCredentialStatus({ token: 'csb_v1_token' });
  assert.strictEqual(result.status, 'QUOTA_EXHAUSTED');
  assert.strictEqual(result.validated, true); // not an error
});

// ============================================================================
// Section 6: QUOTA_EXHAUSTED via credits
// ============================================================================

test('getCredentialStatus returns QUOTA_EXHAUSTED when scraper returns remaining:0', async () => {
  process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED = '1';

  const provider = buildProvider(
    makeApiClientStub({ data: happyMeta(), response: { status: 200 } }),
    makeScraperStub({ included: 400, used: 400, remaining: 0, url: null, team: 'ws_test123' })
  );

  const result = await provider.getCredentialStatus({ token: 'csb_v1_token' });
  assert.strictEqual(result.status, 'QUOTA_EXHAUSTED');
  assert.strictEqual(result.quotas[2].remaining, 0);

  delete process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED;
});

// ============================================================================
// Section 7: null/undefined rate-limit fields — not exhaustion
// ============================================================================

test('getCredentialStatus returns AVAILABLE when remaining is undefined on both counters', async () => {
  delete process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED;

  const meta = happyMeta({
    rate_limits: {
      sandboxes_hourly: { limit: 50 },   // remaining absent
      concurrent_vms:   { limit: 10 },   // remaining absent
    },
  });

  const provider = buildProvider(
    makeApiClientStub({ data: meta, response: { status: 200 } })
  );

  const result = await provider.getCredentialStatus({ token: 'csb_v1_token' });
  assert.strictEqual(result.status, 'AVAILABLE');
  assert.strictEqual(result.quotas[0].remaining, null);
  assert.strictEqual(result.quotas[0].usage, null);
  assert.strictEqual(result.quotas[1].remaining, null);
  assert.strictEqual(result.quotas[1].usage, null);
});

test('getCredentialStatus returns AVAILABLE when rate_limits field is absent from meta', async () => {
  delete process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED;

  const meta = { auth: { team: 'ws_test123', scopes: [] } }; // no rate_limits

  const provider = buildProvider(
    makeApiClientStub({ data: meta, response: { status: 200 } })
  );

  const result = await provider.getCredentialStatus({ token: 'csb_v1_token' });
  assert.strictEqual(result.status, 'AVAILABLE');
  assert.strictEqual(result.quotas[0].remaining, null);
  assert.strictEqual(result.quotas[1].remaining, null);
});

// ============================================================================
// Section 8: INVALID — 401 / 403
// ============================================================================

test('getCredentialStatus returns INVALID with validated:false on 401', async () => {
  const provider = buildProvider(
    makeApiClientStub({ data: undefined, response: { status: 401 } })
  );

  const result = await provider.getCredentialStatus({ token: 'csb_v1_bad' });
  assert.strictEqual(result.status, 'INVALID');
  assert.strictEqual(result.validated, false);
  assert.strictEqual(result.quotas.length, 0);
  assert.ok(result.limitations.length > 0);
  assert.strictEqual(result.limitations[0].field, 'status');
  assert.ok(result.limitations[0].reason.includes('401'));
});

test('getCredentialStatus returns INVALID with validated:false on 403', async () => {
  const provider = buildProvider(
    makeApiClientStub({ data: undefined, response: { status: 403 } })
  );

  const result = await provider.getCredentialStatus({ token: 'csb_v1_bad' });
  assert.strictEqual(result.status, 'INVALID');
  assert.strictEqual(result.validated, false);
  assert.ok(result.limitations[0].reason.includes('403'));
});

// ============================================================================
// Section 9: Transient errors — must throw
// ============================================================================

test('getCredentialStatus throws on 500 response so dispatcher marks UNKNOWN', async () => {
  const provider = buildProvider(
    makeApiClientStub({ data: undefined, response: { status: 500 } })
  );

  await assert.rejects(
    () => provider.getCredentialStatus({ token: 'csb_v1_token' }),
    (err) => err instanceof Error && err.statusCode === 500
  );
});

test('getCredentialStatus throws on 429 response so dispatcher marks UNKNOWN', async () => {
  const provider = buildProvider(
    makeApiClientStub({ data: undefined, response: { status: 429 } })
  );

  await assert.rejects(
    () => provider.getCredentialStatus({ token: 'csb_v1_token' }),
    (err) => err instanceof Error && err.statusCode === 429
  );
});

test('getCredentialStatus lets network errors propagate unchanged', async () => {
  const networkErr = new Error('fetch failed');

  const provider = buildProvider(
    makeThrowingApiClientStub(networkErr)
  );

  await assert.rejects(
    () => provider.getCredentialStatus({ token: 'csb_v1_token' }),
    (err) => err === networkErr
  );
});

// ============================================================================
// Section 10: Scraper throws — must NOT propagate
// ============================================================================

test('getCredentialStatus catches scraper errors and returns with null credits', async () => {
  process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED = '1';

  const provider = buildProvider(
    makeApiClientStub({ data: happyMeta(), response: { status: 200 } }),
    makeThrowingScraperStub(new Error('browser crash'))
  );

  // Should not throw
  const result = await provider.getCredentialStatus({ token: 'csb_v1_token' });
  assert.strictEqual(result.status, 'AVAILABLE'); // rate-limits fine, error swallowed
  assert.strictEqual(result.quotas[2].usage, null);
  assert.ok(result.limitations.find(l => l.field === 'quotas[2].usage'), 'limitation should be present');

  delete process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED;
});

// ============================================================================
// Section 11: Limitation message must not leak account names
// ============================================================================

test('limitation message does not contain account-specific names when scraper is disabled', async () => {
  delete process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED;

  const provider = buildProvider(
    makeApiClientStub({ data: happyMeta(), response: { status: 200 } })
  );

  const result = await provider.getCredentialStatus({ token: 'csb_v1_token' });
  const lim = result.limitations.find(l => l.field === 'quotas[2].usage');
  assert.ok(lim, 'credits limitation should exist');
  assert.ok(!lim.reason.includes('etecnologysys'), 'reason must not mention etecnologysys');
  assert.ok(!lim.reason.includes('vm-manager123'), 'reason must not mention vm-manager123');
});

test('limitation message does not contain account-specific names when scraper is enabled but returns null', async () => {
  process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED = '1';

  const provider = buildProvider(
    makeApiClientStub({ data: happyMeta(), response: { status: 200 } }),
    makeScraperStub(null)
  );

  const result = await provider.getCredentialStatus({ token: 'csb_v1_token' });
  const lim = result.limitations.find(l => l.field === 'quotas[2].usage');
  assert.ok(lim);
  assert.ok(!lim.reason.includes('etecnologysys'));
  assert.ok(!lim.reason.includes('vm-manager123'));

  delete process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED;
});

// ============================================================================
// Section 12: numOrNull — indirect verification via quota entries
// ============================================================================

test('numOrNull treats 0 as a valid number (remaining:0 should not be null)', async () => {
  delete process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED;

  const meta = happyMeta({
    rate_limits: {
      sandboxes_hourly: { limit: 50, remaining: 0, reset: 9999 },
      concurrent_vms:   { limit: 10, remaining: 8 },
    },
  });

  const provider = buildProvider(
    makeApiClientStub({ data: meta, response: { status: 200 } })
  );

  const result = await provider.getCredentialStatus({ token: 'csb_v1_token' });
  // remaining:0 should be the number 0, not null
  assert.strictEqual(result.quotas[0].remaining, 0);
  assert.strictEqual(typeof result.quotas[0].remaining, 'number');
});

test('numOrNull converts NaN/Infinity fields to null', async () => {
  delete process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED;

  const meta = happyMeta({
    rate_limits: {
      sandboxes_hourly: { limit: NaN, remaining: Infinity },
      concurrent_vms:   { limit: -Infinity, remaining: NaN },
    },
  });

  const provider = buildProvider(
    makeApiClientStub({ data: meta, response: { status: 200 } })
  );

  const result = await provider.getCredentialStatus({ token: 'csb_v1_token' });
  assert.strictEqual(result.quotas[0].limit, null);
  assert.strictEqual(result.quotas[0].remaining, null);
  assert.strictEqual(result.quotas[0].usage, null);
  assert.strictEqual(result.quotas[1].limit, null);
  assert.strictEqual(result.quotas[1].remaining, null);
});

// ============================================================================
// Section 13: CODESANDBOX_SCRAPER_ENABLED alias
// ============================================================================

test('CODESANDBOX_SCRAPER_ENABLED (alias) also enables scraping', async () => {
  delete process.env.CODESANDBOX_CREDITS_SCRAPER_ENABLED;
  process.env.CODESANDBOX_SCRAPER_ENABLED = '1';

  let scraperCalled = false;
  const scraperStub = {
    scrapeCreditsForTeam: async () => { scraperCalled = true; return null; },
    listWebCredentialFiles: () => [],
    clearScrapeCache: () => undefined,
    getCachedScrape: () => null,
    putCachedScrape: () => undefined,
  };

  const provider = buildProvider(
    makeApiClientStub({ data: happyMeta(), response: { status: 200 } }),
    scraperStub
  );

  await provider.getCredentialStatus({ token: 'csb_v1_token' });
  assert.strictEqual(scraperCalled, true, 'scraper should have been called via alias');

  delete process.env.CODESANDBOX_SCRAPER_ENABLED;
});
