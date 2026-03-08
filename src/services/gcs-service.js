const { google } = require('googleapis');
const cloudshell = google.cloudshell('v1');
const { v4: uuidv4 } = require('uuid');

// Ensure authentication is handled via ADC or key file
async function getAuthClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });
  return await auth.getClient();
}

/**
 * Starts a Google Cloud Shell session for the authenticated user.
 * Note: In a real scenario, this would likely need to impersonate the user or use
 * a service account that can manage environments for specific users if supported.
 * For MVP, we assume the backend acts on behalf of a single service account/user
 * or the user provides their own access token (which is complex).
 * 
 * Given MVP constraints, we'll assume a single shared environment for the service account
 * or use the 'users/me/environments/default' resource.
 */
async function startCloudShellSession() {
  try {
    const auth = await getAuthClient();
    const res = await cloudshell.users.environments.start({
      name: 'users/me/environments/default',
      auth: auth
    });
    
    // The operation might be long-running.
    // In a real app, we'd poll the operation. 
    // For MVP, we'll return the operation name or the environment details if available.
    return {
      operation: res.data.name,
      envName: 'users/me/environments/default',
      status: 'STARTING'
    };
  } catch (error) {
    console.error('Error starting Cloud Shell:', error);
    throw error;
  }
}

async function getCloudShellStatus(envName = 'users/me/environments/default') {
  try {
    const auth = await getAuthClient();
    const res = await cloudshell.users.environments.get({
      name: envName,
      auth: auth
    });

    const env = res.data;
    
    // Construct SSH command (simplified)
    // The actual API might return public keys or connection info.
    // `gcloud cloud-shell ssh` handles the keys automatically.
    // We can extract the `webHost` if available.
    
    return {
      status: env.state, // e.g., RUNNING, STARTING
      webHost: env.webHost,
      sshUsername: env.sshUsername,
      sshHost: env.sshHost,
      sshPort: env.sshPort,
      publicKeys: env.publicKeys
    };
  } catch (error) {
    console.error('Error getting Cloud Shell status:', error);
    throw error;
  }
}

async function addPublicKey(key, envName = 'users/me/environments/default') {
    try {
        const auth = await getAuthClient();
        const res = await cloudshell.users.environments.addPublicKey({
            environment: envName,
            requestBody: {
                key: key
            },
            auth: auth
        });
        return res.data;
    } catch (error) {
        console.error('Error adding public key:', error);
        throw error;
    }
}

async function removePublicKey(keyName, envName = 'users/me/environments/default') {
    try {
        const auth = await getAuthClient();
        const res = await cloudshell.users.environments.removePublicKey({
            environment: envName,
            requestBody: {
                key: keyName
            },
            auth: auth
        });
        return res.data;
    } catch (error) {
        console.error('Error removing public key:', error);
        throw error;
    }
}

module.exports = {
  startCloudShellSession,
  getCloudShellStatus,
  addPublicKey,
  removePublicKey
};
