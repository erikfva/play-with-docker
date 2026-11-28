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

function loadProviderWithMocks({
  dbCredential = { token: 'ghp_secretToken12345678901234567890', credentialFingerprint: 'sha256:abc12345' },
  dbError = null,
  existingCodespaces = [],
  createdCodespaceName = 'new-codespace-123',
  cliListError = null,
  cliCreateError = null,
  getCodespaceResult = null,
  getCodespaceError = null,
  deleteCodespaceError = null
} = {}) {
  const calls = {
    cliList: [],
    cliCreate: [],
    getCodespace: [],
    deleteCodespace: [],
    invalidateCache: []
  };

  const dbPath = require.resolve('../src/db/db');
  const dbLoaderPath = require.resolve('../src/services/db-credentials-loader');
  const cliExecutorPath = require.resolve('../src/services/providers/codespaces/cli-executor');
  const clientPath = require.resolve('../src/services/providers/codespaces/client');
  const statusCachePath = require.resolve('../src/services/status-cache');
  const providerPath = require.resolve('../src/services/providers/codespaces-provider');

  delete require.cache[providerPath];

  stubModule(dbPath, {
    get: async () => null,
    run: async () => undefined,
    all: async () => [],
    pool: {
      end: async () => undefined,
      connect: async () => ({
        query: async () => ({}),
        release: () => undefined
      })
    },
    ready: Promise.resolve()
  });

  stubModule(dbLoaderPath, {
    loadCredentialByRef: async (provider, ref) => {
      if (dbError) throw dbError;
      return {
        ...dbCredential,
        credentialRef: ref
      };
    }
  });

  stubModule(cliExecutorPath, {
    listCodespacesViaCli: async (token, opts) => {
      calls.cliList.push({ token, opts });
      if (cliListError) throw cliListError;
      return existingCodespaces;
    },
    createCodespaceViaCli: async (options, token) => {
      calls.cliCreate.push({ options, token });
      if (cliCreateError) throw cliCreateError;
      existingCodespaces.push({ name: createdCodespaceName });
      return createdCodespaceName;
    },
    executeInCodespace: async () => ({ output: '' }),
    GEO_TO_CLI_LOCATION: {
      UsEast: 'EastUs',
      UsWest: 'WestUs2',
      EuropeWest: 'WestEurope',
      SoutheastAsia: 'SouthEastAsia'
    },
    BOOT_TIMEOUT_MS: 90000,
    COMMAND_TIMEOUT_MS: 30000
  });

  stubModule(clientPath, {
    getCodespace: async (token, name, opts) => {
      calls.getCodespace.push({ token, name, opts });
      if (getCodespaceError) throw getCodespaceError;
      return (
        getCodespaceResult || {
          name,
          display_name: 'Display ' + name,
          state: 'Available',
          machine: { name: 'basicLinux32gb' },
          location: 'WestUs2',
          web_url: `https://${name}.github.dev`
        }
      );
    },
    deleteCodespace: async (token, name) => {
      calls.deleteCodespace.push({ token, name });
      if (deleteCodespaceError) throw deleteCodespaceError;
      return {};
    },
    invalidateCodespace: () => {},
    listCodespaces: async () => [],
    validateToken: async () => ({ login: 'testuser' })
  });

  stubModule(statusCachePath, {
    cacheKey: (provider, fp) => `${provider}:${fp}`,
    invalidateCache: (key) => {
      calls.invalidateCache.push(key);
    }
  });

  const CodespacesProvider = require('../src/services/providers/codespaces-provider');
  const provider = new CodespacesProvider();

  return { provider, calls };
}

test('ensureCodespace rejects invalid repository upfront', async () => {
  const { provider } = loadProviderWithMocks();
  await assert.rejects(
    () => provider.ensureCodespace({ credentialRef: 'ref1', repository: 'invalid-repo' }),
    (err) => {
      assert.strictEqual(err.code, 'CODESPACES_INVALID_REPOSITORY');
      assert.strictEqual(err.statusCode, 400);
      return true;
    }
  );
});

