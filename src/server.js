require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const db = require('./db/db');
const sessionRoutes = require('./routes/sessions');
const { requireServerToken } = require('./middleware/require-server-token');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

// Routes
app.use('/api/v1/sessions', requireServerToken, sessionRoutes);

// Health Check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

db.ready
  .then(() => {
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  })
  .catch((err) => {
    console.error('Server startup aborted due to DB initialization error:', err.message);
    process.exit(1);
  });
