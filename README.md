# ELEV — AI-Powered Academic Research Validation Framework

An AI-powered web application that validates academic research papers using
Claude AI, Qdrant vector search, and a four-module evaluation pipeline
(structure, citations, argument strength, integrity risk).

---

## Project Structure

```
Elevvdd/
├── frontend/               ← Static HTML/CSS/JS — deploys to Netlify
│   ├── index.html
│   ├── upload.html
│   ├── css/
│   │   ├── styles.css
│   │   └── upload.css
│   └── js/
│       ├── config.js       ← Auto-detects dev vs production backend URL
│       ├── main.js
│       └── upload.js
├── backend/                ← Node.js/Express API — deploys to Railway
│   ├── server.js
│   ├── package.json
│   ├── railway.json        ← Railway deployment config
│   ├── nixpacks.toml       ← System deps for canvas/OCR on Railway
│   ├── Procfile            ← Render/Heroku fallback
│   ├── .env.example        ← Copy to .env for local development
│   ├── config/
│   │   ├── firebase.js
│   │   ├── storage.js
│   │   └── qdrant.js       ← Qdrant client + collection management
│   ├── routes/
│   │   ├── upload.js       ← POST /api/upload  (main analysis pipeline)
│   │   ├── feedback.js
│   │   ├── validate.js
│   │   └── metrics.js
│   └── services/
│       ├── pdfParser.js    ← pdfjs-dist page-by-page extraction + OCR
│       ├── claudeAnalyzer.js ← Claude API + RAG prompt builder
│       ├── vectorStore.js  ← Qdrant chunking / embedding / retrieval
│       └── analysisEngine.js ← Heuristic fallback
├── scripts/
│   └── build.sh            ← Generates frontend/_redirects at Netlify build time
├── netlify.toml            ← Netlify build + headers config
└── .gitignore
```

---

## How the production architecture works

```
Browser → Netlify CDN (frontend)
            └─ /api/* → Netlify proxy → Railway (backend API)
                                            └─ Claude API
                                            └─ Qdrant Cloud
                                            └─ Firebase (optional)
```

The Netlify proxy means the browser never makes a cross-origin request.
CORS is irrelevant in production.

---

## Local Development

### Prerequisites
- Node.js 18+
- A backend/.env file (see below)

```bash
# 1. Install backend dependencies
cd backend
npm install

# 2. Create and edit your local .env
cp .env.example .env
# Fill in ANTHROPIC_API_KEY and QDRANT_* at minimum

# 3. Start the backend
npm run dev          # http://localhost:3000  (auto-reloads)

# 4. Open the frontend
# Option A: VS Code → right-click frontend/upload.html → Open with Live Server
# Option B: python -m http.server 8080  (then open http://localhost:8080)
# Option C: npx serve frontend
```

The frontend `config.js` detects `localhost` and points directly at `http://localhost:3000`.

---

## Production Deployment

### Overview

| Service | What goes there | Config file |
|---------|----------------|-------------|
| **Railway** | Node.js backend API | `backend/railway.json` |
| **Netlify** | Static HTML/JS/CSS frontend | `netlify.toml` |

Deploy the **backend first** to get its URL, then deploy the frontend.

---

### Step 1 — Push to GitHub

```bash
# From the Elevvdd/ root folder:
git init
git add .
git commit -m "Initial commit"
```

Create a new repository on GitHub (github.com → New repository → **do not** add a README).
Then push:

```bash
git remote add origin https://github.com/YOUR_USERNAME/elev.git
git branch -M main
git push -u origin main
```

---

### Step 2 — Deploy the backend to Railway

1. Go to **railway.app** → **New Project** → **Deploy from GitHub repo**
2. Select your repository
3. Railway detects `backend/` via `railway.json` and starts a Nixpacks build
4. Click **Add variables** (or go to **Variables** tab) and add every value from `backend/.env.example`:

   | Variable | Value |
   |----------|-------|
   | `NODE_ENV` | `production` |
   | `ANTHROPIC_API_KEY` | your Claude API key |
   | `QDRANT_URL` | your Qdrant cluster URL |
   | `QDRANT_API_KEY` | your Qdrant API key |
   | `QDRANT_COLLECTION` | `elev_chunks` |
   | `CORS_ORIGIN` | `*` (update after you know the Netlify URL) |
   | `RATE_LIMIT_WINDOW_MS` | `900000` |
   | `RATE_LIMIT_MAX` | `100` |

   Firebase variables are optional (results survive in memory otherwise).