test('ensureCodespace validates CODESPACES_DEFAULT_REPOSITORY from env and rejects invalid format with 500', async () => {
  const originalEnv = process.env.CODESPACES_DEFAULT_REPOSITORY;
  process.env.CODESPACES_DEFAULT_REPOSITORY = 'not-owner-repo';
  try {
    const { provider } = loadProviderWithMocks();
    await assert.rejects(
      () => provider.ensureCodespace({ credentialRef: 'ref1' }),
      (err) => {
        assert.strictEqual(err.code, 'CODESPACES_REPOSITORY_NOT_CONFIGURED');
        assert.strictEqual(err.statusCode, 500);
        return true;
      }
    );
  } finally {
    if (originalEnv === undefined) {
      delete process.env.CODESPACES_DEFAULT_REPOSITORY;
    } else {
      process.env.CODESPACES_DEFAULT_REPOSITORY = originalEnv;
    }
  }
});

test('ensureCodespace rejects invalid or wrongly typed branch values with 400', async () => {
  const { provider } = loadProviderWithMocks();
  for (const badBranch of [{}, 123, true, '', 'branch with spaces', 'a'.repeat(256)]) {
    await assert.rejects(
      () => provider.ensureCodespace({ credentialRef: 'ref1', branch: badBranch }),
      (err) => {
        assert.strictEqual(err.code, 'CODESPACES_INVALID_BRANCH');
        assert.strictEqual(err.statusCode, 400);
        return true;
      }
    );
  }
});

test('ensureCodespace rejects invalid or wrongly typed displayName values with 400', async () => {
  const { provider } = loadProviderWithMocks();
  for (const badName of [{}, 123, true, '', 'a'.repeat(49)]) {
    await assert.rejects(
      () => provider.ensureCodespace({ credentialRef: 'ref1', displayName: badName }),
      (err) => {
        assert.strictEqual(err.code, 'CODESPACES_INVALID_DISPLAY_NAME');
        assert.strictEqual(err.statusCode, 400);
        return true;
      }
    );
  }
});

test('ensureCodespace rejects invalid machine upfront', async () => {
  const { provider } = loadProviderWithMocks();
  await assert.rejects(
    () => provider.ensureCodespace({ credentialRef: 'ref1', machine: 'invalidMachine' }),
    (err) => {
      assert.strictEqual(err.code, 'CODESPACES_INVALID_MACHINE');
      assert.strictEqual(err.statusCode, 400);
      return true;
    }
  );
});

test('ensureCodespace rejects wrongly typed machine values (number, object, boolean) with 400 without falling back to env', async () => {
  const originalEnv = process.env.CODESPACES_DEFAULT_MACHINE;
  process.env.CODESPACES_DEFAULT_MACHINE = 'basicLinux32gb'; // valid default
  try {
    const { provider } = loadProviderWithMocks();
    for (const badMachine of [123, {}, true, '']) {
      await assert.rejects(
        () => provider.ensureCodespace({ credentialRef: 'ref1', machine: badMachine }),
        (err) => {
          assert.strictEqual(err.code, 'CODESPACES_INVALID_MACHINE');
          assert.strictEqual(err.statusCode, 400);
          return true;
        }
      );
    }
  } finally {
    if (originalEnv === undefined) {
      delete process.env.CODESPACES_DEFAULT_MACHINE;
    } else {
      process.env.CODESPACES_DEFAULT_MACHINE = originalEnv;
    }
  }
});

test('ensureCodespace rejects wrongly typed geo values (number, object, boolean) with 400 without falling back to env', async () => {
  const originalEnv = process.env.CODESPACES_DEFAULT_GEO;
  process.env.CODESPACES_DEFAULT_GEO = 'UsWest'; // valid default
  try {
    const { provider } = loadProviderWithMocks();
    for (const badGeo of [123, {}, true, '']) {
      await assert.rejects(
        () => provider.ensureCodespace({ credentialRef: 'ref1', geo: badGeo }),
        (err) => {
          assert.strictEqual(err.code, 'CODESPACES_INVALID_GEO');
          assert.strictEqual(err.statusCode, 400);
          return true;
        }
      );
    }
  } finally {
    if (originalEnv === undefined) {
      delete process.env.CODESPACES_DEFAULT_GEO;
    } else {
      process.env.CODESPACES_DEFAULT_GEO = originalEnv;
    }
  }
});

