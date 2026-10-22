'use strict';

const assert = require('assert');
const { test } = require('node:test');

const {
  getAvailableCredential,
  listDbCandidates,
  listInUseKeys,
  extractCoreHoursRemaining,
  isComputeQuota,
  asStatusObject,
  NO_AVAILABLE_CREDENTIAL,
  NO_REGISTERED_CREDENTIALS,
  ALL_IN_USE_OR_UNUSABLE
} = require('../src/services/available-credential-service');
const { ProviderError } = require('../src/services/errors/provider-errors');

// ---------------------------------------------------------------------------
// DB-backed selection: the service talks to ../db/db through a lazy require,
// so the module can be stubbed per test.
// ---------------------------------------------------------------------------
const dbPath = require.resolve('../src/db/db');

function stubDb({ rows = [], sessionRows = [] } = {}) {
  const calls = { all: [] };
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      all: async (sql, params) => {
        calls.all.push({ sql, params });
        if (/FROM sessions/.test(sql)) return sessionRows;
        return rows;
      },
      get: async () => null,
      run: async () => {},
      pool: { end: async () => {} },
      ready: Promise.resolve()
    }
  };
  return calls;
}

function clearDbStub() {
  delete require.cache[dbPath];
}

test('listDbCandidates maps vps rows into candidates', async () => {
  stubDb({
    rows: [
      {
        id: 'vps-1',
        name: 'codespaces/a.json',
        credentialFingerprint: 'sha256:a',
        status: { status: 'AVAILABLE', quotas: [] },
        statusCheckedAt: '2026-01-01T00:00:00Z',
        createdAt: '2026-01-01T00:00:00Z'
      }
    ]
  });

  const candidates = await listDbCandidates('codespaces');
  clearDbStub();

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].credentialRef, 'codespaces/a.json');
  assert.equal(candidates[0].credentialFingerprint, 'sha256:a');
  // The status column is JSONB — it may arrive as an object or a string.
  assert.equal(candidates[0].status.status, 'AVAILABLE');
});

test('listInUseKeys excludes terminal session statuses', async () => {
  const calls = stubDb({ sessionRows: [{ inUseKey: 'sha256:busy' }] });
  const fingerprints = await listInUseKeys('codespaces');
  clearDbStub();

  assert.equal(fingerprints.has('sha256:busy'), true);
  const sql = calls.all[0].sql;
  assert.match(sql, /SELECT DISTINCT credentialFingerprint AS "inUseKey"/);
  assert.ok(/NOT IN/.test(sql));
  assert.deepEqual(calls.all[0].params, ['codespaces', 'TERMINATED', 'FAILED']);
});

test('listInUseKeys matches GCS sessions by credentialRef', async () => {
  const calls = stubDb({ sessionRows: [{ inUseKey: 'gcloud/account.json' }] });
  const keys = await listInUseKeys('gcs');
  clearDbStub();

  assert.equal(keys.has('gcloud/account.json'), true);
  assert.match(calls.all[0].sql, /SELECT DISTINCT credentialRef AS "inUseKey"/);
  assert.match(calls.all[0].sql, /AND credentialRef IS NOT NULL/);
  assert.deepEqual(calls.all[0].params, ['gcs', 'TERMINATED', 'DELETED', 'FAILED']);
});

test('getAvailableCredential picks the best codespaces credential from the DB', async () => {
  stubDb({
    rows: [
      {
        id: 'vps-1',
        name: 'codespaces/low.json',
        credentialFingerprint: 'sha256:low',
        status: { status: 'AVAILABLE', quotas: [{ name: 'Codespaces compute (core-hours)', quotaUnit: 'core-hours', limit: 120, usage: 100, remaining: 20 }] }
      },
      {
        id: 'vps-2',
        name: 'codespaces/high.json',
        credentialFingerprint: 'sha256:high',
        status: { status: 'AVAILABLE', quotas: [{ name: 'Codespaces compute (core-hours)', quotaUnit: 'core-hours', limit: 120, usage: 10, remaining: 110 }] }
      }
    ],
    sessionRows: []
  });

  const result = await getAvailableCredential('codespaces');
  clearDbStub();

  assert.equal(result.credentialRef, 'codespaces/high.json');
  assert.equal(result.coreHoursRemaining, 110);
  assert.equal(result.strategy, 'max-core-hours');
});

