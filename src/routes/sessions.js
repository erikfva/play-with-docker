const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { getProvider, listProviders, normalizeProviderName } = require('../services/provider-factory');
const { ProviderError } = require('../services/errors/provider-errors');
const keepAliveService = require('../services/keep-alive-service');

const router = express.Router();

function mapErrorToHttp(res, error, fallbackMessage) {
  if (error instanceof ProviderError) {
    return res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
      details: error.details
    });
  }

  console.error(error);
  return res.status(error.code || 500).json({ error: error.message || fallbackMessage });
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

    await db.run(
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

    const sessionRow = await db.get('SELECT * FROM sessions WHERE id = ?', [id]);

    // START KEEP-ALIVE (provider-aware)
    // Will only start if the provider has it enabled
    keepAliveService.startKeepAlive(sessionRow, provider);

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

router.get('/', async (req, res) => {
  const { status } = req.query;
  const sql = status ? 'SELECT * FROM sessions WHERE status = ?' : 'SELECT * FROM sessions';
  const params = status ? [status] : [];

  try {
    const rows = await db.all(sql, params);
    const sessions = rows.map((row) => ({
      ...row,
      metadata: parseMetadata(row.metadata)
    }));

    return res.json({ sessions });
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to list sessions');
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await db.get('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    if (!row) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const provider = getProvider(row.provider);

    try {
      const refreshed = await provider.refreshSession(row);
      await db.run(
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
    const row = await db.get('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    if (!row) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const provider = getProvider(row.provider);
    const result = await provider.executeCommand(row, command);
    const updates = result.updates || {};

    await db.run(
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
    const row = await db.get('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    if (!row) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const provider = getProvider(row.provider);

    // STOP KEEP-ALIVE BEFORE TERMINATING
    keepAliveService.stopKeepAlive(row.id);

    // Display keep-alive stats if available
    const stats = keepAliveService.getKeepAliveStats(row.id);

    try {
      await provider.terminateSession(row);
    } catch (providerError) {
      console.warn(`Provider termination failed for session ${row.id}:`, providerError.message);
    }

    await db.run('DELETE FROM sessions WHERE id = ?', [row.id]);

    const response = {
      message: `Session ${row.id} (${row.provider}) terminated and removed from orchestrator.`
    };

    if (stats) {
      response.keepAliveStats = stats;
    }

    return res.json(response);
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to terminate session');
  }
});

router.post('/terminate-all', async (req, res) => {
  try {
    // STOP ALL KEEP-ALIVES FIRST
    keepAliveService.stopAllKeepAlives();

    const rows = await db.all('SELECT * FROM sessions');
    const results = [];

    for (const row of rows) {
      const provider = getProvider(row.provider);
      const result = {
        id: row.id,
        provider: row.provider,
        terminated: false,
        deleted: false,
        errors: []
      };

      try {
        await provider.terminateSession(row);
        result.terminated = true;
      } catch (providerError) {
        result.errors.push(`terminateSession: ${providerError.message}`);
      }

      try {
        await db.run('DELETE FROM sessions WHERE id = ?', [row.id]);
        result.deleted = true;
      } catch (dbError) {
        result.errors.push(`dbDelete: ${dbError.message}`);
      }

      results.push(result);
    }

    const summary = results.reduce(
      (acc, item) => {
        if (item.terminated) acc.terminated += 1;
        if (item.deleted) acc.deleted += 1;
        if (item.errors.length) acc.errors += 1;
        return acc;
      },
      { total: results.length, terminated: 0, deleted: 0, errors: 0 }
    );

    return res.json({ summary, results });
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to terminate all sessions');
  }
});

module.exports = router;
