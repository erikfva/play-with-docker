const { google } = require('googleapis');
const cloudshell = google.cloudshell('v1');

async function getAuthClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });
  return await auth.getClient();
}

async function getEnvironmentName() {
  const auth = await getAuthClient();
  // If it's a service account, using 'me' should work,
  // but let's try to get the actual email if possible just in case.
  const email = (await auth.getCredentials()).client_email;
  return `users/${email || 'me'}/environments/default`;
}

async function startCloudShellSession() {
  try {
    const auth = await getAuthClient();
    const name = await getEnvironmentName();
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

async function getCloudShellStatus(envName) {
  try {
    const auth = await getAuthClient();
    const name = envName || await getEnvironmentName();
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

async function addPublicKey(key, envName) {
    try {
        const auth = await getAuthClient();
        const name = envName || await getEnvironmentName();
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

async function removePublicKey(keyName, envName) {
    try {
        const auth = await getAuthClient();
        const name = envName || await getEnvironmentName();
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
