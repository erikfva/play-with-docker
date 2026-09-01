'use strict';

const { ProviderError } = require('../services/errors/provider-errors');

/**
 * Serialize an error into an HTTP response.
 * Handles ProviderError with its structured code/statusCode/details,
 * and falls back to generic status detection for plain errors.
 */
function mapErrorToHttp(res, error, fallbackMessage) {
  if (error instanceof ProviderError) {
    return res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
      details: error.details
    });
  }

  console.error(error);

  function isValidHttpStatus(v) {
    return Number.isInteger(v) && v >= 100 && v < 600;
  }

  const statusCode = isValidHttpStatus(error.statusCode)
    ? error.statusCode
    : isValidHttpStatus(error.status)
      ? error.status
      : isValidHttpStatus(error.code)
        ? error.code
        : 500;

  return res.status(statusCode).json({
    error: error.message || fallbackMessage,
    code: error.code
  });
}

module.exports = { mapErrorToHttp };
