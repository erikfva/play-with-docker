const express = require('express');
const router = express.Router();
const db = require('../db/db');
const gcsService = require('../services/gcs-service');
const { v4: uuidv4 } = require('uuid');

// Create a new session
router.post('/', async (req, res) => {
  try {
    // Start Cloud Shell
    const sessionData = await gcsService.startCloudShellSession();
    const id = uuidv4();
    const envName = sessionData.envName;
    const provider = 'gcs';

    // Store in DB
    db.run(
      `INSERT INTO sessions (id, provider, envName, status) VALUES (?, ?, ?, ?)`,
      [id, provider, envName, 'STARTING'],
      function(err) {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Database error' });
        }
        res.status(201).json({ 
          id, 
          status: 'STARTING',
          message: 'Cloud Shell session initialization started.' 
        });
      }
    );
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to start Cloud Shell session' });
  }
});

// Get session details
router.get('/:id', (req, res) => {
  const { id } = req.params;
  db.get('SELECT * FROM sessions WHERE id = ?', [id], async (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    if (!row) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Refresh status from GCS
    try {
        const gcsStatus = await gcsService.getCloudShellStatus(row.envName);
        
        // Update DB with latest info
        // We might want to persist webHost, ssh info if available
        const updates = [];
        const params = [];

        if (gcsStatus.webHost) {
            updates.push('webHost = ?');
            params.push(gcsStatus.webHost);
        }
        if (gcsStatus.status) {
            updates.push('status = ?');
            params.push(gcsStatus.status);
        }
        
        // Construct SSH command string for frontend use if we have enough info
        if (gcsStatus.sshUsername && gcsStatus.sshHost) {
             const sshCmd = `ssh ${gcsStatus.sshUsername}@${gcsStatus.sshHost} -p ${gcsStatus.sshPort || 22}`;
             updates.push('sshCommand = ?');
             params.push(sshCmd);
             row.sshCommand = sshCmd; // Update local obj for response
        }

        if (updates.length > 0) {
            params.push(id);
            db.run(`UPDATE sessions SET ${updates.join(', ')} WHERE id = ?`, params);
        }

        // Merge latest status
        row.status = gcsStatus.status || row.status;
        row.webHost = gcsStatus.webHost || row.webHost;
        
        res.json(row);
    } catch (apiError) {
        console.warn('Could not refresh status from GCS API', apiError.message);
        // Return DB version if API fails
        res.json(row);
    }
  });
});

// Execute command (Placeholder for now, implementation depends on SSH setup)
router.post('/:id/command', (req, res) => {
    // This would use ssh2 to connect to the shell
    // However, GCS SSH access usually requires key management.
    // For MVP, we might skip direct command execution or require setting up keys first.
    res.status(501).json({ error: 'Command execution not fully implemented in MVP without SSH key setup' });
});

module.exports = router;
