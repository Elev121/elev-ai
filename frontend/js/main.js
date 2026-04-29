/**
 * ELEV Frontend — main.js
 * Handles: navbar, scroll animations, counters, charts,
 *          validate demo form, feedback form, pricing toggle.
 */

'use strict';

// ── Config (API_BASE is defined in config.js, loaded before this file) ──────

// ── Utility ─────────────────────────────────────────────────────────────────
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

// ── Navbar ───────────────────────────────────────────────────────────────────
(function initNavbar() {
  const navbar   = $('#navbar');
  const toggle   = $('#navToggle');
  const navLinks = $('#navLinks');

  // Scroll: add shadow class
  window.addEventListener('scroll', () => {
    navbar.classList.toggle('scrolled', window.scrollY > 20);
    updateActiveLink();
  }, { passive: true });

  // Mobile toggle
  toggle.addEventListener('click', () => {
    navLinks.classList.toggle('open');
    const isOpen = navLinks.classList.contains('open');
    toggle.setAttribute('aria-expanded', isOpen);
  });

  // Close on link click
  navLinks.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') navLinks.classList.remove('open');
  });

  // Active link on scroll
  function updateActiveLink() {
    const sections = $$('section[id]');
    const scrollY = window.scrollY + 120;
    let current = '';
    sections.forEach((s) => {
      if (scrollY >= s.offsetTop) current = s.id;
    });
    $$('.nav-links a').forEach((a) => {
      a.classList.toggle('active', a.getAttribute('href') === `#${current}`);
    });
  }
})();

// ── Back to Top ──────────────────────────────────────────────────────────────
(function initBackToTop() {
  const btn = $('#backToTop');
  window.addEventListener('scroll', () => {
    btn.classList.toggle('hidden', window.scrollY < 400);
  }, { passive: true });
  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
})();

// ── Reveal on Scroll ─────────────────────────────────────────────────────────
(function initReveal() {
  const observer = new IntersectionObserver(
    (entries) => entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add('visible');
        observer.unobserve(e.target);
      }
    }),
    { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
  );
  $$('.reveal').forEach((el) => observer.observe(el));
})();

// ── Counter Animation ────────────────────────────────────────────────────────
(function initCounters() {
  const counters = $$('[data-target]');
  if (!counters.length) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const el     = e.target;
        const target = parseInt(el.dataset.target, 10);
        const duration = 1800;
        const step   = Math.ceil(target / (duration / 16));
        let current  = 0;

        const timer = setInterval(() => {
          current = Math.min(current + step, target);
          el.textContent = current.toLocaleString();
          if (current >= target) clearInterval(timer);
        }, 16);

        observer.unobserve(el);
      });
    },
    { threshold: 0.5 }
  );
  counters.forEach((c) => observer.observe(c));
})();

// ── Pricing Toggle ───────────────────────────────────────────────────────────
(function initPricing() {
  const toggle = $('#billingToggle');
  if (!toggle) return;

  toggle.addEventListener('change', () => {
    const annual = toggle.checked;
    $$('[data-monthly]').forEach((el) => {
      el.textContent = annual ? el.dataset.annual : el.dataset.monthly;
    });
    $('#toggleMonthly').classList.toggle('active', !annual);
    $('#toggleAnnual').classList.toggle('active',  annual);
  });
})();

