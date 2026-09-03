const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL_CONN || 'postgres://postgres:postgres@localhost:5432/play_with_docker';

// Parse connection string to extract host/port for diagnostics
const connectionUrl = new URL(connectionString);
const dbHost = connectionUrl.hostname;
const dbPort = connectionUrl.port || 5432;

console.log(`[DB] Configured to connect to: ${dbHost}:${dbPort}`);

const pool = new Pool({
  connectionString,
  // Increase timeouts for remote connections
  connectionTimeoutMillis: 60000,  // 60 seconds for remote DB
  idleTimeoutMillis: 30000,
  statement_timeout: 60000,         // 60 second query timeout
  // Uncomment SSL config if your provider requires it
  // ssl: {
  //   rejectUnauthorized: false
  // }
});

// Handle connection errors
pool.on('error', (err) => {
  console.error('[DB] Pool error:', {
    code: err.code,
    message: err.message,
    address: err.address,
    port: err.port
  });
});

function convertSql(sql, params = []) {
  let index = 0;
  const text = sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
  return { text, values: params };
}

async function run(sql, params = []) {
  const { text, values } = convertSql(sql, params);
  return pool.query(text, values);
}

async function all(sql, params = []) {
  const { text, values } = convertSql(sql, params);
  const result = await pool.query(text, values);
  return result.rows;
}

async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows.length ? rows[0] : null;
}

