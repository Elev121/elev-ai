/**
 * ELEV — research.js
 * Handles: tab switching, novelty check form, idea generation form,
 *          results rendering, idea ↔ novelty cross-linking.
 */

'use strict';

// ── Navbar (minimal, since main.js isn't loaded here) ─────────────────────────
(function initNavbar() {
  const navbar   = document.getElementById('navbar');
  const toggle   = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');
  if (!navbar || !toggle || !navLinks) return;

  window.addEventListener('scroll', () => {
    navbar.classList.toggle('scrolled', window.scrollY > 20);
  }, { passive: true });

  toggle.addEventListener('click', () => {
    navLinks.classList.toggle('open');
    toggle.setAttribute('aria-expanded', navLinks.classList.contains('open'));
  });
  navLinks.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') navLinks.classList.remove('open');
  });
})();

// ── Tab switching ─────────────────────────────────────────────────────────────
(function initTabs() {
  const tabs   = document.querySelectorAll('.rp-tab');
  const panels = { novelty: document.getElementById('panelNovelty'), generate: document.getElementById('panelGenerate') };

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      Object.values(panels).forEach((p) => p && p.classList.add('hidden'));
      tab.classList.add('active');
      const key = tab.dataset.tab;
      if (panels[key]) panels[key].classList.remove('hidden');
    });
  });
})();

// ── Shared helpers ─────────────────────────────────────────────────────────────
function setLoading(btn, loading, label) {
  const text    = btn.querySelector('.btn-text');
  const spinner = btn.querySelector('.btn-spinner');
  btn.disabled = loading;
  if (text) {
    text.classList.toggle('hidden', loading);
    if (!loading && label) text.textContent = label;
  }
  if (spinner) spinner.classList.toggle('hidden', !loading);
}

function showError(boxId, message) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const span = box.querySelector('span');
  if (span) span.textContent = message;
  box.classList.remove('hidden');
}

function hideError(boxId) {
  const box = document.getElementById(boxId);
  if (box) box.classList.add('hidden');
}

// Fetch with timeout — surfaces clear errors for Railway cold-starts and network issues.
async function apiFetch(path, options = {}, timeoutMs = 50000) {
  const base = (typeof API_BASE !== 'undefined') ? API_BASE : '/api';
  const url  = path.startsWith('http') ? path : `${base}/${path.replace(/^\/+/, '')}`;

  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(tid);
    return res;
  } catch (err) {
    clearTimeout(tid);
    if (err.name === 'AbortError') {
      throw new Error(
        'Request timed out (>50 s). The backend may be cold-starting on Railway — please try again in a few seconds.'
      );
    }
    // Diagnose network errors
    if (window.location.protocol === 'file:') {
      throw new Error(
        'You opened this page via file://. Use a local server instead:\n' +
        '  VS Code → Live Server, or: cd frontend && npx serve .'
      );
    }
    throw new Error(`Network error: ${err.message}. Is the backend running?`);
  }
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Novelty Check form ─────────────────────────────────────────────────────────
(function initNoveltyForm() {
  const form = document.getElementById('noveltyForm');
  const btn  = document.getElementById('noveltyBtn');
  if (!form || !btn) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const problem = document.getElementById('nProblem').value.trim();
    const errEl   = document.getElementById('nProblemError');
    if (!problem) { errEl.textContent = 'Problem statement is required.'; return; }
    errEl.textContent = '';

    setLoading(btn, true);
    hideError('noveltyError');
    document.getElementById('noveltyPlaceholder').classList.add('hidden');
    document.getElementById('noveltyResult').classList.add('hidden');

    const body = clean({
      title:       document.getElementById('nTitle').value.trim(),
      problem,
      field:       document.getElementById('nField').value.trim(),
      country:     document.getElementById('nCountry').value.trim(),
      keywords:    document.getElementById('nKeywords').value.trim(),
      methodology: document.getElementById('nMethodology').value.trim(),
    });

    try {
      const res  = await apiFetch('/novelty-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || `Server error ${res.status}`);
      renderNoveltyResult(data);
    } catch (err) {
      showError('noveltyError', err.message);
      document.getElementById('noveltyPlaceholder').classList.remove('hidden');
    } finally {
      setLoading(btn, false, 'Check Novelty');
    }
  });
})();

