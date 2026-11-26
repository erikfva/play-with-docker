const express = require('express');
const { getProvider } = require('../services/provider-factory');
const { ProviderError } = require('../services/errors/provider-errors');
const { mapErrorToHttp } = require('../utils/http-helpers');

const router = express.Router();

function getCodespacesCredentialRef(req) {
  return req.headers['x-codespaces-credentials'] || req.body?.credentialRef || null;
}

const ACTIONS = new Map([
  [
    'ensure',
    async (provider, req) => {
      const credentialRef = getCodespacesCredentialRef(req);
      if (!credentialRef) {
        throw new ProviderError(
          'Codespaces credential reference is required in x-codespaces-credentials header or credentialRef in body',
          { code: 'CODESPACES_NO_CREDENTIAL', statusCode: 401 }
        );
      }

      const payload = {
        ...(req.body || {}),
        credentialRef
      };

      const result = await provider.ensureCodespace(payload);
      return {
        statusCode: result.created ? 201 : 200,
        data: {
          action: 'ensure',
          provider: 'codespaces',
          credentialRef,
          ...result
        }
      };
    }
  ]
]);

router.post('/rpc/:action', async (req, res) => {
  const action = req.params.action;
  const handler = ACTIONS.get(action);

  if (!handler) {
    return res.status(400).json({
      error: `Unsupported Codespaces RPC action: ${action}`,
      code: 'CODESPACES_UNSUPPORTED_ACTION',
      details: {
        action,
        supportedActions: Array.from(ACTIONS.keys())
      }
    });
  }

  try {
    const provider = getProvider('codespaces');
    const response = await handler(provider, req);
    return res.status(response.statusCode).json(response.data);
  } catch (error) {
    return mapErrorToHttp(res, error, 'Codespaces RPC action failed');
  }
});

module.exports = router;
