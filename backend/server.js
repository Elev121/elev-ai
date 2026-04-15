require('dotenv').config();
const express = require('express');
const path    = require('path');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const rateLimit = require('express-rate-limit');
const { initializeFirebase } = require('./config/firebase');
const { initCollection }    = require('./config/qdrant');

const feedbackRouter = require('./routes/feedback');
const validateRouter = require('./routes/validate');
const metricsRouter  = require('./routes/metrics');
const uploadRouter   = require('./routes/upload');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Security & Middleware ────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false }));

// Serve uploaded files (kept locally when Firebase Storage not configured)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── CORS ─────────────────────────────────────────────────────────────────────
// Supports:
//   CORS_ORIGIN=*                 → allow everything (development default)
//   CORS_ORIGIN=https://foo.com   → single origin
//   CORS_ORIGIN=https://a.com,https://b.com → multiple origins
// Also allows:
//   - null origin (file:// protocol, used when opening HTML directly from disk)
//   - Chrome Private Network Access preflight (localhost from non-http context)
const rawCorsOrigins = (process.env.CORS_ORIGIN || '*').split(',').map((s) => s.trim());
const corsWildcard   = rawCorsOrigins.includes('*');

function isCorsAllowed(origin) {
  if (corsWildcard) return true;
  if (!origin)      return true;   // null origin = file:// protocol, allow in dev
  return rawCorsOrigins.includes(origin);
}

// Handle Chrome's "Private Network Access" preflight.
// When a page from file:// or a public origin hits localhost, Chrome sends an
// extra OPTIONS with Access-Control-Request-Private-Network: true.
// The server must echo back Access-Control-Allow-Private-Network: true or Chrome
// blocks the actual request — this looks identical to a network failure in JS.
app.use((req, res, next) => {
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  next();
});

app.use(
  cors({
    origin: (origin, callback) => {
      if (isCorsAllowed(origin)) {
        callback(null, corsWildcard ? '*' : (origin || '*'));
      } else {
        callback(new Error(`CORS: origin '${origin}' is not allowed. Set CORS_ORIGIN in backend/.env`));
      }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
  })
);

// Global rate limiter
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
});
app.use(limiter);

// Stricter limiter for the validate endpoint
const validateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many validation requests. Slow down.' },
});

// Upload limiter: 5 PDFs per minute per IP
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { success: false, message: 'Too many upload requests. Please wait a moment.' },
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ELEV API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/feedback', feedbackRouter);
app.use('/api/validate', validateLimiter, validateRouter);
app.use('/api/metrics',  metricsRouter);
app.use('/api/upload',   uploadLimiter,  uploadRouter);

// ─── 404 handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found.' });
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[server] Unhandled error:', err);
  res.status(500).json({ success: false, message: 'Internal server error.' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
initializeFirebase();

app.listen(PORT, async () => {
  console.log(`\n  ELEV API running on http://localhost:${PORT}`);
  console.log(`  Environment : ${process.env.NODE_ENV || 'development'}`);
  console.log(`  Health check: http://localhost:${PORT}/api/health`);

  // Initialise Qdrant collection (idempotent — safe to call on every restart).
  // Runs after the HTTP server is up so startup failures don't block requests.
  try {
    const qdrantReady = await initCollection();
    console.log(`  Qdrant       : ${qdrantReady ? '✓ ready' : '⚠ disabled (QDRANT_URL not set)'}`);
  } catch (err) {
    console.error(`  Qdrant       : ✗ init error — ${err.message}`);
  }

  console.log('');
});

module.exports = app;