test('ensureCodespace rejects invalid geo upfront', async () => {
  const { provider } = loadProviderWithMocks();
  await assert.rejects(
    () => provider.ensureCodespace({ credentialRef: 'ref1', geo: 'invalidGeo' }),
    (err) => {
      assert.strictEqual(err.code, 'CODESPACES_INVALID_GEO');
      assert.strictEqual(err.statusCode, 400);
      return true;
    }
  );
});

test('ensureCodespace validates CODESPACES_DEFAULT_MACHINE from env when options.machine is omitted', async () => {
  const originalEnv = process.env.CODESPACES_DEFAULT_MACHINE;
  process.env.CODESPACES_DEFAULT_MACHINE = 'invalidEnvMachine';
  try {
    const { provider } = loadProviderWithMocks();
    await assert.rejects(
      () => provider.ensureCodespace({ credentialRef: 'ref1' }),
      (err) => {
        assert.strictEqual(err.code, 'CODESPACES_INVALID_MACHINE');
        assert.strictEqual(err.statusCode, 400);
        return true;
      }
    );
  } finally {
    if (originalEnv === undefined) {
      delete process.env.CODESPACES_DEFAULT_MACHINE;
    } else {
      process.env.CODESPACES_DEFAULT_MACHINE = originalEnv;
    }
  }
});

test('ensureCodespace validates CODESPACES_DEFAULT_GEO from env when options.geo is omitted', async () => {
  const originalEnv = process.env.CODESPACES_DEFAULT_GEO;
  process.env.CODESPACES_DEFAULT_GEO = 'invalidEnvGeo';
  try {
    const { provider } = loadProviderWithMocks();
    await assert.rejects(
      () => provider.ensureCodespace({ credentialRef: 'ref1' }),
      (err) => {
        assert.strictEqual(err.code, 'CODESPACES_INVALID_GEO');
        assert.strictEqual(err.statusCode, 400);
        return true;
      }
    );
  } finally {
    if (originalEnv === undefined) {
      delete process.env.CODESPACES_DEFAULT_GEO;
    } else {
      process.env.CODESPACES_DEFAULT_GEO = originalEnv;
    }
  }
});

test('ensureCodespace returns existing codespace without calling create when found', async () => {
  const { provider, calls } = loadProviderWithMocks({
    existingCodespaces: [{ name: 'existing-vm-1' }]
  });

  const result = await provider.ensureCodespace({
    credentialRef: 'etecnologysys1alwaysdata'
  });

  assert.strictEqual(result.created, false);
  assert.strictEqual(result.providerSessionId, 'existing-vm-1');
  assert.strictEqual(result.codespace.status, 'RUNNING');
  assert.strictEqual(calls.cliList.length, 1);
  assert.strictEqual(calls.cliCreate.length, 0); // Must NOT create
  assert.strictEqual(calls.invalidateCache.length, 0); // No status cache invalidation when existing
});

test('ensureCodespace creates codespace with default repository vm-manager235-1/test when list is empty', async () => {
  const { provider, calls } = loadProviderWithMocks({
    existingCodespaces: [],
    createdCodespaceName: 'brand-new-codespace'
  });

  const result = await provider.ensureCodespace({
    credentialRef: 'etecnologysys1alwaysdata',
    geo: 'UsWest',
    branch: 'feature/rpc',
    displayName: 'My-Codespace'
  });

  assert.strictEqual(result.created, true);
  assert.strictEqual(result.providerSessionId, 'brand-new-codespace');
  assert.strictEqual(calls.cliList.length, 1);
  assert.strictEqual(calls.cliCreate.length, 1);
  assert.strictEqual(calls.cliCreate[0].options.repo, 'vm-manager235-1/test');
  assert.strictEqual(calls.cliCreate[0].options.location, 'WestUs2');
  assert.strictEqual(calls.cliCreate[0].options.branch, 'feature/rpc');
  assert.strictEqual(calls.cliCreate[0].options.displayName, 'My-Codespace');
  assert.strictEqual(calls.getCodespace.length, 1);
  assert.strictEqual(calls.getCodespace[0].name, 'brand-new-codespace');
  assert.strictEqual(calls.invalidateCache.length, 1);
  assert.strictEqual(calls.invalidateCache[0], 'codespaces:sha256:abc12345');
});