test('getAvailableCredential skips a DB credential that backs a live session', async () => {
  stubDb({
    rows: [
      { id: 'vps-1', name: 'codespaces/busy.json', credentialFingerprint: 'sha256:busy', status: { status: 'AVAILABLE', quotas: [] } },
      { id: 'vps-2', name: 'codespaces/free.json', credentialFingerprint: 'sha256:free', status: { status: 'AVAILABLE', quotas: [] } }
    ],
    sessionRows: [{ inUseKey: 'sha256:busy' }]
  });

  const result = await getAvailableCredential('codespaces');
  clearDbStub();

  assert.equal(result.credentialRef, 'codespaces/free.json');
  assert.equal(result.inUse, false);
});

test('getAvailableCredential raises NO_AVAILABLE_CREDENTIAL when every DB row is unusable', async () => {
  stubDb({
    rows: [
      { id: 'vps-1', name: 'codesandbox/expired.json', credentialFingerprint: 'sha256:x', status: { status: 'EXPIRED', quotas: [] } }
    ],
    sessionRows: []
  });

  await assert.rejects(
    () => getAvailableCredential('codesandbox'),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, NO_AVAILABLE_CREDENTIAL);
      assert.equal(error.statusCode, 409);
      return true;
    }
  );
  clearDbStub();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function candidate(overrides = {}) {
  return {
    id: overrides.id ?? 'vps-1',
    provider: 'codesandbox',
    credentialRef: overrides.credentialRef ?? 'codesandbox/a.json',
    displayName: overrides.displayName ?? 'a',
    credentialFingerprint: overrides.credentialFingerprint ?? 'sha256:aaa',
    status: overrides.status ?? null,
    statusCheckedAt: null,
    createdAt: overrides.createdAt ?? null,
    ...overrides
  };
}

function withStatus(status, extra = {}) {
  return JSON.stringify({ status, quotas: [], ...extra });
}

function computeQuota(remaining, name = 'Codespaces compute (core-hours)') {
  return { name, quotaUnit: 'core-hours', quotaPeriod: 'month', usage: 0, limit: remaining, remaining };
}

// ---------------------------------------------------------------------------
// Core-hours extraction
// ---------------------------------------------------------------------------
test('extractCoreHoursRemaining reads the compute quota remaining value', () => {
  assert.equal(extractCoreHoursRemaining([computeQuota(42.5)]), 42.5);
});

test('extractCoreHoursRemaining derives remaining from limit - usage', () => {
  const quotas = [{ name: 'Codespaces compute (core-hours)', quotaUnit: 'core-hours', limit: 120, usage: 30 }];
  assert.equal(extractCoreHoursRemaining(quotas), 90);
});

test('extractCoreHoursRemaining ignores non-compute quotas', () => {
  const quotas = [
    { name: 'Codespaces storage (GB-month)', quotaUnit: 'GB-month', limit: 15, usage: 0, remaining: 15 },
    { name: 'Codespaces compute (minutes)', quotaUnit: 'minutes', limit: 6000, usage: 0, remaining: 6000 }
  ];
  assert.equal(extractCoreHoursRemaining(quotas), null);
  assert.equal(extractCoreHoursRemaining(null), null);
  assert.equal(extractCoreHoursRemaining([]), null);
});

