#!/usr/bin/env bash
# scripts/build.sh
#
# Netlify build script.
# Generates frontend/_redirects so that all /api/* requests from the browser
# are proxied to the Railway backend — completely eliminating CORS for the
# production frontend.
#
# Required environment variable (set in Netlify dashboard):
#   BACKEND_URL  — your Railway backend URL, no trailing slash
#   Example:  https://elev-api-production.up.railway.app
#
set -euo pipefail

# ── Validate BACKEND_URL ──────────────────────────────────────────────────────
if [[ -z "${BACKEND_URL:-}" ]]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  BUILD ERROR: BACKEND_URL is not set                        ║"
  echo "║                                                              ║"
  echo "║  Go to: Netlify → your site → Site settings                 ║"
  echo "║         → Environment variables → Add variable              ║"
  echo "║                                                              ║"
  echo "║  Key:   BACKEND_URL                                         ║"
  echo "║  Value: https://your-app.up.railway.app   (no slash at end) ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  exit 1
fi

# Strip trailing slash if present
BACKEND_URL="${BACKEND_URL%/}"

# ── Generate _redirects ───────────────────────────────────────────────────────
REDIRECTS_FILE="frontend/_redirects"

printf '/api/*  %s/api/:splat  200\n' "$BACKEND_URL" > "$REDIRECTS_FILE"

echo ""
echo "✓ Generated $REDIRECTS_FILE"
echo "  /api/*  →  $BACKEND_URL/api/:splat  (Netlify proxy)"
echo ""