5. Wait for the build to finish — Railway shows a green **Active** badge
6. Click **Settings** → **Networking** → **Generate Domain**
7. Copy your Railway URL, e.g. `https://elev-api-production.up.railway.app`
8. Verify the backend is alive: open `https://YOUR-RAILWAY-URL/api/health` in a browser.
   You should see: `{"status":"ok","service":"ELEV API",...}`

---

### Step 3 — Deploy the frontend to Netlify

1. Go to **app.netlify.com** → **Add new site** → **Import an existing project**
2. Connect GitHub → select your repository
3. Netlify auto-reads `netlify.toml`. The build settings should show:
   - **Build command:** `bash scripts/build.sh`
   - **Publish directory:** `frontend`
4. Before clicking **Deploy**, go to **Site settings → Environment variables → Add variable**:

   | Variable | Value |
   |----------|-------|
   | `BACKEND_URL` | your Railway URL from Step 2 (no trailing slash) |

   Example: `https://elev-api-production.up.railway.app`

5. Click **Deploy site**
6. Netlify runs `scripts/build.sh`, which writes `frontend/_redirects`:
   ```
   /api/*  https://elev-api-production.up.railway.app/api/:splat  200
   ```
7. When the build finishes, Netlify shows your public URL, e.g.:
   `https://elev-xyz.netlify.app`

---

### Step 4 — Lock down CORS (optional but recommended)

Now that you know your Netlify URL, tighten `CORS_ORIGIN` on Railway:

1. Railway dashboard → your service → **Variables**
2. Update `CORS_ORIGIN` from `*` to your Netlify URL:
   ```
   CORS_ORIGIN=https://elev-xyz.netlify.app
   ```
3. Railway automatically restarts the service.

---

### Step 5 — Test your live deployment

Open your Netlify URL and:
- [ ] Home page loads
- [ ] Upload page loads
- [ ] Upload a PDF → analysis completes and results appear
- [ ] Check Railway logs for `[upload]`, `[vectorStore]`, `[claudeAnalyzer]` entries

---

### Custom domain (optional)

**Netlify:** Site settings → Domain management → Add custom domain

**Railway:** Settings → Networking → Custom domain

---

## Updating after deployment

### Backend change
```bash
git add backend/
git commit -m "Update backend"
git push
```
Railway auto-deploys from `main`.

### Frontend change
```bash
git add frontend/ scripts/ netlify.toml
git commit -m "Update frontend"
git push
```
Netlify auto-deploys from `main`.

---

## Environment variables reference

### Backend (set in Railway dashboard, or backend/.env for local)

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `QDRANT_URL` | Yes* | Qdrant Cloud cluster URL |
| `QDRANT_API_KEY` | Yes* | Qdrant API key |
| `QDRANT_COLLECTION` | No | Collection name (default: `elev_chunks`) |
| `CORS_ORIGIN` | No | Allowed origins (default: `*`) |
| `NODE_ENV` | No | Set to `production` on Railway |
| `PORT` | No | Railway sets this automatically |
| `CLAUDE_MODEL` | No | Override Claude model (default: `claude-haiku-4-5-20251001`) |
| `RATE_LIMIT_MAX` | No | Requests per 15 min per IP (default: 100) |
| `MAX_OCR_PAGES` | No | Max scanned pages to OCR per upload (default: 8) |
| `FIREBASE_*` | No | Firebase/Firestore persistence |

*Analysis still works without Qdrant — semantic retrieval is skipped.

### Frontend (set in Netlify dashboard)

| Variable | Required | Description |
|----------|----------|-------------|
| `BACKEND_URL` | **Yes** | Railway backend URL, no trailing slash |

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/upload` | Upload PDF and run analysis |
| `GET` | `/api/upload/:id` | Retrieve cached analysis by ID |
| `POST` | `/api/feedback` | Submit user feedback |
| `GET` | `/api/feedback` | List feedback entries |
| `GET` | `/api/metrics` | Benchmark data |
| `POST` | `/api/validate` | Abstract validation (heuristic) |

---

## Technology stack

| Layer | Technology |
|-------|-----------|
| Frontend | HTML5 / CSS3 / Vanilla JS — no build step |
| Backend | Node.js 20 + Express 4 |
| AI | Anthropic Claude (haiku/sonnet) via `@anthropic-ai/sdk` |
| Vector DB | Qdrant Cloud via `@qdrant/js-client-rest` |
| PDF parsing | `pdfjs-dist` (page-by-page, exact page count) |
| OCR | `tesseract.js` + `canvas` (optional, for scanned PDFs) |
| Persistence | Firebase Admin SDK / Firestore (optional) |
| Hosting | Netlify (frontend) + Railway (backend) |

---

## License
MIT — free to use, modify, and distribute.
