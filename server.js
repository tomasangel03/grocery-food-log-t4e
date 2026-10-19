// server.js — Household Grocery Food Log entry point
require('dotenv').config();
const express = require('express');
const path = require('path');
const pool = require('./db');

const app = express();

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static assets (frontend must use RELATIVE urls — app sits behind a stripped path prefix)
app.use(express.static(path.join(__dirname, 'public')));

// Root entry point — the app has no index.html, the journey starts at the login screen
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Health check
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'unreachable', message: err.message });
  }
});

// Auth routes (login + self-registration + Google OAuth)
app.use('/v1/auth', require('./routes/auth'));

// Households: create, join, membership (JWT-protected)
app.use('/v1', require('./routes/households'));

// Grocery/inventory routes: shopping trips + food items (JWT-protected)
app.use('/v1', require('./routes/groceries'));

// Dashboard summary (JWT-protected)
app.use('/v1', require('./routes/dashboard'));

// Admin-only: activity log + user management
app.use('/v1', require('./routes/admin'));

// 404 fallback for unknown API routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Clean-URL fallback: "dashboard" -> public/dashboard.html, "food_log" -> public/food_log.html, ...
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/v1') || req.path.startsWith('/api')) return next();
  if (path.extname(req.path)) return next();

  const slug = req.path.replace(/^\/+|\/+$/g, '');
  if (!slug || !/^[a-zA-Z0-9_-]+$/.test(slug)) return next();

  const candidate = path.join(__dirname, 'public', `${slug}.html`);
  res.sendFile(candidate, (err) => {
    if (err) next();
  });
});

// job_monthly_stats: monthly spend/item rollup at 02:00 on the 1st
require('./jobs/monthlyStats').start();

// Vercel imports this file and serves the exported app. It already sets PORT
// and must not have the process call listen() itself.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT;
  if (!PORT) {
    console.error('FATAL: PORT environment variable is not set — refusing to start.');
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`FoodLog listening on port ${PORT}`);
  });
}

module.exports = app;