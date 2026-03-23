const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL_CONN || 'postgres://postgres:postgres@localhost:5432/play_with_docker';

const pool = new Pool({
  connectionString,
  // Uncomment SSL config if your provider requires it
  // ssl: {
  //   rejectUnauthorized: false
  // }
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

  await run("UPDATE sessions SET provider = 'gcs' WHERE provider IS NULL OR provider = ''");
  await run('UPDATE sessions SET providerSessionId = envName WHERE providerSessionId IS NULL AND envName IS NOT NULL');

  console.log('Connected to PostgreSQL database');
})();

module.exports = db;
