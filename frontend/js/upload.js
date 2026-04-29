/**
 * ELEV — upload.js  v4
 * Real PDF upload pipeline — no mock data, no hardcoded feedback.
 * Every result is generated from the actual uploaded document via the AI analysis engine.
 *
 * Renders the normalised shape from the analysis pipeline:
 * { elevScore, grade, documentProfile, overall,
 *   structural, citation, argument, integrity }
 */

'use strict';

// API_UPLOAD is defined in config.js (loaded before this file).

// ── DOM refs ──────────────────────────────────────────────────────────────────
const dropZone       = document.getElementById('dropZone');
const fileInput      = document.getElementById('fileInput');
const fileInfoCard   = document.getElementById('fileInfoCard');
const fileNameEl     = document.getElementById('fileName');
const fileSizeEl     = document.getElementById('fileSize');
const fileRemove     = document.getElementById('fileRemove');
const analyzeBtn     = document.getElementById('analyzeBtn');
const uploadProgress = document.getElementById('uploadProgress');
const progressFill   = document.getElementById('progressFill');
const progressLabel  = document.getElementById('progressLabel');
const progressPct    = document.getElementById('progressPct');
const uploadError    = document.getElementById('uploadError');
const errorText      = document.getElementById('errorText');

const resultsEmpty      = document.getElementById('resultsEmpty');
const resultsProcessing = document.getElementById('resultsProcessing');
const resultsContent    = document.getElementById('resultsContent');

let selectedFile = null;
let lastResults  = null;

// ── Navbar ────────────────────────────────────────────────────────────────────
window.addEventListener('scroll', () => {
  document.getElementById('navbar').classList.toggle('scrolled', window.scrollY > 20);
}, { passive: true });
document.getElementById('navToggle').addEventListener('click', () => {
  document.getElementById('navLinks').classList.toggle('open');
});

// ── File handling ─────────────────────────────────────────────────────────────
['dragenter','dragover'].forEach((e) =>
  dropZone.addEventListener(e, (ev) => { ev.preventDefault(); dropZone.classList.add('drag-over'); }));
['dragleave','drop'].forEach((e) =>
  dropZone.addEventListener(e, (ev) => { ev.preventDefault(); dropZone.classList.remove('drag-over'); }));
dropZone.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
dropZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
dropZone.addEventListener('click', (e) => { if (e.target !== fileInput) fileInput.click(); });
fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

function handleFile(file) {
  clearError();
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    showError('Only PDF files are accepted.'); return;
  }
  if (file.size > 20 * 1024 * 1024) {
    showError(`File too large (${fmtBytes(file.size)}). Max 20 MB.`); return;
  }
  selectedFile = file;
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = fmtBytes(file.size);
  show(fileInfoCard); hide(uploadProgress);
  analyzeBtn.disabled = false;
}

fileRemove.addEventListener('click', resetUpload);
analyzeBtn.addEventListener('click', () => { if (selectedFile) startAnalysis(); });

