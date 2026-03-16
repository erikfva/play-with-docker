function extractBearerToken(authorizationHeader) {
  if (!authorizationHeader) return null;
  const [scheme, value] = authorizationHeader.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
  return value || null;
}

function requireServerToken(req, res, next) {
  const serverToken = process.env.SERVER_TOKEN;
  if (!serverToken) {
    return res.status(500).json({ error: 'Server token is not configured' });
  }

  const headerToken = req.headers['x-server-token'];
  const bearerToken = extractBearerToken(req.headers.authorization);
  const token = headerToken || bearerToken;

  if (!token || token !== serverToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

module.exports = {
  requireServerToken
};