test('isComputeQuota matches core-hour units', () => {
  assert.equal(isComputeQuota({ quotaUnit: 'core-hours' }), true);
  assert.equal(isComputeQuota({ name: 'Codespaces compute (core-hours)' }), false);
  assert.equal(isComputeQuota({ quotaUnit: 'core-hours', name: 'Codespaces compute (core-hours)' }), true);
  assert.equal(isComputeQuota({ quotaUnit: 'GB-month' }), false);
});

test('asStatusObject parses JSON strings and passes objects through', () => {
  assert.deepEqual(asStatusObject('{"status":"AVAILABLE"}'), { status: 'AVAILABLE' });
  assert.deepEqual(asStatusObject({ status: 'AVAILABLE' }), { status: 'AVAILABLE' });
  assert.equal(asStatusObject('not json'), null);
  assert.equal(asStatusObject(null), null);
});

// ---------------------------------------------------------------------------
// Standard providers: first eligible credential in registration order
// ---------------------------------------------------------------------------
test('standard provider returns the first eligible credential', async () => {
  const result = await getAvailableCredential('codesandbox', {
    candidates: [
      candidate({ id: '1', credentialRef: 'codesandbox/first.json', credentialFingerprint: 'sha256:first' }),
      candidate({ id: '2', credentialRef: 'codesandbox/second.json', credentialFingerprint: 'sha256:second' })
    ],
    inUseKeys: []
  });

  assert.equal(result.credentialRef, 'codesandbox/first.json');
  assert.equal(result.strategy, 'first-available');
  assert.equal(result.provider, 'codesandbox');
});

test('standard provider skips credentials backing an active session', async () => {
  const result = await getAvailableCredential('codesandbox', {
    candidates: [
      candidate({ id: '1', credentialRef: 'codesandbox/first.json', credentialFingerprint: 'sha256:first' }),
      candidate({ id: '2', credentialRef: 'codesandbox/second.json', credentialFingerprint: 'sha256:second' })
    ],
    inUseKeys: ['sha256:first']
  });

  assert.equal(result.credentialRef, 'codesandbox/second.json');
  assert.equal(result.inUse, false);
});

test('standard provider skips expired / invalid / quota-exhausted credentials', async () => {
  const result = await getAvailableCredential('codesandbox', {
    candidates: [
      candidate({ id: '1', credentialFingerprint: 'sha256:1', status: withStatus('EXPIRED') }),
      candidate({ id: '2', credentialFingerprint: 'sha256:2', status: withStatus('INVALID') }),
      candidate({ id: '3', credentialFingerprint: 'sha256:3', status: withStatus('QUOTA_EXHAUSTED') }),
      candidate({ id: '4', credentialFingerprint: 'sha256:4', status: withStatus('UNAVAILABLE') }),
      candidate({ id: '5', credentialFingerprint: 'sha256:5', status: withStatus('AVAILABLE') })
    ],
    inUseKeys: []
  });

  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.credentialFingerprint, 'sha256:5');
});

test('a credential marked LIMITED is treated as in use', async () => {
  const result = await getAvailableCredential('codesandbox', {
    candidates: [
      candidate({ id: '1', credentialFingerprint: null, credentialRef: 'codesandbox/limited.json', status: withStatus('LIMITED') }),
      candidate({ id: '2', credentialFingerprint: 'sha256:2', credentialRef: 'codesandbox/ok.json', status: withStatus('AVAILABLE') })
    ],
    inUseKeys: []
  });

  assert.equal(result.credentialRef, 'codesandbox/ok.json');
});