// ── Connectivity diagnostics ──────────────────────────────────────────────────
// Returns a plain-English diagnosis string when the backend can't be reached.
// Inspects page protocol, tests the health endpoint, and surfaces the real cause.
async function diagnoseConnectivity() {
  const uploadUrl = (typeof API_UPLOAD !== 'undefined') ? API_UPLOAD : '(API_UPLOAD undefined — config.js not loaded?)';
  const healthUrl = (typeof API_BASE  !== 'undefined') ? `${API_BASE}/health` : null;
  const lines = [`Attempted POST to: ${uploadUrl}`, `Page origin: ${window.location.origin}`];

  // ── 1. file:// protocol check ────────────────────────────────────────────
  if (window.location.protocol === 'file:') {
    lines.push(
      '',
      'ROOT CAUSE: You opened upload.html directly from the filesystem (file:// protocol).',
      'Browsers block cross-origin requests from file:// pages to http://localhost because',
      'file:// sends a null origin that most CORS configs reject.',
      '',
      'FIX — open the frontend via a local HTTP server instead:',
      '  Option A (VS Code):  install the "Live Server" extension → right-click upload.html → Open with Live Server',
      '  Option B (terminal): cd frontend && npx serve .',
      '  Option C (Python):   cd frontend && python -m http.server 8080',
      'Then open http://localhost:<port>/upload.html in the browser.'
    );
    return lines.join('\n');
  }

  // ── 2. Health-endpoint probe ─────────────────────────────────────────────
  if (healthUrl) {
    lines.push('');
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 6000);
      const r    = await fetch(healthUrl, { signal: ctrl.signal });
      clearTimeout(tid);
      if (r.ok) {
        lines.push(
          `Health check OK (${r.status}) — backend is reachable.`,
          'The upload request itself failed. Check the browser Network tab for details.'
        );
      } else {
        lines.push(`Health check returned HTTP ${r.status}. Backend may be misconfigured.`);
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        lines.push(
          'Health check timed out — backend not responding.',
          'Make sure the backend is running:  cd backend && npm run dev'
        );
      } else {
        lines.push(
          `Health check failed: ${e.message}`,
          '',
          'Possible causes:',
          '  • Backend server is not running — run: cd backend && npm run dev',
          '  • CORS_ORIGIN in backend/.env does not include this page\'s origin',
          `    Current page origin: ${window.location.origin}`,
          `    Edit backend/.env  →  CORS_ORIGIN=*  (or add ${window.location.origin})`
        );
      }
    }
  }

  return lines.join('\n');
}

// ── Analysis pipeline ─────────────────────────────────────────────────────────
async function startAnalysis() {
  clearError();
  analyzeBtn.disabled = true;
  analyzeBtn.querySelector('.btn-text').textContent = 'Analysing…';
  show(analyzeBtn.querySelector('.btn-spinner'));
  show(uploadProgress);
  showState('processing');
  startProcessingAnim();

  const fd = new FormData();
  fd.append('pdf', selectedFile);

  try {
    const data = await uploadWithProgress(fd);
    if (!data.success) throw new Error(data.message || 'Analysis failed.');

    lastResults = data;
    await finishProgressAnim();
    renderAll(data);
    showState('results');
  } catch (err) {
    showState('empty');
    stopProcessingAnim();

    // Decide whether this looks like a connectivity problem
    const isConnErr = (err.message === 'xhr_error') ||
                      err.message.toLowerCase().includes('network') ||
                      err.message.toLowerCase().includes('failed to fetch') ||
                      err.message.toLowerCase().includes('could not reach');

    if (isConnErr) {
      // Run async diagnosis and update the error box when it resolves
      showError('Diagnosing connection problem…');
      diagnoseConnectivity().then((detail) => showError(detail));
    } else {
      showError(err.message);
    }
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.querySelector('.btn-text').textContent = 'Analyse Document';
    hide(analyzeBtn.querySelector('.btn-spinner'));
    hide(uploadProgress);
  }
}

function uploadWithProgress(fd) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    // Guard: make sure API_UPLOAD was actually defined by config.js
    if (typeof API_UPLOAD === 'undefined') {
      reject(new Error('API_UPLOAD is not defined. config.js may not have loaded. Check the browser console for script errors.'));
      return;
    }

    xhr.open('POST', API_UPLOAD, true);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 40), 'Uploading PDF…');
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try   { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error(`Server returned non-JSON. Raw response: ${xhr.responseText.slice(0, 200)}`)); }
      } else {
        // Surface the real server error message, never hide it
        let msg;
        try   { msg = JSON.parse(xhr.responseText).message; }
        catch { msg = null; }
        reject(new Error(msg || `HTTP ${xhr.status} from ${API_UPLOAD}. Check the backend console.`));
      }
    });

    // XHR 'error' fires for network failure AND CORS blocks — both show status 0.
    // We use a sentinel so the catch block knows to run the diagnostic instead of
    // showing a misleading raw message.
    xhr.addEventListener('error', () => reject(new Error('xhr_error')));

    xhr.timeout = 240000; // 4 min — AI analysis + OCR can take time
    xhr.addEventListener('timeout', () =>
      reject(new Error(`Request timed out after 4 minutes. URL: ${API_UPLOAD}. The PDF may be too large or the server is under load.`))
    );

    xhr.send(fd);
  });
}

// ── Processing animation ──────────────────────────────────────────────────────
const STEPS = ['procStep1','procStep2','procStep3','procStep4','procStep5'];
let stepIdx = 0, stepTimer = null;

