const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.resolve(__dirname, '../../sessions.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Could not connect to database', err);
  } else {
    console.log('Connected to database');
  }
});

db.serialize(() => {
  // Ensure table exists
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    provider TEXT DEFAULT 'pwd',
    envName TEXT,
    sshCommand TEXT,
    webHost TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'PENDING'
  )`);

  // Add missing columns if they don't exist
  db.all("PRAGMA table_info(sessions)", (err, rows) => {
    if (err) return console.error(err);
    
    const columns = rows.map(r => r.name);
    
    if (!columns.includes('privateKey')) {
      db.run("ALTER TABLE sessions ADD COLUMN privateKey TEXT");
      console.log('Added privateKey column');
    }
    if (!columns.includes('publicKey')) {
      db.run("ALTER TABLE sessions ADD COLUMN publicKey TEXT");
      console.log('Added publicKey column');
    }
  });
});

module.exports = db;
