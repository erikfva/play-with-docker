class ProviderError extends Error {
  constructor(message, { code = 'PROVIDER_ERROR', statusCode = 500, details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

class UnsupportedProviderError extends ProviderError {
  constructor(provider) {
    super(`Unsupported provider: ${provider}`, {
      code: 'UNSUPPORTED_PROVIDER',
      statusCode: 400
    });
  }
}

class ProviderNotImplementedError extends ProviderError {
  constructor(provider) {
    super(`Provider is not implemented: ${provider}`, {
      code: 'PROVIDER_NOT_IMPLEMENTED',
      statusCode: 501
    });
  }
}

class SessionNotReadyError extends ProviderError {
  constructor(status) {
    super(`Session is not ready. Current status: ${status}`, {
      code: 'SESSION_NOT_READY',
      statusCode: 409,
      details: { status }
    });
  }
}

class InvalidCredentialsError extends ProviderError {
  constructor(message) {
    super(message, {
      code: 'INVALID_CREDENTIALS',
      statusCode: 400,
      details: { reason: 'credentials_invalid' }
    });
  }
}

class ConflictError extends ProviderError {
  constructor(message) {
    super(message, {
      code: 'CONFLICT',
      statusCode: 409
    });
  }
}

class ProviderUnavailableError extends ProviderError {
  constructor(message) {
    super(message, {
      code: 'PROVIDER_UNAVAILABLE',
      statusCode: 503
    });
  }
}

module.exports = {
  ProviderError,
  UnsupportedProviderError,
  ProviderNotImplementedError,
  SessionNotReadyError,
  InvalidCredentialsError,
  ConflictError,
  ProviderUnavailableError
};
