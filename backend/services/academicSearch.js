/**
 * Academic Search — wraps Semantic Scholar and OpenAlex APIs.
 * Both are free with no API key required.
 *
 * searchAcademic() guarantees at least MIN_RESULTS papers by running up to
 * three progressive rounds:
 *   Round 1 — full query (both APIs in parallel)
 *   Round 2 — up to 2 simplified sub-queries (all 4 fetches in parallel)
 *   Round 3 — single most-general term (both APIs in parallel)
 *
 * Returns { papers: Paper[], broadened: boolean }
 */

'use strict';

const SS_API     = 'https://api.semanticscholar.org/graph/v1';
const OA_API     = 'https://api.openalex.org';
const TIMEOUT_MS = 12000;
const MIN_RESULTS = 5;

async function fetchJSON(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ELEV-Research-Platform/2.0', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.slice(0, 60)}`);
  return res.json();
}

async function searchSemanticScholar(query, limit = 10) {
  const fields = 'title,abstract,year,authors,citationCount,externalIds,publicationTypes';
  const url = `${SS_API}/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=${fields}`;
  try {
    const data = await fetchJSON(url);
    return (data.data || []).map((p) => ({
      title:     p.title || '',
      abstract:  p.abstract || '',
      year:      p.year || null,
      authors:   (p.authors || []).slice(0, 3).map((a) => a.name).join(', '),
      citations: p.citationCount || 0,
      source:    'Semantic Scholar',
      doi:       p.externalIds?.DOI || null,
    }));
  } catch (err) {
    console.warn(`[academicSearch] Semantic Scholar: ${err.message}`);
    return [];
  }
}

async function searchOpenAlex(query, limit = 10) {
  const email  = 'research@elev.ai';
  const select = 'title,abstract_inverted_index,publication_year,authorships,cited_by_count,doi';
  const url    = `${OA_API}/works?search=${encodeURIComponent(query)}&per-page=${limit}&select=${select}&mailto=${email}`;
  try {
    const data = await fetchJSON(url);
    return (data.results || []).map((p) => ({
      title:     p.title || '',
      abstract:  reconstructAbstract(p.abstract_inverted_index),
      year:      p.publication_year || null,
      authors:   (p.authorships || []).slice(0, 3)
                   .map((a) => a.author?.display_name || '').filter(Boolean).join(', '),
      citations: p.cited_by_count || 0,
      source:    'OpenAlex',
      doi:       p.doi ? p.doi.replace('https://doi.org/', '') : null,
    }));
  } catch (err) {
    console.warn(`[academicSearch] OpenAlex: ${err.message}`);
    return [];
  }
}

function reconstructAbstract(invertedIndex) {
  if (!invertedIndex) return '';
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) words[pos] = word;
  }
  return words.filter(Boolean).join(' ');
}

function normalizeTitle(t) {
  return (t || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim().slice(0, 70);
}

/**
 * Produces up to 3 progressively broader fallback queries from the original.
 * Filters short stop-like words (≤ 3 chars) to keep queries meaningful.
 */
function buildFallbackQueries(query) {
  const words = query.trim().split(/\s+/).filter((w) => w.length > 2);
  const seen  = new Set([query.toLowerCase()]);
  const result = [];

  const tryAdd = (q) => {
    const norm = q.trim().toLowerCase();
    if (norm.length > 4 && !seen.has(norm)) { seen.add(norm); result.push(q.trim()); }
  };

  // Progressively shorter prefixes
  if (words.length > 6) tryAdd(words.slice(0, 6).join(' '));
  if (words.length > 4) tryAdd(words.slice(0, 4).join(' '));
  if (words.length > 2) tryAdd(words.slice(0, 3).join(' '));

  // Last 2 words — often the research field
  if (words.length > 2) tryAdd(words.slice(-2).join(' '));

  return result;
}

/**
 * Main entry point.
 * @returns {{ papers: object[], broadened: boolean }}
 */
async function searchAcademic(query, limit = 10) {
  const seen     = new Set();
  const combined = [];

  function merge(papers) {
    for (const p of papers) {
      if (!p.title) continue;
      const norm = normalizeTitle(p.title);
      if (!seen.has(norm)) { combined.push(p); seen.add(norm); }
    }
  }

  // ── Round 1: full query, both APIs in parallel ────────────────────────────
  const fetchSize = Math.max(limit, MIN_RESULTS + 3);
  const [ss1, oa1] = await Promise.all([
    searchSemanticScholar(query, fetchSize),
    searchOpenAlex(query, fetchSize),
  ]);
  merge(ss1);
  merge(oa1);

  let broadened = false;

  // ── Round 2: simplified sub-queries (all in parallel) ────────────────────
  if (combined.length < MIN_RESULTS) {
    broadened = true;
    const fallbacks = buildFallbackQueries(query).slice(0, 2);
    if (fallbacks.length) {
      const fetches = fallbacks.flatMap((q) => [
        searchSemanticScholar(q, 6),
        searchOpenAlex(q, 6),
      ]);
      const r2 = await Promise.all(fetches);
      r2.forEach(merge);
    }
  }

  // ── Round 3: single most-general term ────────────────────────────────────
  if (combined.length < MIN_RESULTS) {
    const significant = query.trim().split(/\s+/).filter((w) => w.length > 3);
    // Prefer the last word (tends to be the field/domain)
    const generalQ = significant[significant.length - 1] || significant[0];
    if (generalQ && generalQ.toLowerCase() !== query.toLowerCase()) {
      const [ss3, oa3] = await Promise.all([
        searchSemanticScholar(generalQ, 8),
        searchOpenAlex(generalQ, 8),
      ]);
      merge(ss3);
      merge(oa3);
    }
  }

  const papers = combined
    .filter((p) => p.title)
    .sort((a, b) => (b.citations || 0) - (a.citations || 0))
    .slice(0, limit);

  if (broadened) {
    console.log(`[academicSearch] Broadened search for "${query.slice(0, 60)}…" — found ${papers.length} papers`);
  }

  return { papers, broadened };
}

module.exports = { searchAcademic, searchSemanticScholar, searchOpenAlex };
