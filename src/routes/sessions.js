const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { getProvider, listProviders, normalizeProviderName } = require('../services/provider-factory');
const { ProviderError } = require('../services/errors/provider-errors');
const keepAliveService = require('../services/keep-alive-service');
const { listAvailableCredentials } = require('../services/credentials-lister');
const { getRowValue } = require('../utils/helpers');

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
  const statusCode = Number.isInteger(error.statusCode)
    ? error.statusCode
    : Number.isInteger(error.status)
      ? error.status
      : Number.isInteger(error.code)
        ? error.code
        : 500;

  return res.status(statusCode).json({
    error: error.message || fallbackMessage,
    code: error.code
  });
}

function parseMetadata(rawMetadata) {
  if (!rawMetadata) {
    return null;
  }

  if (typeof rawMetadata === 'object') {
    return rawMetadata;
  }

  try {
    return JSON.parse(rawMetadata);
  } catch (_) {
    return { raw: rawMetadata };
  }
}

function buildCreateResponseFromSession(row, reusedExisting = false) {
  const metadata = parseMetadata(row.metadata) || {};

  return {
    id: row.id,
    provider: row.provider,
    providerSessionId: getRowValue(row, 'providerSessionId', 'providersessionid'),
    status: row.status,
    dockerHost: metadata.dockerHost || null,
    reusedExisting
  };
}

function requireGoogleCredentialRefForRequest(req, sessionRow) {
  const credentialRef = getGoogleCredentialRef(req, sessionRow);
  if (!credentialRef) {
    const error = new Error('Google credential reference is required in x-google-credentials or request body credentialRef/googleCredentialRef');
    error.statusCode = 400;
    error.code = 'GOOGLE_CREDENTIALS_MISSING';
    throw error;
  }

  if (sessionRow) {
    sessionRow.credentialRef = credentialRef;
    sessionRow.credentialref = credentialRef;
  }
  return credentialRef;
}

function getGoogleCredentialRef(req, sessionRow) {
  const metadata = parseMetadata(sessionRow?.metadata) || {};
  const storedCredentialRef = getRowValue(sessionRow, 'credentialRef', 'credentialref') || metadata.credentialRef;
  if (storedCredentialRef) {
    return storedCredentialRef;
  }

  return req.headers['x-google-credentials']
    || req.body?.googleCredentialRef
    || req.body?.credentialRef
    || null;
}

function getCodeSandboxCredentialRef(req) {
  return req.headers['x-codesandbox-credentials'] || req.body?.credentialRef || null;
}

function requireCodeSandboxCredentialRef(req) {
  const credentialRef = getCodeSandboxCredentialRef(req);
  if (!credentialRef) {
    throw new ProviderError(
      'CodeSandbox credential reference is required in x-codesandbox-credentials or request body credentialRef',
      { code: 'CODESANDBOX_CREDENTIALS_MISSING', statusCode: 400 }
    );
  }

  return credentialRef;
}

async function cleanupCreatedCodeSandboxSession(created) {
  if (!created?.providerSessionId) {
    return;
  }

  try {
    const cleanupProvider = getProvider('codesandbox');
    await cleanupProvider.terminateSession({
      providerSessionId: created.providerSessionId,
      credentialRef: created.credentialRef,
      credentialFingerprint: created.credentialFingerprint
    });
  } catch (cleanupError) {
    console.warn(`[Session Create] Failed to cleanup orphaned CodeSandbox sandbox/session ${created.providerSessionId}: ${cleanupError.message}`);
  }
}

async function refreshExistingSessionForCreate(row, provider, requireRefreshSuccess = false) {
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

    return {
      ...row,
      status: refreshed.status || row.status,
      webHost: refreshed.webHost || getRowValue(row, 'webHost', 'webhost'),
      sshCommand: refreshed.sshCommand || getRowValue(row, 'sshCommand', 'sshcommand'),
      metadata: refreshed.metadata || parseMetadata(row.metadata)
    };
  } catch (error) {
    if (requireRefreshSuccess) {
      throw error;
    }

    console.warn(`[Session Create] Failed to refresh existing session ${row.id}: ${error.message}`);
    return row;
  }
}

