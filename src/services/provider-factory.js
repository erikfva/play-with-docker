const GcsProvider = require('./providers/gcs-provider');
const PwdProvider = require('./providers/pwd-provider');
const CodeSandboxProvider = require('./providers/codesandbox-provider');
const CodespacesProvider = require('./providers/codespaces-provider');
const { UnsupportedProviderError } = require('./errors/provider-errors');

const providers = {
  gcs: new GcsProvider(),
  pwd: new PwdProvider(),
  codesandbox: new CodeSandboxProvider(),
  codespaces: new CodespacesProvider()
};

function normalizeProviderName(provider) {
  return (provider || 'gcs').toString().trim().toLowerCase();
}

function getProvider(providerName) {
  const normalized = normalizeProviderName(providerName);
  const provider = providers[normalized];

  if (!provider) {
    throw new UnsupportedProviderError(normalized);
  }

  return provider;
}

function listProviders() {
  return Object.keys(providers);
}

module.exports = {
  getProvider,
  listProviders,
  normalizeProviderName
};