function renderNoveltyResult(data) {
  // Badge
  const badge = document.getElementById('noveltyBadge');
  badge.textContent = data.noveltyScore || 'Unknown';
  badge.className   = 'novelty-badge';
  const score = (data.noveltyScore || '').toLowerCase();
  if (score.includes('highly'))       badge.classList.add('badge-high');
  else if (score.includes('moderate')) badge.classList.add('badge-moderate');
  else                                 badge.classList.add('badge-common');

  // Meter
  const pct = Math.min(100, Math.max(0, data.noveltyPercentage || 0));
  document.getElementById('noveltyPct').textContent = `${pct}%`;
  const fill = document.getElementById('noveltyMeterFill');
  fill.style.width = '0';
  // Meter color follows score
  if (score.includes('highly'))       fill.style.background = 'linear-gradient(90deg,#14b8a6,#22c55e)';
  else if (score.includes('moderate')) fill.style.background = 'linear-gradient(90deg,#3b82f6,#8b5cf6)';
  else                                 fill.style.background = 'linear-gradient(90deg,#f97316,#ef4444)';
  setTimeout(() => { fill.style.width = `${pct}%`; }, 80);

  document.getElementById('noveltyVerdict').textContent = data.verdict || '';

  // Lists
  const $  = (id) => document.getElementById(id);
  const li = (txt) => `<li>${escHtml(txt)}</li>`;
  $('noveltyStrengths').innerHTML = (data.strengths         || []).map(li).join('');
  $('noveltyConcerns').innerHTML  = (data.concerns          || []).map(li).join('');
  $('noveltyTips').innerHTML      = (data.differentiationTips || []).map(li).join('');

  // Papers
  const papers     = data.papers        || [];
  const simPapers  = data.similarPapers || [];
  const papersDiv  = $('noveltyPapersSection');
  const papersList = $('noveltyPapersList');

  if (papers.length) {
    papersList.innerHTML = papers.map((p, i) => {
      const sim = simPapers.find((s) => s.ref === i + 1);
      return `
        <div class="paper-item">
          <div class="paper-title">${escHtml(p.title)}</div>
          <div class="paper-meta">
            <span>${p.year || 'n/a'}</span>
            <span>${p.source || ''}</span>
            <span>${p.citations || 0} citations</span>
            ${p.doi ? `<span>DOI: ${escHtml(p.doi)}</span>` : ''}
          </div>
          ${sim ? `<div class="paper-overlap">${escHtml(sim.overlap)}</div>` : ''}
        </div>`;
    }).join('');
    papersDiv.classList.remove('hidden');
  } else {
    papersDiv.classList.add('hidden');
  }

  $('noveltyResult').classList.remove('hidden');
  $('noveltyResult').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Generate Ideas form ────────────────────────────────────────────────────────
(function initGenerateForm() {
  const form = document.getElementById('generateForm');
  const btn  = document.getElementById('generateBtn');
  if (!form || !btn) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const field  = document.getElementById('gField').value.trim();
    const errEl  = document.getElementById('gFieldError');
    if (!field) { errEl.textContent = 'Research field is required.'; return; }
    errEl.textContent = '';

    setLoading(btn, true);
    hideError('generateError');
    document.getElementById('generatePlaceholder').classList.add('hidden');
    document.getElementById('generateResult').classList.add('hidden');

    const body = clean({
      field,
      interests:   document.getElementById('gInterests').value.trim(),
      country:     document.getElementById('gCountry').value.trim(),
      difficulty:  document.getElementById('gDifficulty').value,
      methodology: document.getElementById('gMethodology').value.trim(),
      count:       parseInt(document.getElementById('gCount').value, 10) || 5,
    });

    try {
      const res  = await apiFetch('/generate-problems', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || `Server error ${res.status}`);
      renderIdeas(data.ideas || []);
    } catch (err) {
      showError('generateError', err.message);
      document.getElementById('generatePlaceholder').classList.remove('hidden');
    } finally {
      setLoading(btn, false, 'Generate Research Ideas');
    }
  });
})();