async function ensureColumn(tableName, columnName, ddl) {
  const checkResult = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE lower(table_name) = lower($1) AND lower(column_name) = lower($2)`,
    [tableName, columnName]
  );

  if (checkResult.rowCount === 0) {
    await run(ddl);
    console.log(`Added ${columnName} column`);
  }
}

const db = {
  run,
  all,
  get,
  pool,
  ready: null
};

db.ready = (async () => {
  try {
    console.log('[DB] Attempting to connect...');
    const client = await pool.connect();
    console.log('[DB] ✓ Connection successful to', dbHost + ':' + dbPort);
    client.release();
  } catch (err) {
    console.error('[DB] ✗ Connection FAILED:', {
      error: err.message,
      code: err.code,
      host: dbHost,
      port: dbPort,
      timeout: err.code === 'ETIMEDOUT' ? 'Connection timeout - check firewall on server' : 'See code above'
    });
    throw err;
  }

  try {
    await run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    provider TEXT DEFAULT 'gcs',
    providerSessionId TEXT,
    envName TEXT,
    sshCommand TEXT,
    webHost TEXT,
    privateKey TEXT,
    publicKey TEXT,
    status TEXT DEFAULT 'PENDING',
    metadata TEXT,
    createdAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`);

  await ensureColumn('sessions', 'provider', "ALTER TABLE sessions ADD COLUMN provider TEXT DEFAULT 'gcs'");
  await ensureColumn('sessions', 'providerSessionId', 'ALTER TABLE sessions ADD COLUMN providerSessionId TEXT');
  await ensureColumn('sessions', 'envName', 'ALTER TABLE sessions ADD COLUMN envName TEXT');
  await ensureColumn('sessions', 'sshCommand', 'ALTER TABLE sessions ADD COLUMN sshCommand TEXT');
  await ensureColumn('sessions', 'webHost', 'ALTER TABLE sessions ADD COLUMN webHost TEXT');
  await ensureColumn('sessions', 'privateKey', 'ALTER TABLE sessions ADD COLUMN privateKey TEXT');
  await ensureColumn('sessions', 'publicKey', 'ALTER TABLE sessions ADD COLUMN publicKey TEXT');
  await ensureColumn('sessions', 'status', "ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'PENDING'");
  await ensureColumn('sessions', 'metadata', 'ALTER TABLE sessions ADD COLUMN metadata TEXT');
  await ensureColumn('sessions', 'credentialRef', 'ALTER TABLE sessions ADD COLUMN credentialRef TEXT');
  await ensureColumn('sessions', 'credentialFingerprint', 'ALTER TABLE sessions ADD COLUMN credentialFingerprint TEXT');

  await run("UPDATE sessions SET provider = 'gcs' WHERE provider IS NULL OR provider = ''");
  await run('UPDATE sessions SET providerSessionId = envName WHERE providerSessionId IS NULL AND envName IS NOT NULL');

  const duplicateCodeSandboxSessions = await all(`
    SELECT
      credentialFingerprint,
      COUNT(*) AS activeCount,
      ARRAY_AGG(id ORDER BY createdAt DESC, id DESC) AS sessionIds
    FROM sessions
    WHERE provider = 'codesandbox'
      AND credentialFingerprint IS NOT NULL
      AND COALESCE(status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED')
    GROUP BY credentialFingerprint
    HAVING COUNT(*) > 1
  `);

  if (duplicateCodeSandboxSessions.length > 0) {
    const duplicateSummary = duplicateCodeSandboxSessions
      .map((row) => `${row.credentialfingerprint || row.credentialFingerprint}: ${(row.sessionids || row.sessionIds || []).join(', ')}`)
      .join('; ');

    throw new Error(
      `Cannot create CodeSandbox token uniqueness index while duplicate non-terminal sessions exist. ` +
      `Terminate or mark older duplicate sessions as TERMINATED, DELETED, or FAILED first. Duplicates: ${duplicateSummary}`
    );
  }

  // Add unique index for active CodeSandbox sessions (one sandbox/session per token)
  await run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_codesandbox_active_token
    ON sessions (credentialFingerprint)
    WHERE provider = 'codesandbox'
      AND credentialFingerprint IS NOT NULL
      AND COALESCE(status, '') NOT IN ('TERMINATED', 'DELETED', 'FAILED')
  `);

  const duplicateCodespacesSessions = await all(`
    SELECT
      credentialFingerprint,
      COUNT(*) AS activeCount,
      ARRAY_AGG(id ORDER BY createdAt DESC, id DESC) AS sessionIds
    FROM sessions
    WHERE provider = 'codespaces'
      AND credentialFingerprint IS NOT NULL
      AND COALESCE(status, '') NOT IN ('TERMINATED', 'FAILED')
    GROUP BY credentialFingerprint
    HAVING COUNT(*) > 1
  `);

  if (duplicateCodespacesSessions.length > 0) {
    const duplicateSummary = duplicateCodespacesSessions
      .map((row) => `${row.credentialfingerprint || row.credentialFingerprint}: ${(row.sessionids || row.sessionIds || []).join(', ')}`)
      .join('; ');

    throw new Error(
      `Cannot create Codespaces token uniqueness index while duplicate non-terminal sessions exist. ` +
      `Terminate or mark older duplicate sessions as TERMINATED or FAILED first. Duplicates: ${duplicateSummary}`
    );
  }

  // Add unique index for active Codespaces sessions (one codespace per token)
  await run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_codespaces_active_token
    ON sessions (credentialFingerprint)
    WHERE provider = 'codespaces'
      AND credentialFingerprint IS NOT NULL
      AND COALESCE(status, '') NOT IN ('TERMINATED', 'FAILED')
  `);

    // vps table — stores provider credentials for DB-first resolution
    await run(`CREATE TABLE IF NOT EXISTS vps (
      id                    TEXT PRIMARY KEY,
      provider              TEXT NOT NULL,
      name                  TEXT NOT NULL,
      credentialfilename    TEXT NOT NULL,
      credentialcontent     TEXT NOT NULL,
      credentialfingerprint TEXT NOT NULL,
      createdat             TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updatedat             TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )`);

    await run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vps_provider_name
      ON vps (provider, name)
    `);

    await run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vps_provider_fingerprint
      ON vps (provider, credentialfingerprint)
    `);

    await ensureColumn('vps', 'status', 'ALTER TABLE vps ADD COLUMN status JSONB DEFAULT NULL');
    await ensureColumn('vps', 'statusCheckedAt', 'ALTER TABLE vps ADD COLUMN statusCheckedAt TIMESTAMP WITH TIME ZONE DEFAULT NULL');

    console.log('[DB] ✓ vps table ready');

    console.log('[DB] ✓ Schema initialized successfully');
  } catch (err) {
    console.error('[DB] ✗ Schema initialization failed:', err.message);
    throw err;
  }
})();

module.exports = db;