// ---------------------------------------------------------------------------
// Codespaces: highest remaining core-hours wins
// ---------------------------------------------------------------------------
test('codespaces picks the credential with the most remaining core-hours', async () => {
  const result = await getAvailableCredential('codespaces', {
    candidates: [
      candidate({
        id: '1', provider: 'codespaces', credentialRef: 'codespaces/low.json',
        credentialFingerprint: 'sha256:low',
        status: JSON.stringify({ status: 'AVAILABLE', quotas: [computeQuota(10)] })
      }),
      candidate({
        id: '2', provider: 'codespaces', credentialRef: 'codespaces/high.json',
        credentialFingerprint: 'sha256:high',
        status: JSON.stringify({ status: 'AVAILABLE', quotas: [computeQuota(75)] })
      }),
      candidate({
        id: '3', provider: 'codespaces', credentialRef: 'codespaces/mid.json',
        credentialFingerprint: 'sha256:mid',
        status: JSON.stringify({ status: 'AVAILABLE', quotas: [computeQuota(40)] })
      })
    ],
    inUseKeys: []
  });

  assert.equal(result.credentialRef, 'codespaces/high.json');
  assert.equal(result.coreHoursRemaining, 75);
  assert.equal(result.strategy, 'max-core-hours');
});

test('codespaces ranking ignores credentials that are in use or unusable', async () => {
  const result = await getAvailableCredential('codespaces', {
    candidates: [
      candidate({
        id: '1', provider: 'codespaces', credentialRef: 'codespaces/busy.json',
        credentialFingerprint: 'sha256:busy',
        status: JSON.stringify({ status: 'AVAILABLE', quotas: [computeQuota(200)] })
      }),
      candidate({
        id: '2', provider: 'codespaces', credentialRef: 'codespaces/exhausted.json',
        credentialFingerprint: 'sha256:exhausted',
        status: JSON.stringify({ status: 'QUOTA_EXHAUSTED', quotas: [computeQuota(0)] })
      }),
      candidate({
        id: '3', provider: 'codespaces', credentialRef: 'codespaces/ok.json',
        credentialFingerprint: 'sha256:ok',
        status: JSON.stringify({ status: 'AVAILABLE', quotas: [computeQuota(5)] })
      })
    ],
    inUseKeys: ['sha256:busy']
  });

  assert.equal(result.credentialRef, 'codespaces/ok.json');
  assert.equal(result.coreHoursRemaining, 5);
});

test('codespaces ranking treats a credential without a compute quota as zero capacity', async () => {
  const result = await getAvailableCredential('codespaces', {
    candidates: [
      candidate({
        id: '1', provider: 'codespaces', credentialRef: 'codespaces/noquota.json',
        credentialFingerprint: 'sha256:noquota',
        status: JSON.stringify({ status: 'AVAILABLE', quotas: [] })
      }),
      candidate({
        id: '2', provider: 'codespaces', credentialRef: 'codespaces/withquota.json',
        credentialFingerprint: 'sha256:withquota',
        status: JSON.stringify({ status: 'AVAILABLE', quotas: [computeQuota(3)] })
      })
    ],
    inUseKeys: []
  });

  assert.equal(result.credentialRef, 'codespaces/withquota.json');
});

test('codespaces ranking ignores compute quotas not metered in core-hours', async () => {
  const result = await getAvailableCredential('codespaces', {
    candidates: [
      candidate({
        id: '1', provider: 'codespaces', credentialRef: 'codespaces/minutes.json',
        credentialFingerprint: 'sha256:minutes',
        status: JSON.stringify({
          status: 'AVAILABLE',
          quotas: [{ name: 'Codespaces compute (minutes)', quotaUnit: 'minutes', remaining: 6000 }]
        })
      }),
      candidate({
        id: '2', provider: 'codespaces', credentialRef: 'codespaces/core-hours.json',
        credentialFingerprint: 'sha256:core-hours',
        status: JSON.stringify({ status: 'AVAILABLE', quotas: [computeQuota(5)] })
      })
    ],
    inUseKeys: []
  });

  assert.equal(result.credentialRef, 'codespaces/core-hours.json');
  assert.equal(result.coreHoursRemaining, 5);
});

