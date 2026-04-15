/**
 * ELEV — config.js
 *
 * Runtime environment detection — no manual edits needed when deploying.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  DEVELOPMENT  (localhost / 127.0.0.1)                               │
 * │  Calls the backend directly at http://localhost:3000.               │
 * │  CORS is handled by CORS_ORIGIN=* in backend/.env.                  │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │  PRODUCTION   (Netlify — any other hostname)                        │
 * │  Uses relative paths (/api/...) so the browser always talks to      │
 * │  the same origin (Netlify).  Netlify proxies /api/* to Railway      │
 * │  via the _redirects rule generated at build time — no CORS needed.  │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * The _redirects file is written by scripts/build.sh from the
 * BACKEND_URL environment variable you set in Netlify → Site settings
 * → Environment variables.
 */

const _isLocal =
  window.location.hostname === 'localhost'  ||
  window.location.hostname === '127.0.0.1' ||
  window.location.hostname === '';          // opened as file://

// In production BACKEND_URL is '' (empty = same origin, proxied by Netlify).
// In development it points directly at the Express server.
const BACKEND_URL = _isLocal ? 'http://localhost:3000' : '';

const API_BASE   = `${BACKEND_URL}/api`;
const API_UPLOAD = `${BACKEND_URL}/api/upload`;