router.post('/', async (req, res) => {
  const providerName = normalizeProviderName(req.body?.provider || 'gcs');

  try {
    // Initialize provider-aware credentials for GCS
    let credentialRef = null;
    if (providerName === 'gcs') {
      credentialRef = requireGoogleCredentialRefForRequest(req);
    } else if (providerName === 'codesandbox') {
      credentialRef = requireCodeSandboxCredentialRef(req);
    }

    const provider = getProvider(providerName);
    const created = await provider.createSession({
      ...(req.body || {}),
      credentialRef
    });
    if (providerName === 'gcs' && credentialRef) {
      created.metadata = {
        ...(created.metadata || {}),
        credentialRef
      };
    }

    if (created.existing && created.session) {
      const refreshedExisting = await refreshExistingSessionForCreate(created.session, provider);
      return res.status(200).json(buildCreateResponseFromSession(refreshedExisting, true));
    }

    const id = uuidv4();

    try {
      await db.run(
        `INSERT INTO sessions (id, provider, providerSessionId, envName, status, webHost, sshCommand, credentialRef, credentialFingerprint, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          provider.name,
          created.providerSessionId,
          created.envName || created.providerSessionId,
          created.status || 'STARTING',
          created.webHost || null,
          created.sshCommand || null,
          created.credentialRef || credentialRef || null,
          created.credentialFingerprint || null,
          created.metadata ? JSON.stringify(created.metadata) : null
        ]
      );
    } catch (dbError) {
      if (providerName === 'codesandbox') {
        await cleanupCreatedCodeSandboxSession(created);
      }

      // Handle unique constraint violation for CodeSandbox one sandbox/session per token
      if (dbError.code === '23505' && providerName === 'codesandbox') {
        // Unique index violation on credentialFingerprint
        // Return the existing session
        const existingSession = await db.get(
          'SELECT * FROM sessions WHERE credentialFingerprint = ? AND provider = ? AND (status IS NULL OR status NOT IN (?, ?, ?))',
          [created.credentialFingerprint, 'codesandbox', 'TERMINATED', 'DELETED', 'FAILED']
        );

        if (existingSession) {
          const refreshedExisting = await refreshExistingSessionForCreate(existingSession, provider, true);
          return res.status(200).json(buildCreateResponseFromSession(refreshedExisting, true));
        }

        // If we can't find the session but got a unique violation, something is wrong
        return res.status(500).json({
          error: 'Failed to create session due to credential conflict',
          code: 'INTERNAL_ERROR'
        });
      }

      // For any other error, throw it
      throw dbError;
    }

    const sessionRow = await db.get('SELECT * FROM sessions WHERE id = ?', [id]);

    // START KEEP-ALIVE (provider-aware)
    // Will only start if the provider has it enabled
    keepAliveService.startKeepAlive(sessionRow, provider);

    return res.status(201).json({
      id,
      provider: provider.name,
      providerSessionId: created.providerSessionId,
      status: created.status || 'STARTING',
      dockerHost: created.metadata?.dockerHost || null
    });
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to create session');
  }
});

router.get('/providers/supported', (req, res) => {
  const providers = listProviders().filter(name => name !== 'pwd');
  res.json({ providers });
});

router.get('/google-credentials', async (req, res) => {
  try {
    const prefix = 'gcloud';
    const result = await listAvailableCredentials(prefix);
    return res.json(result);
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to list credentials');
  }
});

router.get('/codesandbox-credentials', async (req, res) => {
  try {
    const prefix = 'codesandbox';
    const result = await listAvailableCredentials(prefix);
    return res.json(result);
  } catch (error) {
    return mapErrorToHttp(res, error, 'Failed to list credentials');
  }
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

    // Initialize provider-aware credentials for GCS refresh
    if (row.provider === 'gcs') {
      requireGoogleCredentialRefForRequest(req, row);
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

    // Initialize provider-aware credentials for GCS command execution
    if (row.provider === 'gcs') {
      requireGoogleCredentialRefForRequest(req, row);
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

    // Initialize provider-aware credentials for GCS termination
    if (row.provider === 'gcs') {
      requireGoogleCredentialRefForRequest(req, row);
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
      if (row.provider === 'codesandbox') {
        throw providerError;
      }
    }

    await db.run('DELETE FROM sessions WHERE id = ?', [row.id]);

    const response = {
      message: `Session ${row.id} (${row.provider}) terminated and removed from orchestrator.`,
      providerCleanup: row.provider === 'codesandbox' ? 'deleted' : 'attempted'
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
        if (row.provider === 'gcs') {
          requireGoogleCredentialRefForRequest(req, row);
        }

        await provider.terminateSession(row);
        result.terminated = true;
      } catch (providerError) {
        result.errors.push(`terminateSession: ${providerError.message}`);
        if (row.provider === 'codesandbox') {
          results.push(result);
          continue;
        }
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