// Expose globals used by onclick handlers
window._ideaData = [];

function renderIdeas(ideas) {
  if (!ideas.length) {
    showError('generateError', 'No ideas returned. Please try again.');
    document.getElementById('generatePlaceholder').classList.remove('hidden');
    return;
  }

  window._ideaData = ideas;

  const countEl = document.getElementById('ideasCount');
  if (countEl) countEl.textContent = `${ideas.length} Novel Research Idea${ideas.length !== 1 ? 's' : ''}`;

  const list = document.getElementById('ideasList');
  list.innerHTML = ideas.map((idea, i) => {
    const nvClass = (idea.noveltyPotential || 'Medium').toLowerCase() === 'high'
      ? 'novelty-high' : 'novelty-medium';
    const kws = (idea.keywords || []).map((k) => `<span class="idea-kw-tag">${escHtml(k)}</span>`).join('');

    return `
      <div class="idea-card" id="idea-${i}">
        <div class="idea-card-header" onclick="toggleIdea(${i})">
          <span class="idea-number">${String(i + 1).padStart(2, '0')}</span>
          <div class="idea-header-content">
            <div class="idea-title">${escHtml(idea.title || 'Research Idea')}</div>
            <div class="idea-gap">${escHtml(idea.researchGap || '')}</div>
          </div>
          <span class="idea-novelty-pill ${nvClass}">${escHtml(idea.noveltyPotential || 'Medium')} Novelty</span>
          <div class="idea-toggle">
            <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
              <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/>
            </svg>
          </div>
        </div>
        <div class="idea-card-body">
          <div class="idea-body-grid">
            <div class="idea-section">
              <h5>Problem Statement</h5>
              <p>${escHtml(idea.problem || '')}</p>
            </div>
            <div class="idea-section">
              <h5>Why It Matters</h5>
              <p>${escHtml(idea.whyItMatters || '')}</p>
            </div>
            <div class="idea-section">
              <h5>Suggested Methodology</h5>
              <p>${escHtml(idea.methodology || '')}</p>
            </div>
            <div class="idea-section">
              <h5>Novelty Reason</h5>
              <p>${escHtml(idea.noveltyReason || '')}</p>
            </div>
            <div class="idea-keywords">${kws}</div>
            <div class="idea-actions">
              <button class="idea-btn-check" onclick="checkIdeaNovelty(${i})">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                  <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
                </svg>
                Check Novelty
              </button>
            </div>
          </div>
        </div>
      </div>`;
  }).join('');

  document.getElementById('generateResult').classList.remove('hidden');
  document.getElementById('generateResult').scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Auto-open first card
  setTimeout(() => toggleIdea(0), 100);
}

window.toggleIdea = function (index) {
  const card = document.getElementById(`idea-${index}`);
  if (card) card.classList.toggle('open');
};

window.checkIdeaNovelty = function (index) {
  const idea = window._ideaData[index];
  if (!idea) return;

  // Switch to novelty tab
  const tabNovelty = document.getElementById('tabNovelty');
  if (tabNovelty) tabNovelty.click();

  // Pre-fill the novelty form
  const titleEl    = document.getElementById('nTitle');
  const problemEl  = document.getElementById('nProblem');
  const keywordsEl = document.getElementById('nKeywords');
  if (titleEl)    titleEl.value    = idea.title    || '';
  if (problemEl)  problemEl.value  = idea.problem  || '';
  if (keywordsEl) keywordsEl.value = (idea.keywords || []).join(', ');

  document.querySelector('.rp-tabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// Strip empty/undefined keys from request body
function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v !== undefined && v !== null));
}
