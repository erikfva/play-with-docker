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

const sshService = require('../services/ssh-service');

// Execute command (Now implemented for MVP)
router.post('/:id/command', (req, res) => {
    const { id } = req.params;
    const { command } = req.body;

    if (!command) {
        return res.status(400).json({ error: 'Command is required' });
    }

    db.get('SELECT * FROM sessions WHERE id = ?', [id], async (err, row) => {
        if (err || !row) {
            return res.status(err ? 500 : 404).json({ error: err ? 'Database error' : 'Session not found' });
        }

        try {
            // Get latest status and SSH info from GCS API
            const status = await gcsService.getCloudShellStatus(row.envName);
            if (status.status !== 'RUNNING') {
                return res.status(400).json({ error: `Session is not ready. Current status: ${status.status}` });
            }

            let privateKey = row.privateKey;
            
            // If no key pair exists for this session, generate and register one
            if (!privateKey) {
                console.log('Generating new SSH key pair for session:', id);
                const keys = await sshService.generateKeyPair();
                
                // Add public key to GCS
                await gcsService.addPublicKey(keys.publicKey, row.envName);
                
                // Save keys to DB
                await new Promise((resolve, reject) => {
                    db.run('UPDATE sessions SET privateKey = ?, publicKey = ? WHERE id = ?', 
                        [keys.privateKey, keys.publicKey, id], (err) => err ? reject(err) : resolve());
                });
                
                privateKey = keys.privateKey;
            }

            // Execute command
            const output = await sshService.executeCommand({
                host: status.sshHost,
                port: status.sshPort,
                username: status.sshUsername
            }, command, privateKey);

            res.json({ output });
        } catch (error) {
            console.error('Command execution error:', error);
            res.status(500).json({ 
                error: 'Failed to execute command', 
                details: error.message 
            });
        }
    });
});

module.exports = router;
