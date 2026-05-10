const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const { ProviderError } = require('../src/services/errors/provider-errors');

function stubModule(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports
  };
}

async function withCredentialDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesandbox-provider-creds-'));
  const previousEnv = {
    CODESANDBOX_DOCKER_TEMPLATE_ID: process.env.CODESANDBOX_DOCKER_TEMPLATE_ID,
    S3FS_ENABLED: process.env.S3FS_ENABLED,
    S3_MOUNT_DIR: process.env.S3_MOUNT_DIR,
    S3_BUCKET: process.env.S3_BUCKET
  };

  process.env.S3_MOUNT_DIR = dir;
  process.env.S3FS_ENABLED = '1';
  process.env.S3_BUCKET = 'play-with-docker';
  delete process.env.CODESANDBOX_DOCKER_TEMPLATE_ID;

  try {
    await fn(dir);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('creates CodeSandbox sessions from the Docker template id, not the docker slug', async () => {
  await withCredentialDir(async (dir) => {
    const createdOptions = [];
    const dbPath = require.resolve('../src/db/db');
    const clientPath = require.resolve('../src/services/providers/codesandbox/client');
    const providerPath = require.resolve('../src/services/providers/codesandbox-provider');

    delete require.cache[providerPath];
    stubModule(dbPath, {
      get: async () => null,
      run: async () => undefined,
      all: async () => [],
      pool: { end: async () => undefined },
      ready: Promise.resolve()
    });
    stubModule(clientPath, {
      getClient: () => ({
        sandboxes: {
          create: async (options) => {
            createdOptions.push(options);
            return {
              id: 'created-sandbox-id',
              title: options.title,
              status: 'RUNNING',
              cluster: 'test-cluster',
              bootupType: 'FORK',
              isUpToDate: true
            };
          },
          resume: async (sandboxId) => {
            assert.equal(sandboxId, 'created-sandbox-id');
            return {
              connect: async () => ({
                commands: {
                  run: async () => 'DOCKER_HOST=tcp://192.168.241.2:2375\n'
                },
                dispose: async () => undefined
              })
            };
          }
        }
      }),
      clearCache: () => undefined
    });

    await fs.writeFile(path.join(dir, 'account.json'), JSON.stringify({ token: 'test-token' }));

    const CodeSandboxProvider = require('../src/services/providers/codesandbox-provider');
    const provider = new CodeSandboxProvider();
    const session = await provider.createSession({
      credentialRef: 'account.json',
      title: 'docker-template-test',
      templateId: 'docker',
      vmTier: 'Nano'
    });

    assert.equal(createdOptions.length, 1);
    assert.equal(createdOptions[0].id, 'hsd8ke');
    assert.notEqual(createdOptions[0].id, 'docker');
    assert.equal(session.provider, 'codesandbox');
    assert.equal(session.providerSessionId, 'created-sandbox-id');
    assert.equal(session.credentialRef, 'account.json');
    assert.match(session.credentialFingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.equal(session.metadata.dockerHost, 'tcp://192.168.241.2:2375');
  });
});

test('executes CodeSandbox commands through resume, connect, run, and dispose', async () => {
  await withCredentialDir(async (dir) => {
    const calls = [];
    const dbPath = require.resolve('../src/db/db');
    const clientPath = require.resolve('../src/services/providers/codesandbox/client');
    const providerPath = require.resolve('../src/services/providers/codesandbox-provider');

    delete require.cache[providerPath];
    stubModule(dbPath, {
      get: async () => null,
      run: async () => undefined,
      all: async () => [],
      pool: { end: async () => undefined },
      ready: Promise.resolve()
    });
    stubModule(clientPath, {
      getClient: () => ({
        sandboxes: {
          resume: async (sandboxId) => {
            calls.push(['resume', sandboxId]);
            return {
              connect: async () => {
                calls.push(['connect']);
                return {
                  commands: {
                    run: async (command) => {
                      calls.push(['run', command]);
                      return 'command-output';
                    }
                  },
                  dispose: () => {
                    calls.push(['dispose']);
                  }
                };
              }
            };
          }
        }
      }),
      clearCache: () => undefined
    });

    await fs.writeFile(path.join(dir, 'account.json'), JSON.stringify({ token: 'test-token' }));

    const CodeSandboxProvider = require('../src/services/providers/codesandbox-provider');
    const provider = new CodeSandboxProvider();
    const result = await provider.executeCommand(
      {
        providerSessionId: 'sandbox-id',
        credentialRef: 'account.json',
        credentialFingerprint: 'sha256:test'
      },
      'pwd && echo ok'
    );

    assert.deepEqual(calls, [
      ['resume', 'sandbox-id'],
      ['connect'],
      ['run', 'pwd && echo ok'],
      ['dispose']
    ]);
    assert.equal(result.output, 'command-output');
  });
});

test('injects prepared Docker host into CodeSandbox command execution', async () => {
  await withCredentialDir(async (dir) => {
    const calls = [];
    const dbPath = require.resolve('../src/db/db');
    const clientPath = require.resolve('../src/services/providers/codesandbox/client');
    const providerPath = require.resolve('../src/services/providers/codesandbox-provider');

    delete require.cache[providerPath];
    stubModule(dbPath, {
      get: async () => null,
      run: async () => undefined,
      all: async () => [],
      pool: { end: async () => undefined },
      ready: Promise.resolve()
    });
    stubModule(clientPath, {
      getClient: () => ({
        sandboxes: {
          resume: async () => ({
            connect: async () => ({
              commands: {
                run: async (command) => {
                  calls.push(command);
                  return 'command-output';
                }
              },
              dispose: async () => undefined
            })
          })
        }
      }),
      clearCache: () => undefined
    });

    await fs.writeFile(path.join(dir, 'account.json'), JSON.stringify({ token: 'test-token' }));

    const CodeSandboxProvider = require('../src/services/providers/codesandbox-provider');
    const provider = new CodeSandboxProvider();
    await provider.executeCommand(
      {
        providerSessionId: 'sandbox-id',
        credentialRef: 'account.json',
        credentialFingerprint: 'sha256:test',
        metadata: JSON.stringify({ dockerHost: 'tcp://192.168.241.2:2375' })
      },
      'docker ps'
    );

    assert.equal(calls[0], "export DOCKER_HOST='tcp://192.168.241.2:2375'; docker ps");
  });
});

test('translates CodeSandbox command failures to command-specific provider errors', async () => {
  await withCredentialDir(async (dir) => {
    const dbPath = require.resolve('../src/db/db');
    const clientPath = require.resolve('../src/services/providers/codesandbox/client');
    const providerPath = require.resolve('../src/services/providers/codesandbox-provider');

    delete require.cache[providerPath];
    stubModule(dbPath, {
      get: async () => null,
      run: async () => undefined,
      all: async () => [],
      pool: { end: async () => undefined },
      ready: Promise.resolve()
    });
    stubModule(clientPath, {
      getClient: () => ({
        sandboxes: {
          resume: async () => ({
            connect: async () => ({
              commands: {
                run: async () => {
                  const error = new Error('Command failed with non-zero exit code');
                  error.name = 'CommandError';
                  error.exitCode = 127;
                  error.output = 'node: not found';
                  throw error;
                }
              },
              dispose: () => undefined
            })
          })
        }
      }),
      clearCache: () => undefined
    });

    await fs.writeFile(path.join(dir, 'account.json'), JSON.stringify({ token: 'test-token' }));

    const CodeSandboxProvider = require('../src/services/providers/codesandbox-provider');
    const provider = new CodeSandboxProvider();

    await assert.rejects(
      provider.executeCommand(
        {
          providerSessionId: 'sandbox-id',
          credentialRef: 'account.json',
          credentialFingerprint: 'sha256:test'
        },
        'node --version'
      ),
      (error) => error instanceof ProviderError
        && error.code === 'CODESANDBOX_COMMAND_FAILED'
        && error.details.exitCode === 127
        && error.details.output === 'node: not found'
    );
  });
});

test('terminates CodeSandbox sessions by shutting down the VM before deleting the sandbox', async () => {
  await withCredentialDir(async (dir) => {
    const calls = [];
    const dbPath = require.resolve('../src/db/db');
    const clientPath = require.resolve('../src/services/providers/codesandbox/client');
    const providerPath = require.resolve('../src/services/providers/codesandbox-provider');

    delete require.cache[providerPath];
    stubModule(dbPath, {
      get: async () => null,
      run: async () => undefined,
      all: async () => [],
      pool: { end: async () => undefined },
      ready: Promise.resolve()
    });
    stubModule(clientPath, {
      getClient: () => ({
        sandboxes: {
          shutdown: async (sandboxId) => {
            calls.push(['shutdown', sandboxId]);
          },
          delete: async (sandboxId) => {
            calls.push(['delete', sandboxId]);
          }
        }
      }),
      clearCache: () => undefined
    });

    await fs.writeFile(path.join(dir, 'account.json'), JSON.stringify({ token: 'test-token' }));

    const CodeSandboxProvider = require('../src/services/providers/codesandbox-provider');
    const provider = new CodeSandboxProvider();
    await provider.terminateSession({
      providerSessionId: 'sandbox-id',
      credentialRef: 'account.json',
      credentialFingerprint: 'sha256:test'
    });

    assert.deepEqual(calls, [
      ['shutdown', 'sandbox-id'],
      ['delete', 'sandbox-id']
    ]);
  });
});

test('treats a missing CodeSandbox sandbox during termination as already cleaned up', async () => {
  await withCredentialDir(async (dir) => {
    const dbPath = require.resolve('../src/db/db');
    const clientPath = require.resolve('../src/services/providers/codesandbox/client');
    const providerPath = require.resolve('../src/services/providers/codesandbox-provider');

    delete require.cache[providerPath];
    stubModule(dbPath, {
      get: async () => null,
      run: async () => undefined,
      all: async () => [],
      pool: { end: async () => undefined },
      ready: Promise.resolve()
    });
    stubModule(clientPath, {
      getClient: () => ({
        sandboxes: {
          shutdown: async () => undefined,
          delete: async () => {
            throw new Error('Sandbox not found');
          }
        }
      }),
      clearCache: () => undefined
    });

    await fs.writeFile(path.join(dir, 'account.json'), JSON.stringify({ token: 'test-token' }));

    const CodeSandboxProvider = require('../src/services/providers/codesandbox-provider');
    const provider = new CodeSandboxProvider();
    await provider.terminateSession({
      providerSessionId: 'sandbox-id',
      credentialRef: 'account.json',
      credentialFingerprint: 'sha256:test'
    });
  });
});