// ---------------------------------------------------------------------------
// GCS: every provider enforces in-use detection; GCS keys off credentialRef
// ---------------------------------------------------------------------------
test('gcs excludes a credential that backs a live session', async () => {
  const result = await getAvailableCredential('gcs', {
    candidates: [
      candidate({ id: '1', provider: 'gcs', credentialRef: 'gcloud/a.json', credentialFingerprint: 'sha256:a' }),
      candidate({ id: '2', provider: 'gcs', credentialRef: 'gcloud/b.json', credentialFingerprint: 'sha256:b' })
    ],
    inUseKeys: ['gcloud/a.json']
  });

  assert.equal(result.credentialRef, 'gcloud/b.json');
  assert.equal(result.inUse, false);
  assert.equal(result.inUseKnown, true);
  assert.equal(result.strategy, 'first-available');
});

test('inUseKnown is true for every supported provider', async () => {
  const result = await getAvailableCredential('gcs', {
    candidates: [
      candidate({
        id: '1', provider: 'gcs', credentialRef: 'gcloud/a.json',
        credentialFingerprint: null,
        status: JSON.stringify({ status: 'AVAILABLE', quotas: [] })
      })
    ],
    inUseKeys: []
  });

  assert.equal(result.inUse, false);
  assert.equal(result.inUseKnown, true);
});
// ---------------------------------------------------------------------------
// Empty / exhausted candidate lists
// ---------------------------------------------------------------------------
test('empty candidate list raises NO_AVAILABLE_CREDENTIAL (409)', async () => {
  await assert.rejects(
    () => getAvailableCredential('codesandbox', { candidates: [], inUseKeys: [] }),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, NO_AVAILABLE_CREDENTIAL);
      assert.equal(error.statusCode, 409);
      assert.equal(error.details.reason, NO_REGISTERED_CREDENTIALS);
      assert.equal(error.details.considered, 0);
      return true;
    }
  );
});

test('all candidates in use raises NO_AVAILABLE_CREDENTIAL', async () => {
  await assert.rejects(
    () => getAvailableCredential('codesandbox', {
      candidates: [
        candidate({ id: '1', credentialFingerprint: 'sha256:1' }),
        candidate({ id: '2', credentialFingerprint: 'sha256:2' })
      ],
      inUseKeys: ['sha256:1', 'sha256:2']
    }),
    (error) => {
      assert.equal(error.code, NO_AVAILABLE_CREDENTIAL);
      assert.equal(error.details.reason, ALL_IN_USE_OR_UNUSABLE);
      assert.equal(error.details.inUse, 2);
      return true;
    }
  );
});

test('all in-use GCS candidates raise NO_AVAILABLE_CREDENTIAL', async () => {
  await assert.rejects(
    () => getAvailableCredential('gcs', {
      candidates: [
        candidate({ id: '1', provider: 'gcs', credentialRef: 'gcloud/one.json' }),
        candidate({ id: '2', provider: 'gcs', credentialRef: 'gcloud/two.json' })
      ],
      inUseKeys: ['gcloud/one.json', 'gcloud/two.json']
    }),
    (error) => {
      assert.equal(error.code, NO_AVAILABLE_CREDENTIAL);
      assert.equal(error.statusCode, 409);
      assert.equal(error.details.reason, ALL_IN_USE_OR_UNUSABLE);
      assert.equal(error.details.inUse, 2);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Provider validation
// ---------------------------------------------------------------------------
test('unknown provider raises VPS_INVALID_PROVIDER (400)', async () => {
  await assert.rejects(
    () => getAvailableCredential('nope', { candidates: [] }),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, 'VPS_INVALID_PROVIDER');
      assert.equal(error.statusCode, 400);
      return true;
    }
  );
});

test('missing provider raises VPS_INVALID_PROVIDER (400)', async () => {
  await assert.rejects(
    () => getAvailableCredential(undefined, { candidates: [] }),
    (error) => {
      assert.equal(error.code, 'VPS_INVALID_PROVIDER');
      return true;
    }
  );
});
