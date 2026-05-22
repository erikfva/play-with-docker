const { initGoogleCredentialsFromS3IfNeeded } = require('../services/google-credentials-loader');

async function setGoogleCredentials(req, res, next) {
  const googleCredentials = req.headers['x-google-credentials']
    || req.body?.googleCredentialRef
    || req.body?.credentialRef;

  if (!googleCredentials) {
    return res.status(400).json({
      error: 'Google credential reference is required in x-google-credentials or request body credentialRef/googleCredentialRef',
      code: 'GOOGLE_CREDENTIALS_MISSING'
    });
  }
 
  try {
    await initGoogleCredentialsFromS3IfNeeded(googleCredentials);
    return next();
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to initialize Google credentials from S3'   });
  }
}

module.exports = {
  setGoogleCredentials
};
