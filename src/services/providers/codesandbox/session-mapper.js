/**
 * CodeSandbox Session Mapper
 *
 * Maps CodeSandbox SDK sandbox objects to the application's normalized session model.
 * Handles partial data and maintains backward compatibility.
 */

function mapToSession(sandbox, credentialRef, credentialFingerprint) {
  if (!sandbox || !sandbox.id) {
    throw new Error('CodeSandbox session mapper requires a sandbox with an id');
  }

  // Build metadata object with provider-specific fields
  const metadata = {
    sandboxId: sandbox.id,
    title: sandbox.title || sandbox.id,
    credentialRef: credentialRef || null,
    credentialFingerprint: credentialFingerprint || null,
    cluster: sandbox.cluster || null,
    bootupType: sandbox.bootupType || null,
    isUpToDate: sandbox.isUpToDate || false,
    privacy: sandbox.privacy || null,
    vmTier: sandbox.vmTier || null
  };

  // Remove null/undefined values to keep metadata clean
  Object.keys(metadata).forEach(key => {
    if (metadata[key] === null || metadata[key] === undefined) {
      delete metadata[key];
    }
  });

  // Build normalized session object
  const session = {
    provider: 'codesandbox',
    providerSessionId: sandbox.id,
    envName: sandbox.title || sandbox.id,
    sshCommand: null,  // CodeSandbox doesn't expose SSH in initial implementation
    webHost: null,     // CodeSandbox doesn't expose web host in initial implementation
    status: mapStatus(sandbox.status || 'RUNNING'),
    credentialRef: credentialRef || null,
    credentialFingerprint: credentialFingerprint || null,
    metadata: cleanMetadata(metadata)
  };

  return session;
}

function mapStatus(codeSandboxStatus) {
  // Map CodeSandbox status to application status
  const statusMap = {
    'RUNNING': 'RUNNING',
    'SUSPENDED': 'SUSPENDED',
    'IDLE': 'IDLE',
    'PAUSED': 'PAUSED',
    'STARTING': 'STARTING',
    'STOPPED': 'TERMINATED',
    'DELETED': 'TERMINATED'
  };

  return statusMap[codeSandboxStatus] || 'RUNNING';
}

function cleanMetadata(metadata) {
  // Ensure metadata is serializable and doesn't contain sensitive data
  const result = { ...metadata };

  // Remove raw token if accidentally included
  delete result.token;

  return result;
}

module.exports = {
  mapToSession
};