// ── Validate Demo Form ───────────────────────────────────────────────────────
(function initValidateForm() {
  const form        = $('#validateForm');
  const btn         = $('#validateBtn');
  const btnText     = btn.querySelector('.btn-text');
  const btnSpinner  = btn.querySelector('.btn-spinner');
  const resultsPanel= $('#resultsPanel');
  const abstract    = $('#paperAbstract');
  const wordCountEl = $('#wordCount');

  // Live word count
  abstract.addEventListener('input', () => {
    const words = abstract.value.trim().split(/\s+/).filter(Boolean).length;
    wordCountEl.textContent = words;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validateDemoForm()) return;

    setLoading(btn, btnText, btnSpinner, true);
    clearDemoErrors();

    const body = {
      title:      $('#paperTitle').value.trim(),
      abstract:   abstract.value.trim(),
      keywords:   $('#paperKeywords').value.trim(),
      discipline: $('#paperDiscipline').value,
    };

    try {
      let data;
      try {
        const res = await fetch(`${API_BASE}/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Validation failed');
      } catch (fetchErr) {
        // Backend not running — use client-side demo
        console.warn('[ELEV] Backend unavailable, running client-side demo:', fetchErr.message);
        data = clientSideValidate(body);
      }

      renderResults(data);
      show(resultsPanel);
      resultsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      alert('Validation error: ' + err.message);
    } finally {
      setLoading(btn, btnText, btnSpinner, false);
    }
  });

  function validateDemoForm() {
    let valid = true;
    const title    = $('#paperTitle').value.trim();
    const abstract = $('#paperAbstract').value.trim();
    if (!title) {
      showFieldError('titleError', 'Paper title is required.', 'paperTitle');
      valid = false;
    }
    if (!abstract || abstract.split(/\s+/).filter(Boolean).length < 10) {
      showFieldError('abstractError', 'Abstract must be at least 10 words.', 'paperAbstract');
      valid = false;
    }
    return valid;
  }

  function clearDemoErrors() {
    ['titleError', 'abstractError'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = '';
    });
    ['paperTitle', 'paperAbstract'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('error');
    });
  }
})();

// ── Client-side fallback validator ───────────────────────────────────────────
function clientSideValidate({ title, abstract, keywords }) {
  const words = abstract.split(/\s+/).filter(Boolean).length;
  const hasMethod = /method|approach|algorithm|model|framework|experiment/i.test(abstract);
  const hasResult = /result|finding|show|demonstrate|achieve|improve/i.test(abstract);
  const hasContrib = /contribut|novel|propos|new|introduc/i.test(abstract);

  const rand = (a, b) => Math.round(a + Math.random() * (b - a));

  const semanticCoherence  = words < 50 ? rand(32,55) : words < 100 ? rand(55,72) : rand(72,95);
  const citationQuality    = rand(60, 92);
  const methodologyRigor   = hasMethod ? rand(70,95) : rand(40,65);
  const originalityIndex   = hasContrib ? rand(68,93) : rand(48,72);
  const resultsClarity     = hasResult  ? rand(72,94) : rand(45,68);

  const elevScore = Math.round(
    semanticCoherence * .20 + citationQuality * .20 +
    methodologyRigor * .25  + originalityIndex * .20 + resultsClarity * .15
  );

  const grade = elevScore >= 85 ? 'A' : elevScore >= 75 ? 'B' : elevScore >= 65 ? 'C' : elevScore >= 50 ? 'D' : 'F';

  const recommendations = [];
  if (semanticCoherence < 65) recommendations.push('Improve abstract clarity and logical flow.');
  if (citationQuality   < 70) recommendations.push('Strengthen citation foundation with peer-reviewed sources.');
  if (!hasMethod)              recommendations.push('Explicitly state the research methodology used.');
  if (!hasContrib)             recommendations.push('Clarify the novel contribution of the research.');
  if (!hasResult)              recommendations.push('Include a concise summary of key results or findings.');
  if (words < 100)             recommendations.push('Consider expanding the abstract to 150–250 words.');
  if (!recommendations.length) recommendations.push('Abstract meets ELEV quality standards. Proceed to full validation.');

  const flags = [];
  if (words < 50)            flags.push({ level: 'warning', message: 'Abstract is very short.' });
  if (methodologyRigor < 55) flags.push({ level: 'warning', message: 'Methodology section appears weak.' });
  if (elevScore < 50)        flags.push({ level: 'critical', message: 'Overall quality below acceptance threshold.' });

  return { success: true, elevScore, grade, dimensions: { semanticCoherence, citationQuality, methodologyRigor, originalityIndex, resultsClarity }, recommendations, flags };
}

// ── Render validation results ─────────────────────────────────────────────────
function renderResults(data) {
  const { elevScore, grade, dimensions, recommendations, flags } = data;

  // Score circle
  const scoreValue = document.getElementById('scoreValue');
  const scoreFill  = document.getElementById('scoreFill');
  const scoreGrade = document.getElementById('scoreGrade');

  scoreValue.textContent = elevScore;
  scoreGrade.textContent = `Grade: ${grade}`;

  // Color fill based on score
  const color = elevScore >= 75 ? '#22c55e' : elevScore >= 55 ? '#3b82f6' : '#ef4444';
  scoreFill.style.stroke = color;
  const circumference = 326.73;
  const offset = circumference - (elevScore / 100) * circumference;
  setTimeout(() => { scoreFill.style.strokeDashoffset = offset; }, 100);

  // Grade badge color
  const gradeEl = document.getElementById('scoreGrade');
  gradeEl.style.background = `${color}22`;
  gradeEl.style.color = color;

  // Dimensions
  const dimNames = {
    semanticCoherence: 'Semantic Coherence',
    citationQuality:   'Citation Quality',
    methodologyRigor:  'Methodology Rigor',
    originalityIndex:  'Originality Index',
    resultsClarity:    'Results Clarity',
  };
  const dimColors = {
    semanticCoherence: '#3b82f6',
    citationQuality:   '#8b5cf6',
    methodologyRigor:  '#14b8a6',
    originalityIndex:  '#f97316',
    resultsClarity:    '#22c55e',
  };

  const dimList = document.getElementById('dimensionsList');
  dimList.innerHTML = '';
  Object.entries(dimensions).forEach(([key, value]) => {
    const item = document.createElement('div');
    item.className = 'dim-item';
    item.innerHTML = `
      <div class="dim-label">
        <span class="dim-name">${dimNames[key] || key}</span>
        <span class="dim-score">${value}%</span>
      </div>
      <div class="dim-bar">
        <div class="dim-fill" style="background: ${dimColors[key] || '#3b82f6'}"></div>
      </div>`;
    dimList.appendChild(item);
    // Animate bar
    setTimeout(() => {
      item.querySelector('.dim-fill').style.width = `${value}%`;
    }, 150);
  });

  // Recommendations
  const recList = document.getElementById('recommendationsList');
  recList.innerHTML = recommendations.map((r) => `<li>${r}</li>`).join('');

  // Flags
  const flagsBox  = document.getElementById('flagsBox');
  const flagsList = document.getElementById('flagsList');
  if (flags && flags.length > 0) {
    flagsList.innerHTML = flags.map(
      (f) => `<li class="flag-item flag-${f.level}">${f.message}</li>`
    ).join('');
    show(flagsBox);
  } else {
    hide(flagsBox);
  }
}

// ── Feedback Form ─────────────────────────────────────────────────────────────
(function initFeedbackForm() {
  const form       = $('#feedbackForm');
  const btn        = $('#feedbackBtn');
  const btnText    = btn.querySelector('.btn-text');
  const btnSpinner = btn.querySelector('.btn-spinner');
  const successDiv = $('#feedbackSuccess');
  let selectedRating = 0;

  // Star rating
  const stars = $$('.star', document.getElementById('starRating'));
  stars.forEach((star) => {
    star.addEventListener('mouseenter', () => highlightStars(+star.dataset.value));
    star.addEventListener('mouseleave', () => highlightStars(selectedRating));
    star.addEventListener('click', () => {
      selectedRating = +star.dataset.value;
      document.getElementById('fbRating').value = selectedRating;
      highlightStars(selectedRating);
    });
  });

  function highlightStars(count) {
    stars.forEach((s) => s.classList.toggle('active', +s.dataset.value <= count));
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validateFeedbackForm()) return;

    setLoading(btn, btnText, btnSpinner, true);

    const body = {
      name:        $('#fbName').value.trim(),
      email:       $('#fbEmail').value.trim(),
      institution: $('#fbInstitution').value.trim(),
      useCase:     $('#fbUseCase').value,
      rating:      selectedRating,
      feedback:    $('#fbMessage').value.trim(),
    };

    try {
      let success = false;
      try {
        const res = await fetch(`${API_BASE}/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        success = data.success;
      } catch {
        // Backend unavailable — treat as success in demo
        success = true;
      }

      if (success) {
        hide(form);
        show(successDiv);
      } else {
        alert('Failed to submit feedback. Please try again.');
      }
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      setLoading(btn, btnText, btnSpinner, false);
    }
  });

  function validateFeedbackForm() {
    let valid = true;
    clearFeedbackErrors();

    if (!$('#fbName').value.trim()) {
      showFieldError('fbNameError', 'Name is required.', 'fbName'); valid = false;
    }
    const email = $('#fbEmail').value.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showFieldError('fbEmailError', 'Valid email is required.', 'fbEmail'); valid = false;
    }
    if (!selectedRating) {
      showFieldError('fbRatingError', 'Please select a rating.'); valid = false;
    }
    if (!$('#fbMessage').value.trim()) {
      showFieldError('fbMessageError', 'Feedback message is required.', 'fbMessage'); valid = false;
    }
    return valid;
  }

  function clearFeedbackErrors() {
    ['fbNameError','fbEmailError','fbRatingError','fbMessageError'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = '';
    });
    ['fbName','fbEmail','fbMessage'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('error');
    });
  }
})();

// ── Shared helpers ────────────────────────────────────────────────────────────
function setLoading(btn, textEl, spinnerEl, loading) {
  btn.disabled = loading;
  if (loading) { hide(textEl); show(spinnerEl); }
  else         { show(textEl); hide(spinnerEl); }
}

function showFieldError(errorId, message, inputId) {
  const errEl = document.getElementById(errorId);
  if (errEl) errEl.textContent = message;
  if (inputId) {
    const inp = document.getElementById(inputId);
    if (inp) inp.classList.add('error');
  }
}