function startProcessingAnim() {
  stepIdx = 0;
  setProgress(40, 'Running AI analysis…');
  STEPS.forEach((id) => { const e = document.getElementById(id); e.classList.remove('active','done'); });
  nextStep();
}
function nextStep() {
  if (stepIdx > 0) {
    const prev = document.getElementById(STEPS[stepIdx - 1]);
    prev.classList.remove('active'); prev.classList.add('done');
  }
  if (stepIdx >= STEPS.length) return;
  document.getElementById(STEPS[stepIdx]).classList.add('active');
  setProgress(Math.round(40 + ((stepIdx + 1) / STEPS.length) * 55), `Step ${stepIdx + 1}/${STEPS.length}…`);
  stepIdx++;
  stepTimer = setTimeout(nextStep, 2200); // longer intervals — real analysis takes time
}
function stopProcessingAnim() {
  clearTimeout(stepTimer);
  STEPS.forEach((id) => { const e = document.getElementById(id); e.classList.remove('active','done'); });
}
function finishProgressAnim() {
  clearTimeout(stepTimer);
  STEPS.forEach((id) => { const e = document.getElementById(id); e.classList.remove('active'); e.classList.add('done'); });
  setProgress(100, 'Analysis complete!');
  return new Promise((r) => setTimeout(r, 500));
}
function setProgress(pct, lbl) {
  progressFill.style.width = pct + '%';
  progressPct.textContent  = pct + '%';
  if (lbl) progressLabel.textContent = lbl;
}

// ══ RENDER: MAIN ORCHESTRATOR ═════════════════════════════════════════════════

