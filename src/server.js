// Only load dotenv in development, not in production (like Render)
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config({override: true});
}

const express = require('express');
const bodyParser = require('body-parser');
const db = require('./db/db');
const sessionRoutes = require('./routes/sessions');
const { requireServerToken } = require('./middleware/require-server-token');
const keepAliveService = require('./services/keep-alive-service');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

// Routes
app.use('/api/v1/sessions', requireServerToken, sessionRoutes);

// Health Check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

async function startServer() {
  try {
    await db.ready;
    console.log('db ready in server');

    try {
      const recoverySummary = await keepAliveService.recoverKeepAlivesOnStartup();
      if (recoverySummary.scanned > 0) {
        console.log('[KeepAlive][Recovery] Completed:', recoverySummary);
      }
    } catch (error) {
      // Recovery is best-effort; server startup should continue.
      console.warn('[KeepAlive][Recovery] Startup recovery failed:', error.message);
    }

    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  } catch (err) {
    console.error('Server startup aborted due to initialization error:', err.message);
    process.exit(1);
  }
}

startServer();
