const fs = require('fs');
const os = require('os');
const path = require('path');
const { initGoogleCredentialsFromS3IfNeeded } = require('../services/google-credentials-loader');

async function setGoogleCredentials(req, res, next) {
  const googleCredentials = process.env.GOOGLE_APPLICATION_DEFAULT_CREDENTIALS;
  if (!googleCredentials) {
    return res.status(500).json({ error: 'Google Credentials is not configured' });
  }
  
  process.env.GOOGLE_APPLICATION_CREDENTIALS = googleCredentials;

  const headerGoogleCredentials = req.headers['x-google-credentials'];
  if (!headerGoogleCredentials) {
    return next();
  }
 
  try {
    const outputPath = await initGoogleCredentialsFromS3IfNeeded(headerGoogleCredentials);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = outputPath;
    return next();
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to initialize Google credentials from S3'   });
  }
}

module.exports = {
  setGoogleCredentials
};
