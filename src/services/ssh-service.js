const { Client } = require('ssh2');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

/**
 * Generates an RSA key pair for SSH authentication using system ssh-keygen.
 * @returns {Promise<{publicKey: string, privateKey: string}>}
 */
async function generateKeyPair() {
  return new Promise((resolve, reject) => {
    const keyPath = path.join(os.tmpdir(), `id_rsa_${uuidv4()}`);
    
    // -t rsa: RSA key
    // -b 2048: 2048 bits
    // -f keyPath: output file
    // -N "": no passphrase
    // -C "": empty comment
    // -q: quiet
    exec(`ssh-keygen -t rsa -b 2048 -f ${keyPath} -N "" -C "" -q`, (err) => {
      if (err) return reject(err);

      try {
        const privateKey = fs.readFileSync(keyPath, 'utf8');
        const publicKey = fs.readFileSync(`${keyPath}.pub`, 'utf8');

        // Cleanup temporary files
        fs.unlinkSync(keyPath);
        fs.unlinkSync(`${keyPath}.pub`);

        resolve({ 
            publicKey: publicKey.trim(), 
            privateKey: privateKey 
        });
      } catch (readErr) {
        reject(readErr);
      }
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
