/**
 * Academic Search — wraps Semantic Scholar and OpenAlex APIs.
 * Both are free with no API key required.
 */

'use strict';

const SS_API = 'https://api.semanticscholar.org/graph/v1';
const OA_API = 'https://api.openalex.org';
const TIMEOUT_MS = 12000;

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

async function searchAcademic(query, limit = 10) {
  const half = Math.ceil(limit / 2);
  const [ss, oa] = await Promise.all([
    searchSemanticScholar(query, half),
    searchOpenAlex(query, half),
  ]);

  const seen = new Set(ss.map((p) => normalizeTitle(p.title)));
  const combined = [...ss];
  for (const p of oa) {
    const norm = normalizeTitle(p.title);
    if (!seen.has(norm)) { combined.push(p); seen.add(norm); }
  }

  return combined
    .filter((p) => p.title)
    .sort((a, b) => (b.citations || 0) - (a.citations || 0))
    .slice(0, limit);
}

module.exports = { searchAcademic, searchSemanticScholar, searchOpenAlex };