test('concurrent ensureCodespace requests for one credential only create one VM', async () => {
  const { provider, calls } = loadProviderWithMocks({
    existingCodespaces: [],
    createdCodespaceName: 'one-created-codespace'
  });

  const results = await Promise.all([
    provider.ensureCodespace({ credentialRef: 'etecnologysys1alwaysdata' }),
    provider.ensureCodespace({ credentialRef: 'etecnologysys1alwaysdata' })
  ]);

  assert.strictEqual(calls.cliCreate.length, 1);
  assert.deepStrictEqual(results.map((result) => result.created).sort(), [false, true]);
});

test('ensureCodespace cleans up orphan when post-create confirmation fails', async () => {
  const confirmErr = new Error('Codespace unreachable after create');
  confirmErr.statusCode = 400;

  const { provider, calls } = loadProviderWithMocks({
    existingCodespaces: [],
    createdCodespaceName: 'orphan-codespace',
    getCodespaceError: confirmErr
  });

  await assert.rejects(
    () => provider.ensureCodespace({ credentialRef: 'etecnologysys1alwaysdata' }),
    (err) => {
      assert.strictEqual(err.message, 'Codespace unreachable after create');
      return true;
    }
  );

  assert.strictEqual(calls.cliCreate.length, 1);
  assert.strictEqual(calls.deleteCodespace.length, 1);
  assert.strictEqual(calls.deleteCodespace[0].name, 'orphan-codespace');
});

test('ensureCodespace leaves the new VM intact when confirmation fails transiently', async () => {
  const confirmErr = new Error('GitHub API rate limit exceeded');
  confirmErr.statusCode = 429;

  const { provider, calls } = loadProviderWithMocks({
    existingCodespaces: [],
    createdCodespaceName: 'created-but-unconfirmed',
    getCodespaceError: confirmErr
  });

  await assert.rejects(
    () => provider.ensureCodespace({ credentialRef: 'etecnologysys1alwaysdata' }),
    (err) => {
      assert.strictEqual(err, confirmErr);
      return true;
    }
  );

  assert.strictEqual(calls.cliCreate.length, 1);
  assert.strictEqual(calls.deleteCodespace.length, 0);
});

test('ensureCodespace propagates VPS_NOT_FOUND when credentialRef is not in vps table', async () => {
  const { ProviderError } = require('../src/services/errors/provider-errors');
  const notFoundErr = new ProviderError('VPS not found: codespaces/nonexistent', {
    code: 'VPS_NOT_FOUND',
    statusCode: 404
  });

  const { provider } = loadProviderWithMocks({
    dbError: notFoundErr
  });

  await assert.rejects(
    () => provider.ensureCodespace({ credentialRef: 'nonexistent' }),
    (err) => {
      assert.strictEqual(err.code, 'VPS_NOT_FOUND');
      assert.strictEqual(err.statusCode, 404);
      return true;
    }
  );
});

test('ensureCodespace redacts tokens from confirmation failure warning log', async () => {
  const secretToken = 'ghp_secretToken12345678901234567890';
  const confirmErr = new Error(`Authentication failure using ${secretToken}`);
  confirmErr.statusCode = 401;

  const warned = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warned.push(args.join(' '));
  };

  try {
    const { provider } = loadProviderWithMocks({
      existingCodespaces: [],
      createdCodespaceName: 'orphan-codespace',
      getCodespaceError: confirmErr
    });

    await assert.rejects(
      () => provider.ensureCodespace({ credentialRef: 'etecnologysys1alwaysdata' }),
      (err) => {
        assert.match(err.message, /Authentication failure/);
        return true;
      }
    );

    // Verify token was redacted in console.warn log
    assert.strictEqual(warned.length > 0, true);
    for (const log of warned) {
      assert.strictEqual(log.includes(secretToken), false, `Token leaked in log: ${log}`);
      assert.strictEqual(log.includes('[REDACTED]'), true, `Expected [REDACTED] in log: ${log}`);
    }
  } finally {
    console.warn = originalWarn;
  }
});