function renderAll(data) {
  const { elevScore, grade, overallNarrative, overall = {},
          structural, citation, argument, integrity,
          document: doc, documentProfile: dp, analysedBy } = data;

  // Title + meta
  document.getElementById('resultsDocTitle').textContent = doc?.title || 'Analysis Results';
  document.getElementById('docMeta').innerHTML = [
    `<span class="doc-meta-item"><strong>${(doc?.wordCount || 0).toLocaleString()}</strong> words</span>`,
    `<span class="doc-meta-item"><strong>${doc?.pageCount || '—'}</strong> pages</span>`,
    `<span class="doc-meta-item">Format: <strong>${doc?.citationFormat || 'Unknown'}</strong></span>`,
    analysedBy === 'claude'
      ? '<span class="doc-meta-item analysed-by-ai">AI Analysis</span>'
      : '<span class="doc-meta-item">Heuristic</span>',
  ].join('');

  // Overall score circle
  const overallColor = scoreColor(elevScore);
  animateCircle('overallScoreFill', elevScore, 326.73, overallColor);
  document.getElementById('overallScoreValue').textContent = elevScore;
  const gradeEl = document.getElementById('overallGrade');
  gradeEl.textContent = `Grade: ${grade}`;
  gradeEl.style.cssText = `background:${overallColor}22;color:${overallColor};border:1px solid ${overallColor}44`;

  // Overall narrative + strengths/improvements banner
  const oldBanner = document.querySelector('.overall-narrative');
  if (oldBanner) oldBanner.remove();
  if (overallNarrative) {
    const banner = document.createElement('div');
    banner.className = 'overall-narrative';
    banner.innerHTML = `<p>${overallNarrative}</p>`;
    if (overall.topStrengths?.length || overall.topImprovements?.length) {
      banner.innerHTML += strengthsImprovementsGrid(overall.topStrengths || [], overall.topImprovements || []);
    }
    document.getElementById('moduleSummary').before(banner);
  }

  // Document Verification Panel — proves real document was analyzed
  const oldPanel = document.querySelector('.doc-profile-panel');
  if (oldPanel) oldPanel.remove();
  if (dp) {
    const panel = document.createElement('div');
    panel.innerHTML = renderDocumentProfile(dp, doc, analysedBy);
    document.getElementById('moduleSummary').before(panel.firstElementChild);
  }

  // Module score bars
  const mods = [
    { name: 'Structural', score: structural.score, color: '#3b82f6' },
    { name: 'Citation',   score: citation.score,   color: '#8b5cf6' },
    { name: 'Argument',   score: argument.score,   color: '#14b8a6' },
    { name: 'Integrity',  score: integrity.score,  color: '#f97316' },
  ];
  document.getElementById('moduleSummary').innerHTML = mods.map((m) => `
    <div class="mod-bar-item">
      <div class="mod-bar-label">
        <span>${m.name}</span>
        <span class="mod-bar-score">${m.score}</span>
      </div>
      <div class="mod-bar-track">
        <div class="mod-bar-fill" style="background:${m.color}" data-w="${m.score}"></div>
      </div>
    </div>`).join('');
  setTimeout(() => {
    document.querySelectorAll('.mod-bar-fill').forEach((el) => { el.style.width = el.dataset.w + '%'; });
  }, 100);

  // Render each tab
  renderStructural(structural);
  renderCitation(citation);
  renderArgument(argument);
  renderIntegrity(integrity);

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => {
        b.classList.remove('active'); b.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
      btn.classList.add('active'); btn.setAttribute('aria-selected', 'true');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
    });
  });

  // Action buttons
  document.getElementById('downloadBtn').onclick = () => {
    const blob = new Blob([JSON.stringify(lastResults, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ELEV-report-${(doc?.title || 'analysis').replace(/\W+/g, '-')}.json`;
    a.click();
  };
  document.getElementById('resetBtn').onclick = resetUpload;
}

// ── Document Verification Panel ───────────────────────────────────────────────
function renderDocumentProfile(dp, doc, analysedBy) {
  const sections = dp.sectionsDetected || {};
  const SECTION_LABELS = {
    abstract: 'Abstract', introduction: 'Intro', literatureReview: 'Lit. Review',
    methodology: 'Method', results: 'Results', discussion: 'Discussion',
    conclusion: 'Conclusion', references: 'References',
  };

  const sectionChips = Object.entries(SECTION_LABELS).map(([key, label]) => {
    const present = !!sections[key];
    return `<span class="dpp-section-chip ${present ? 'dpp-chip-yes' : 'dpp-chip-no'}">${present ? '✓' : '✗'} ${label}</span>`;
  }).join('');

  const ocrNote = (dp.ocrPages || []).length > 0
    ? `<span class="dpp-ocr-badge">OCR applied to page${dp.ocrPages.length > 1 ? 's' : ''}: ${dp.ocrPages.join(', ')}</span>`
    : '';

  const qualityColor = { good: '#22c55e', partial: '#f59e0b', poor: '#ef4444' }[dp.textQuality] || '#22c55e';
  const engineLabel  = analysedBy === 'claude'
    ? `<span class="dpp-engine-badge">AI Engine</span>`
    : '<span class="dpp-engine-badge dpp-engine-heuristic">Heuristic Engine</span>';

  const conf    = dp.analysisConfidence || 0;
  const confPct = `${conf}%`;

  // Build per-page stats (collapsed by default, expandable)
  const pageRows = (dp.perPageStats || []).map((p) => {
    const flags = [
      p.scanned      ? '<span class="dpp-flag dpp-flag-scan">SCANNED</span>' : '',
      p.ocrProcessed ? '<span class="dpp-flag dpp-flag-ocr">OCR</span>'      : '',
    ].filter(Boolean).join(' ');
    return `<tr>
      <td>p.${p.page}</td>
      <td>${p.words.toLocaleString()}</td>
      <td>${p.chars.toLocaleString()}</td>
      <td>${flags || '—'}</td>
    </tr>`;
  }).join('');

  const hasPageStats = (dp.perPageStats || []).length > 0;

  return `<div class="doc-profile-panel" id="docProfilePanel">
    <div class="dpp-header">
      <span class="dpp-title">Document Verification</span>
      ${engineLabel}
      ${ocrNote}
    </div>

    <div class="dpp-stats-row">
      <div class="dpp-stat-block">
        <span class="dpp-stat-val">${dp.pageCount || doc?.pageCount || '—'}</span>
        <span class="dpp-stat-lbl">Pages Detected</span>
      </div>
      <div class="dpp-stat-block">
        <span class="dpp-stat-val">${(dp.wordCount || 0).toLocaleString()}</span>
        <span class="dpp-stat-lbl">Words Extracted</span>
      </div>
      <div class="dpp-stat-block">
        <span class="dpp-stat-val">${(dp.charCount || 0).toLocaleString()}</span>
        <span class="dpp-stat-lbl">Characters</span>
      </div>
      <div class="dpp-stat-block">
        <span class="dpp-stat-val" style="color:${qualityColor};text-transform:capitalize">${dp.textQuality || 'good'}</span>
        <span class="dpp-stat-lbl">Text Quality</span>
      </div>
    </div>

    <div class="dpp-confidence-row">
      <span class="dpp-conf-label">Analysis confidence:</span>
      <div class="dpp-conf-bar-wrap">
        <div class="dpp-conf-bar-track">
          <div class="dpp-conf-bar-fill" style="width:${confPct};background:${confBarColor(conf)}"></div>
        </div>
        <span class="dpp-conf-pct" style="color:${confBarColor(conf)}">${confPct}</span>
      </div>
    </div>

    <div class="dpp-sections-row">
      <span class="dpp-sections-label">Sections:</span>
      <div class="dpp-section-chips">${sectionChips}</div>
    </div>

    ${hasPageStats ? `
    <details class="dpp-details">
      <summary class="dpp-details-toggle">Per-page breakdown (${dp.perPageStats.length} pages)</summary>
      <div class="dpp-page-table-wrap">
        <table class="dpp-page-table">
          <thead><tr><th>Page</th><th>Words</th><th>Chars</th><th>Flags</th></tr></thead>
          <tbody>${pageRows}</tbody>
        </table>
      </div>
    </details>` : ''}
  </div>`;
}

function confBarColor(conf) {
  if (conf >= 80) return '#22c55e';
  if (conf >= 60) return '#3b82f6';
  if (conf >= 40) return '#f59e0b';
  return '#ef4444';
}

// ══ MODULE RENDERERS ══════════════════════════════════════════════════════════

function renderStructural(d) {
  animateCircle('structFill', d.score, 213.63, '#3b82f6');
  document.getElementById('structScore').textContent = d.score;
  setGrade('structGrade', d.grade, d.score);

  let html = '';
  if (d.summary) html += feedbackSummary(d.summary);
  html += sectionQualityGrid(d.sections || {});
  if (d.flowAnalysis) html += analysisBlock('Logical Flow & Coherence', d.flowAnalysis, 'block-teal');
  if (d.recommendations?.length) html += recList(d.recommendations);

  document.getElementById('structContent').innerHTML = html;
}

function renderCitation(d) {
  animateCircle('citeFill', d.score, 213.63, '#8b5cf6');
  document.getElementById('citeScore').textContent = d.score;
  setGrade('citeGrade', d.grade, d.score);

  let html = '';
  if (d.summary) html += feedbackSummary(d.summary);

  html += `<div class="stats-pill-row">
    <div class="stat-pill"><span class="sp-value">${d.inTextCount || 0}</span><span class="sp-label">In-text Citations</span></div>
    <div class="stat-pill"><span class="sp-value">${d.formatDetected || '—'}</span><span class="sp-label">Format Detected</span></div>
  </div>`;

  if (d.densityAssessment)  html += analysisBlock('Citation Density',      d.densityAssessment,  'block-purple');
  if (d.qualityAssessment)  html += analysisBlock('Source Quality',         d.qualityAssessment,  'block-purple');
  if (d.recencyAssessment)  html += analysisBlock('Literature Currency',    d.recencyAssessment,  'block-purple');

  if (d.issues?.length) {
    html += `<div class="issues-block">
      <h4 class="issues-heading">Issues Identified</h4>
      <ul class="issues-list">${d.issues.map((i) => `<li class="issue-item">${i}</li>`).join('')}</ul>
    </div>`;
  }

  if (d.recommendations?.length) html += recList(d.recommendations);
  document.getElementById('citeContent').innerHTML = html;
}

function renderArgument(d) {
  animateCircle('argFill', d.score, 213.63, '#14b8a6');
  document.getElementById('argScore').textContent = d.score;
  setGrade('argGrade', d.grade, d.score);

  let html = '';
  if (d.summary) html += feedbackSummary(d.summary);
  if (d.claimAnalysis)           html += analysisBlock('Thesis & Central Claims',     d.claimAnalysis,           'block-teal');
  if (d.evidenceAnalysis)        html += analysisBlock('Evidence Usage',              d.evidenceAnalysis,        'block-teal');
  if (d.logicAnalysis)           html += analysisBlock('Logical Coherence',           d.logicAnalysis,           'block-teal');
  if (d.counterArgumentAnalysis) html += analysisBlock('Counter-Argument Engagement', d.counterArgumentAnalysis, 'block-teal');

  if (d.weaknesses?.length) {
    html += `<div class="weaknesses-section">
      <h4 class="weaknesses-heading">Areas Requiring Attention</h4>
      <div class="weakness-cards">${d.weaknesses.map(weaknessCard).join('')}</div>
    </div>`;
  }

  if (d.recommendations?.length) html += recList(d.recommendations);
  document.getElementById('argContent').innerHTML = html;
}

function renderIntegrity(d) {
  animateCircle('integFill', d.score, 213.63, '#f97316');
  document.getElementById('integScore').textContent = d.score;
  setGrade('integGrade', d.grade, d.score);

  let html = '';
  if (d.summary) html += feedbackSummary(d.summary);

  const rlClass = { low: 'risk-low', moderate: 'risk-moderate', high: 'risk-high' }[d.riskLevel] || 'risk-low';
  const rlIcon  = { low: '✓', moderate: '!', high: '⚠' }[d.riskLevel] || '✓';
  const rlLabel = { low: 'Low Risk', moderate: 'Moderate Risk', high: 'High Risk' }[d.riskLevel] || 'Low Risk';
  html += `<div class="risk-level-banner ${rlClass}">
    <span class="rl-icon">${rlIcon}</span>
    <div><strong>${rlLabel}</strong><span class="rl-sub">Overall academic integrity assessment</span></div>
  </div>`;

  if (d.risks?.length) {
    html += `<div class="risks-section">
      <h4 class="risks-heading">Identified Concerns</h4>
      ${d.risks.map(riskCard).join('')}
    </div>`;
  }

  if (d.preventionAdvice) {
    html += `<div class="prevention-block">
      <h4 class="prevention-heading">Before Submission</h4>
      <p class="prevention-text">${d.preventionAdvice}</p>
    </div>`;
  }

  if (d.recommendations?.length) html += recList(d.recommendations);
  document.getElementById('integContent').innerHTML = html;
}

// ══ HTML COMPONENT BUILDERS ══════════════════════════════════════════════════

function feedbackSummary(text) {
  return `<div class="feedback-summary"><p>${text}</p></div>`;
}

function analysisBlock(heading, text, cls = '') {
  return `<div class="analysis-block ${cls}"><h4 class="ab-heading">${heading}</h4><p class="ab-text">${text}</p></div>`;
}

function sectionQualityGrid(sections) {
  const LABELS = {
    abstract:         { label: 'Abstract',         desc: 'Concise summary: question, method, findings, implications.' },
    introduction:     { label: 'Introduction',     desc: 'Context, research gap, and research question.' },
    literatureReview: { label: 'Literature Review',desc: 'Synthesis of existing scholarship and positioning.' },
    methodology:      { label: 'Methodology',      desc: 'Research design, data collection, and analysis approach.' },
    results:          { label: 'Results',          desc: 'Findings presented clearly, typically with data/figures.' },
    discussion:       { label: 'Discussion',       desc: 'Interpretation, comparison to prior work, limitations.' },
    conclusion:       { label: 'Conclusion',       desc: 'Contributions, limitations, and future directions.' },
    references:       { label: 'References',       desc: 'Complete, consistently formatted bibliography.' },
  };
  const QUALITY_META = {
    strong:   { badge: 'Strong',     cls: 'sq-strong'   },
    adequate: { badge: 'Adequate',   cls: 'sq-adequate'  },
    weak:     { badge: 'Needs Work', cls: 'sq-weak'     },
    missing:  { badge: 'Missing',    cls: 'sq-missing'  },
  };
  const cards = Object.entries(sections).map(([key, sec]) => {
    const meta = LABELS[key] || { label: key, desc: '' };
    const q    = QUALITY_META[sec.quality] || QUALITY_META.missing;
    return `<div class="section-q-card ${q.cls}">
      <div class="sq-header">
        <span class="sq-label">${meta.label}</span>
        <span class="sq-badge">${q.badge}</span>
      </div>
      <p class="sq-feedback">${sec.feedback}</p>
      <p class="sq-desc">${meta.desc}</p>
    </div>`;
  }).join('');
  return `<div class="section-quality-grid">${cards}</div>`;
}

function weaknessCard(w) {
  return `<div class="weakness-card">
    <div class="wc-header"><span class="wc-icon">⚠</span><strong class="wc-title">${w.title}</strong></div>
    <p class="wc-description">${w.description}</p>
    ${w.suggestion ? `<div class="wc-suggestion"><span class="wc-suggestion-label">How to Fix It</span><p>${w.suggestion}</p></div>` : ''}
  </div>`;
}

function riskCard(r) {
  const severityClass = { high: 'risk-severity-high', medium: 'risk-severity-medium', low: 'risk-severity-low' }[r.severity] || 'risk-severity-low';
  const severityLabel = { high: 'High', medium: 'Medium', low: 'Low' }[r.severity] || 'Low';
  return `<div class="risk-card ${severityClass}">
    <div class="rc-header">
      <strong class="rc-title">${r.title}</strong>
      <span class="rc-severity-badge sev-${r.severity || 'low'}">${severityLabel}</span>
    </div>
    ${r.description ? `<p class="rc-description">${r.description}</p>` : ''}
    ${r.resolution  ? `<div class="rc-resolution"><span class="rc-resolution-label">How to Resolve</span><p>${r.resolution}</p></div>` : ''}
  </div>`;
}

function recList(recs) {
  if (!recs?.length) return '';
  return `<div class="rec-section">
    <h4 class="rec-heading">Recommendations</h4>
    <ol class="rec-list">${recs.map((r) => `<li class="rec-item">${r}</li>`).join('')}</ol>
  </div>`;
}

function strengthsImprovementsGrid(strengths, improvements) {
  const strItems = strengths.map((s) => `<li>${s}</li>`).join('');
  const impItems = improvements.map((i) => `<li>${i}</li>`).join('');
  let html = '<div class="si-grid">';
  if (strItems) html += `<div class="si-box si-strengths"><h5>Key Strengths</h5><ul>${strItems}</ul></div>`;
  if (impItems) html += `<div class="si-box si-improvements"><h5>Priority Improvements</h5><ul>${impItems}</ul></div>`;
  html += '</div>';
  return html;
}

// ══ UTILITIES ════════════════════════════════════════════════════════════════

function setGrade(id, grade, score) {
  const e = document.getElementById(id);
  if (!e) return;
  e.textContent = `Grade ${grade}`;
  const c = scoreColor(score);
  e.style.cssText = `background:${c}22;color:${c};border:1px solid ${c}44`;
}

function scoreColor(s) {
  if (s >= 80) return '#22c55e';
  if (s >= 65) return '#3b82f6';
  if (s >= 50) return '#f59e0b';
  return '#ef4444';
}

function animateCircle(id, score, circumference, color) {
  const circle = document.getElementById(id);
  if (!circle) return;
  circle.style.stroke = color;
  const offset = circumference - (score / 100) * circumference;
  setTimeout(() => { circle.style.strokeDashoffset = offset; }, 50);
}

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(2) + ' MB';
}

function show(e) { if (e) e.classList.remove('hidden'); }
function hide(e) { if (e) e.classList.add('hidden'); }

function showState(s) {
  [resultsEmpty, resultsProcessing, resultsContent].forEach(hide);
  if (s === 'empty')      show(resultsEmpty);
  if (s === 'processing') show(resultsProcessing);
  if (s === 'results')    show(resultsContent);
}

function showError(msg) { errorText.textContent = msg; show(uploadError); }
function clearError()   { hide(uploadError); }

function resetUpload() {
  selectedFile = null;
  fileInput.value = '';
  hide(fileInfoCard);
  hide(uploadProgress);
  clearError();
  analyzeBtn.disabled = true;
  showState('empty');
  setProgress(0, '');
  ['overall-narrative', 'doc-profile-panel'].forEach((cls) => {
    const el = document.querySelector('.' + cls);
    if (el) el.remove();
  });
}
