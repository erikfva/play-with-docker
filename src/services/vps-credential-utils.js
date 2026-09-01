'use strict';

const crypto = require('crypto');
const { ProviderError } = require('./errors/provider-errors');

const SUPPORTED_PROVIDERS = ['gcs', 'codesandbox', 'codespaces'];

/**
 * Validate that provider is one of the supported values.
 * Throws ProviderError with VPS_INVALID_PROVIDER on failure.
 */
function validateProvider(provider) {
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    throw new ProviderError(
      `Invalid provider: "${provider}". Must be one of: ${SUPPORTED_PROVIDERS.join(', ')}`,
      { code: 'VPS_INVALID_PROVIDER', statusCode: 400 }
    );
  }
}

/**
 * Validate that name is non-empty and contains no path separators or traversal sequences.
 * Throws ProviderError with VPS_NAME_INVALID on failure.
 */
function validateName(name) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new ProviderError(
      'VPS name is required and must be a non-empty string',
      { code: 'VPS_NAME_INVALID', statusCode: 400 }
    );
  }

  if (/[/\\]/.test(name) || name.includes('..')) {
    throw new ProviderError(
      'VPS name must not contain path separators (/ or \\) or traversal sequences (..)',
      { code: 'VPS_NAME_INVALID', statusCode: 400 }
    );
  }
}

/**
 * Validate credentialContent per provider and return extracted token/key material
 * plus a sha256 fingerprint.
 *
 * Returns:
 *   codespaces / codesandbox → { token: string, fingerprint: string }
 *   gcs                      → { keyJson: string, fingerprint: string }
 *
 * Throws ProviderError with a provider-specific code on failure.
 */
function validateAndFingerprintContent(provider, credentialContent) {
  if (typeof credentialContent !== 'string' || !credentialContent.trim()) {
    throw new ProviderError(
      'credentialContent is required and must be a non-empty string',
      { code: 'VPS_CONTENT_INVALID', statusCode: 400 }
    );
  }

  if (provider === 'codespaces') {
    return _validateCodespacesContent(credentialContent);
  }

  if (provider === 'codesandbox') {
    return _validateCodeSandboxContent(credentialContent);
  }

  if (provider === 'gcs') {
    return _validateGcsContent(credentialContent);
  }

  // validateProvider should have caught this, but guard anyway
  throw new ProviderError(
    `Unsupported provider for content validation: ${provider}`,
    { code: 'VPS_INVALID_PROVIDER', statusCode: 400 }
  );
}

// ---------------------------------------------------------------------------
// Per-provider validators
// ---------------------------------------------------------------------------

/**
 * Codespaces: JSON with a token field, OR plain-text PAT.
 * Valid JSON without a token field is rejected — never falls through to plain text.
 */
function _validateCodespacesContent(credentialContent) {
  const text = credentialContent.trim();

  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    parseError = err;
  }

  if (parseError === null) {
    // Successfully parsed as JSON
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ProviderError(
        'Codespaces credentialContent JSON must be an object',
        { code: 'VPS_CONTENT_INVALID', statusCode: 400 }
      );
    }

    // Valid JSON object without a token field → reject, do NOT treat as plain-text PAT
    if (typeof parsed.token !== 'string' || !parsed.token.trim()) {
      throw new ProviderError(
        'Codespaces credentialContent JSON must contain a non-empty "token" string field',
        { code: 'CODESPACES_NO_CREDENTIAL', statusCode: 400 }
      );
    }

    const token = parsed.token.trim();
    const fingerprint = `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`;
    return { token, fingerprint };
  }

  // Not JSON — treat as plain-text PAT
  if (!text) {
    throw new ProviderError(
      'Codespaces credentialContent must not be empty',
      { code: 'CODESPACES_NO_CREDENTIAL', statusCode: 400 }
    );
  }

  const fingerprint = `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
  return { token: text, fingerprint };
}

/**
 * CodeSandbox: JSON with a token field only. Plain text is rejected.
 */
function _validateCodeSandboxContent(credentialContent) {
  const text = credentialContent.trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ProviderError(
      `CodeSandbox credentialContent must be valid JSON: ${err.message}`,
      { code: 'CODESANDBOX_CREDENTIALS_INVALID', statusCode: 400 }
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProviderError(
      'CodeSandbox credentialContent JSON must be an object',
      { code: 'CODESANDBOX_CREDENTIALS_INVALID', statusCode: 400 }
    );
  }

  if (typeof parsed.token !== 'string' || !parsed.token.trim()) {
    throw new ProviderError(
      'CodeSandbox credentialContent JSON must contain a non-empty "token" string field',
      { code: 'CODESANDBOX_CREDENTIALS_INVALID', statusCode: 400 }
    );
  }

  const token = parsed.token.trim();
  const fingerprint = `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`;
  return { token, fingerprint };
}

/**
 * GCS: JSON object with at minimum a "type" field (Google service account JSON).
 * Fingerprint is sha256 of the canonicalized JSON string.
 * Two different service account keys (even for the same project) get distinct fingerprints.
 */
function _validateGcsContent(credentialContent) {
  const text = credentialContent.trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ProviderError(
      `GCS credentialContent must be valid JSON: ${err.message}`,
      { code: 'GCS_CREDENTIALS_INVALID', statusCode: 400 }
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProviderError(
      'GCS credentialContent JSON must be an object',
      { code: 'GCS_CREDENTIALS_INVALID', statusCode: 400 }
    );
  }

  if (typeof parsed.type !== 'string' || !parsed.type.trim()) {
    throw new ProviderError(
      'GCS credentialContent JSON must contain a "type" field (expected Google service account JSON)',
      { code: 'GCS_CREDENTIALS_INVALID', statusCode: 400 }
    );
  }

  // Canonicalize for stable fingerprinting regardless of original whitespace
  const keyJson = JSON.stringify(parsed);
  const fingerprint = `sha256:${crypto.createHash('sha256').update(keyJson).digest('hex')}`;
  return { keyJson, fingerprint };
}

module.exports = {
  SUPPORTED_PROVIDERS,
  validateProvider,
  validateName,
  validateAndFingerprintContent
};
