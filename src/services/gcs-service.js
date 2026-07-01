const { google } = require('googleapis');
const cloudshell = google.cloudshell('v1');

async function getAuthClient(credentialsPath) {
  const authOptions = {
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  };

  if (credentialsPath) {
    authOptions.keyFile = credentialsPath;
  }

  const auth = new google.auth.GoogleAuth(authOptions);
  return await auth.getClient();
}

async function getEnvironmentName(auth, credentialsPath) {
  const authClient = auth || await getAuthClient(credentialsPath);
  let email = 'me';
  if (typeof authClient.getCredentials === 'function') {
    try {
      const creds = await authClient.getCredentials();
      email = creds.client_email || 'me';
    } catch {
      // fall through
    }
  }
  return `users/${email}/environments/default`;
}

async function startCloudShellSession(options = {}) {
  try {
    const auth = await getAuthClient(options.credentialsPath);
    const name = await getEnvironmentName(auth, options.credentialsPath);
    const res = await cloudshell.users.environments.start({
      name,
      auth: auth
    });
    
    return {
      operation: res.data.name,
      envName: name,
      status: 'STARTING'
    };
  } catch (error) {
    console.error('Error starting Cloud Shell:', error.response?.data || error.message);
    throw error;
  }
}

async function getCloudShellStatus(envName, options = {}) {
  try {
    const auth = await getAuthClient(options.credentialsPath);
    const name = envName || await getEnvironmentName(auth, options.credentialsPath);
    const res = await cloudshell.users.environments.get({
      name,
      auth: auth
    });

    const env = res.data;
    return {
      status: env.state,
      webHost: env.webHost,
      sshUsername: env.sshUsername,
      sshHost: env.sshHost,
      sshPort: env.sshPort,
      publicKeys: env.publicKeys
    };
  } catch (error) {
    console.error('Error getting Cloud Shell status:', error.response?.data || error.message);
    throw error;
  }
}

async function addPublicKey(key, envName, options = {}) {
    try {
        const auth = await getAuthClient(options.credentialsPath);
        const name = envName || await getEnvironmentName(auth, options.credentialsPath);
        const res = await cloudshell.users.environments.addPublicKey({
            environment: name,
            requestBody: {
                key: key
            },
            auth: auth
        });
        return res.data;
    } catch (error) {
        console.error('Error adding public key (detailed):', JSON.stringify(error.response?.data || error.message, null, 2));
        throw error;
    }
}

async function removePublicKey(keyName, envName, options = {}) {
    try {
        const auth = await getAuthClient(options.credentialsPath);
        const name = envName || await getEnvironmentName(auth, options.credentialsPath);
        const res = await cloudshell.users.environments.removePublicKey({
            environment: name,
            requestBody: {
                key: keyName
            },
            auth: auth
        });
        return res.data;
    } catch (error) {
        console.error('Error removing public key:', error.response?.data || error.message);
        throw error;
    }
}

module.exports = {
  startCloudShellSession,
  getCloudShellStatus,
  addPublicKey,
  removePublicKey
};
