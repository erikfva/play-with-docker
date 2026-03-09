const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { getProvider, listProviders, normalizeProviderName } = require('../services/provider-factory');
const { ProviderError } = require('../services/errors/provider-errors');

const router = express.Router();

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbRun(sql, params = []) {
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

function mapErrorToHttp(res, error, fallbackMessage) {
  if (error instanceof ProviderError) {
    return res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
      details: error.details
    });
  }

  console.error(error);
  return res.status(500).json({ error: fallbackMessage });
}

function parseMetadata(rawMetadata) {
  if (!rawMetadata) {
    return null;
  }

  try {
    return JSON.parse(rawMetadata);
  } catch (_) {
    return { raw: rawMetadata };
  }
}

router.post('/', async (req, res) => {
  const providerName = normalizeProviderName(req.body?.provider || 'gcs');

  try {
    const provider = getProvider(providerName);
    const created = await provider.createSession(req.body || {});
    const id = uuidv4();

    await dbRun(
      `INSERT INTO sessions (id, provider, providerSessionId, envName, status, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        provider.name,
        created.providerSessionId,
        created.providerSessionId,
        created.status || 'STARTING',
        created.metadata ? JSON.stringify(created.metadata) : null
      ]
    );

    return res.status(201).json({
      id,
      provider: provider.name,
      providerSessionId: created.providerSessionId,
      status: created.status || 'STARTING'
    });
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to create session');
  }
});

router.get('/providers/supported', (req, res) => {
  res.json({ providers: listProviders() });
});

router.get('/:id', async (req, res) => {
  try {
    const row = await dbGet('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    if (!row) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const provider = getProvider(row.provider);

    try {
      const refreshed = await provider.refreshSession(row);
      await dbRun(
        `UPDATE sessions
         SET status = COALESCE(?, status),
             webHost = COALESCE(?, webHost),
             sshCommand = COALESCE(?, sshCommand),
             metadata = COALESCE(?, metadata)
         WHERE id = ?`,
        [
          refreshed.status || null,
          refreshed.webHost || null,
          refreshed.sshCommand || null,
          refreshed.metadata ? JSON.stringify(refreshed.metadata) : null,
          row.id
        ]
      );

      row.status = refreshed.status || row.status;
      row.webHost = refreshed.webHost || row.webHost;
      row.sshCommand = refreshed.sshCommand || row.sshCommand;
      row.metadata = refreshed.metadata || parseMetadata(row.metadata);
    } catch (providerError) {
      console.warn(`Provider refresh failed for session ${row.id}:`, providerError.message);
      row.metadata = parseMetadata(row.metadata);
    }

    return res.json(row);
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to retrieve session');
  }
});

router.post('/:id/command', async (req, res) => {
  const { command } = req.body || {};
  if (!command) {
    return res.status(400).json({ error: 'Command is required' });
  }

  try {
    const row = await dbGet('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    if (!row) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const provider = getProvider(row.provider);
    const result = await provider.executeCommand(row, command);
    const updates = result.updates || {};

    await dbRun(
      `UPDATE sessions
       SET privateKey = COALESCE(?, privateKey),
           publicKey = COALESCE(?, publicKey),
           sshCommand = COALESCE(?, sshCommand),
           status = COALESCE(?, status)
       WHERE id = ?`,
      [
        updates.privateKey || null,
        updates.publicKey || null,
        updates.sshCommand || null,
        updates.status || null,
        row.id
      ]
    );

    return res.json({ output: result.output });
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to execute command');
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const row = await dbGet('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    if (!row) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const provider = getProvider(row.provider);
    try {
      await provider.terminateSession(row);
    } catch (providerError) {
      console.warn(`Provider termination failed for session ${row.id}:`, providerError.message);
    }

    await dbRun('DELETE FROM sessions WHERE id = ?', [row.id]);

    return res.json({ message: `Session ${row.id} terminated and removed from orchestrator.` });
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to terminate session');
  }
});

module.exports = router;
