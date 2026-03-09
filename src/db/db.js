const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '../../sessions.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Could not connect to database', err);
  } else {
    console.log('Connected to database');
  }
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function runCallback(err) {
      if (err) {
        reject(err);
      } else {
        resolve(this);
      }
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

async function ensureColumn(columns, name, sql) {
  if (!columns.includes(name)) {
    await run(sql);
    console.log(`Added ${name} column`);
  }
}

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
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  const rows = await all('PRAGMA table_info(sessions)');
  const columns = rows.map((r) => r.name);

  await ensureColumn(columns, 'provider', "ALTER TABLE sessions ADD COLUMN provider TEXT DEFAULT 'gcs'");
  await ensureColumn(columns, 'providerSessionId', 'ALTER TABLE sessions ADD COLUMN providerSessionId TEXT');
  await ensureColumn(columns, 'envName', 'ALTER TABLE sessions ADD COLUMN envName TEXT');
  await ensureColumn(columns, 'sshCommand', 'ALTER TABLE sessions ADD COLUMN sshCommand TEXT');
  await ensureColumn(columns, 'webHost', 'ALTER TABLE sessions ADD COLUMN webHost TEXT');
  await ensureColumn(columns, 'privateKey', 'ALTER TABLE sessions ADD COLUMN privateKey TEXT');
  await ensureColumn(columns, 'publicKey', 'ALTER TABLE sessions ADD COLUMN publicKey TEXT');
  await ensureColumn(columns, 'status', "ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'PENDING'");
  await ensureColumn(columns, 'metadata', 'ALTER TABLE sessions ADD COLUMN metadata TEXT');

  await run("UPDATE sessions SET provider = 'gcs' WHERE provider IS NULL OR provider = ''");
  await run('UPDATE sessions SET providerSessionId = envName WHERE providerSessionId IS NULL AND envName IS NOT NULL');
})().catch((err) => {
  console.error('Database initialization failed:', err);
  throw err;
});

module.exports = db;
