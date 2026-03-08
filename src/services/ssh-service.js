const { Client } = require('ssh2');
const crypto = require('crypto');

/**
 * Generates an RSA key pair for SSH authentication.
 * @returns {Promise<{publicKey: string, privateKey: string}>}
 */
async function generateKeyPair() {
  return new Promise((resolve, reject) => {
    crypto.generateKeyPair('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: 'pkcs1',
        format: 'pem'
      },
      privateKeyEncoding: {
        type: 'pkcs1',
        format: 'pem'
      }
    }, (err, publicKey, privateKey) => {
      if (err) return reject(err);
      
      // Convert to OpenSSH format (simplified for MVP, usually needs a bit more work)
      // For real MVP, we might use a library or formatting logic.
      // But gcs-service.js expects the key to be added.
      resolve({ publicKey, privateKey });
    });
  });
}

/**
 * Executes a command on a remote host via SSH.
 * @param {Object} connectionInfo 
 * @param {string} command 
 * @param {string} privateKey 
 * @returns {Promise<string>}
 */
async function executeCommand(connectionInfo, command, privateKey) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = '';
    let errorOutput = '';

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }
        stream.on('close', (code, signal) => {
          conn.end();
          if (code !== 0) {
            reject(new Error(`Command failed with code ${code}. Error: ${errorOutput}`));
          } else {
            resolve(output);
          }
        }).on('data', (data) => {
          output += data.toString();
        }).stderr.on('data', (data) => {
          errorOutput += data.toString();
        });
      });
    }).on('error', (err) => {
      reject(err);
    }).connect({
      host: connectionInfo.host,
      port: connectionInfo.port || 22,
      username: connectionInfo.username,
      privateKey: privateKey
    });
  });
}

module.exports = {
  generateKeyPair,
  executeCommand
};
