/**
 * services/vectorStore.js
 *
 * Qdrant-backed vector store for the ELEV semantic citation-discovery pipeline.
 *
 * ── Embedding strategy ────────────────────────────────────────────────────────
 * Uses a 384-dimensional "hashing-trick" embedding:
 *   • Tokenise to lowercase alphanumeric tokens (stopwords removed)
 *   • Unigrams are hashed into 3 buckets each; bigrams into 2 buckets each
 *     with lower weight — gives the vector n-gram context sensitivity
 *   • L2-normalised → cosine similarity is well-behaved
 *
 * This runs locally with zero extra API calls.  Cosine similarity between
 * two such vectors approximates Jaccard coefficient of their bag-of-words
 * representations, which is reliable enough for same-document chunk retrieval.
 *
 * When VOYAGE_API_KEY is later added, swap embed() for Voyage's
 * voyage-3-lite model (1024-dim) and recreate the collection.
 *
 * ── Chunking strategy ─────────────────────────────────────────────────────────
 * Sentence-aware sliding window: up to CHUNK_WORDS words per chunk,
 * OVERLAP_WORDS of overlap to preserve cross-boundary context.
 * Each detected section is chunked independently to preserve section labels.
 * If section detection was sparse, the full cleaned text is chunked as well.
 *
 * ── Retrieval ─────────────────────────────────────────────────────────────────
 * retrieveForAnalysis() runs 5 targeted semantic queries and deduplicates
 * results by content hash.  Returns up to MAX_RETRIEVED unique chunks.
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const { getQdrant, COLLECTION, VECTOR_SIZE } = require('../config/qdrant');

// ── Tuning constants ──────────────────────────────────────────────────────────
const CHUNK_WORDS    = 400;   // target words per chunk
const OVERLAP_WORDS  = 60;    // overlap between consecutive chunks
const UPSERT_BATCH   = 100;   // max points per Qdrant upsert call
const MAX_RETRIEVED  = 8;     // max unique chunks surfaced to Claude
const SCORE_THRESHOLD = 0.10; // minimum cosine similarity to include
const MAX_STORED_CHARS = 2000; // max chars stored in payload (cost control)

// ── Stopword list ─────────────────────────────────────────────────────────────
const STOPWORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with',
  'by','from','is','are','was','were','be','been','being','have','has',
  'had','do','does','did','will','would','could','should','may','might',
  'shall','can','this','that','these','those','it','its','we','our',
  'they','their','i','my','me','you','your','he','she','him','her',
  'as','if','so','not','no','nor','yet','both','either','each','all',
  'any','few','more','most','other','some','such','than','then','there',
  'when','where','while','which','who','whom','why','how','also','just',
  'up','out','into','about','over','after','before','between','through',
]);

// ═════════════════════════════════════════════════════════════════════════════
// EMBEDDING
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Tokenise text into meaningful lowercase tokens, stopwords removed.
 * @param {string} text
 * @returns {string[]}
 */
function tokenise(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * FNV-1a 32-bit hash, seeded.
 * Deterministic across Node.js versions — uses only integer arithmetic.
 */
function fnv1a(str, seed = 2166136261) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h  = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/**
 * Generate a 384-dimensional float vector for the given text.
 * Unigrams contribute weight 1.0 (3 buckets each).
 * Bigrams contribute weight 0.5 (2 buckets each).
 * Result is L2-normalised.
 *
 * @param {string} text
 * @returns {number[]}  Array of 384 floats
 */
function embed(text) {
  const tokens = tokenise(text);
  const vec    = new Array(VECTOR_SIZE).fill(0);

  // Unigrams — 3 independent hash seeds for better bucket coverage
  for (const tok of tokens) {
    for (let s = 0; s < 3; s++) {
      const h = fnv1a(tok, 2166136261 + s * 1000003) % VECTOR_SIZE;
      vec[h] += 1.0;
    }
  }

  // Bigrams — 2 seeds, lower weight so unigrams dominate
  for (let i = 0; i < tokens.length - 1; i++) {
    const bigram = `${tokens[i]}\x00${tokens[i + 1]}`;
    for (let s = 0; s < 2; s++) {
      const h = fnv1a(bigram, 2166136261 + (s + 10) * 1000003) % VECTOR_SIZE;
      vec[h] += 0.5;
    }
  }

  // L2 normalisation
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

// ═════════════════════════════════════════════════════════════════════════════
// CHUNKING
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Split text into overlapping sentence-boundary chunks.
 *
 * @param {string} text       Full text to chunk
 * @param {string} section    Section label attached to each chunk
 * @returns {Array<{text: string, section: string, wordCount: number}>}
 */
function chunkText(text, section = 'full') {
  if (!text || text.trim().length < 20) return [];

  // Split on sentence boundaries (greedy lookahead)
  const sentences = text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?])\s+(?=[A-Z\d"])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const chunks  = [];
  let current   = [];
  let wordCount = 0;

  const flush = () => {
    if (current.length === 0) return;
    const joined = current.join(' ');
    chunks.push({ text: joined, section, wordCount });
  };

  for (const sent of sentences) {
    const wc = sent.split(/\s+/).filter(Boolean).length;

    if (wordCount + wc > CHUNK_WORDS && current.length > 0) {
      flush();

      // Slide window: carry the tail of the current chunk forward
      const overlap  = [];
      let   overlapW = 0;
      for (let i = current.length - 1; i >= 0 && overlapW < OVERLAP_WORDS; i--) {
        const ow = current[i].split(/\s+/).length;
        overlap.unshift(current[i]);
        overlapW += ow;
      }
      current   = overlap;
      wordCount = overlapW;
    }

    current.push(sent);
    wordCount += wc;
  }

  flush();
  return chunks;
}

// ═════════════════════════════════════════════════════════════════════════════
// INDEXING
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Chunk, embed, and upsert all content from a parsed PDF into Qdrant.
 *
 * Strategy:
 *   1. Chunk each detected section independently (preserves section labels)
 *   2. If total section chunks < 4 (sparse detection), also chunk full text
 *   3. Upsert in batches of UPSERT_BATCH
 *
 * @param {object} parsedDoc   Output of pdfParser.parsePDF()
 * @param {string} analysisId  UUID for this analysis run
 * @returns {Promise<{indexed: number, chunks: number, elapsed: string, skipped: boolean}>}
 */
async function indexDocument(parsedDoc, analysisId) {
  const qdrant = getQdrant();
  if (!qdrant) return { indexed: 0, chunks: 0, elapsed: '0.00', skipped: true };

  const t0 = Date.now();
  const { sections, cleanedText, documentProfile } = parsedDoc;
  const filename = documentProfile?.filename || 'unknown.pdf';
  const points   = [];

  // ── 1. Section-level chunks ────────────────────────────────────────────
  const sectionMap = sections?.found || {};
  let sectionChunkCount = 0;

  for (const [sectionKey, sectionText] of Object.entries(sectionMap)) {
    if (!sectionText || sectionText.trim().length < 80) continue;

    const chunks = chunkText(sectionText, sectionKey);
    sectionChunkCount += chunks.length;

    for (const chunk of chunks) {
      points.push(buildPoint(chunk, analysisId, filename, points.length));
    }
  }

  // ── 2. Full-text chunks (fallback or supplement) ───────────────────────
  if (sectionChunkCount < 4 && cleanedText && cleanedText.length > 200) {
    const fullChunks = chunkText(cleanedText, 'full');
    for (const chunk of fullChunks) {
      points.push(buildPoint(chunk, analysisId, filename, points.length));
    }
  }

  if (points.length === 0) {
    console.log(`[vectorStore] No chunks generated for analysisId ${analysisId} — skipping upsert`);
    return { indexed: 0, chunks: 0, elapsed: '0.00', skipped: false };
  }

  // ── 3. Batch upsert ────────────────────────────────────────────────────
  console.log(`[vectorStore] Indexing ${points.length} chunks for analysisId ${analysisId}…`);

  let upserted = 0;
  for (let i = 0; i < points.length; i += UPSERT_BATCH) {
    const batch = points.slice(i, i + UPSERT_BATCH);
    await qdrant.upsert(COLLECTION, { wait: true, points: batch });
    upserted += batch.length;
    if (points.length > UPSERT_BATCH) {
      console.log(`[vectorStore]   … upserted ${upserted}/${points.length}`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`[vectorStore] ✓ ${upserted} chunks indexed in ${elapsed}s (collection: ${COLLECTION})`);

  // Per-section breakdown
  const bySection = {};
  for (const p of points) {
    const s = p.payload.section;
    bySection[s] = (bySection[s] || 0) + 1;
  }
  const breakdown = Object.entries(bySection).map(([s, n]) => `${s}:${n}`).join(', ');
  console.log(`[vectorStore]   breakdown → ${breakdown}`);

  return { indexed: upserted, chunks: points.length, elapsed, skipped: false };
}

/** Build a single Qdrant point from a text chunk. */
function buildPoint(chunk, analysisId, filename, globalIdx) {
  return {
    id:      uuidv4(),
    vector:  embed(chunk.text),
    payload: {
      analysisId,
      filename,
      section:    chunk.section,
      chunkIndex: globalIdx,
      wordCount:  chunk.wordCount,
      text:       chunk.text.slice(0, MAX_STORED_CHARS),
      indexedAt:  new Date().toISOString(),
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// RETRIEVAL
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Run a single vector search filtered to a specific analysisId.
 *
 * @param {string}   queryText   Natural-language query string
 * @param {string}   analysisId  Restrict results to this analysis
 * @param {number}   limit       Max results to return
 * @returns {Promise<Array>}     Array of Qdrant ScoredPoint objects
 */
async function retrieveChunks(queryText, analysisId, limit = 5) {
  const qdrant = getQdrant();
  if (!qdrant) return [];

  const queryVector = embed(queryText);

  const results = await qdrant.search(COLLECTION, {
    vector:          queryVector,
    limit,
    with_payload:    true,
    score_threshold: SCORE_THRESHOLD,
    filter: {
      must: [{ key: 'analysisId', match: { value: analysisId } }],
    },
  });

  return results;
}

/**
 * Run all 5 semantic queries for the citation-discovery pipeline and return
 * a deduplicated, ranked set of up to MAX_RETRIEVED unique chunks.
 *
 * Queries are designed to surface:
 *  1. Citation-dense passages (reference list, in-text patterns)
 *  2. Methodological claims (how evidence was collected)
 *  3. Results and findings (what was observed/measured)
 *  4. Core arguments and thesis claims
 *  5. Limitations and future work (self-critical sections)
 *
 * @param {string} analysisId
 * @returns {Promise<Array<{score: number, section: string, text: string}>>}
 */
async function retrieveForAnalysis(analysisId) {
  const qdrant = getQdrant();
  if (!qdrant || !analysisId) return [];

  const QUERIES = [
    'citation reference bibliography authors year journal volume doi',
    'methodology experimental design data collection procedure instrument',
    'results findings data analysis statistical outcome measure',
    'argument claim hypothesis thesis propose evidence support',
    'limitation weakness future work constraint caveat improvement',
  ];

  const t0 = Date.now();
  console.log(`[vectorStore] Retrieving semantic chunks for analysisId ${analysisId}…`);

  // Collect all results, deduplicate by chunk text prefix
  const seen    = new Map();   // key: first-80-chars of text → best score
  const results = [];

  for (const query of QUERIES) {
    let hits;
    try {
      hits = await retrieveChunks(query, analysisId, 4);
    } catch (err) {
      console.warn(`[vectorStore] Query "${query.slice(0, 40)}…" failed: ${err.message}`);
      continue;
    }

    for (const hit of hits) {
      const key = (hit.payload?.text || '').slice(0, 80);
      if (!seen.has(key) || seen.get(key) < hit.score) {
        seen.set(key, hit.score);
        results.push({
          score:   hit.score,
          section: hit.payload?.section || 'unknown',
          text:    hit.payload?.text    || '',
        });
      }
    }
  }

  // Sort by score descending, keep top MAX_RETRIEVED
  results.sort((a, b) => b.score - a.score);
  const unique = [];
  const uniqueKeys = new Set();
  for (const r of results) {
    const k = r.text.slice(0, 80);
    if (!uniqueKeys.has(k)) {
      uniqueKeys.add(k);
      unique.push(r);
      if (unique.length >= MAX_RETRIEVED) break;
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`[vectorStore] ✓ Retrieved ${unique.length} unique chunks in ${elapsed}s`);

  // Per-section summary
  const bySection = {};
  for (const r of unique) { bySection[r.section] = (bySection[r.section] || 0) + 1; }
  const summary = Object.entries(bySection).map(([s, n]) => `${s}:${n}`).join(', ');
  if (unique.length > 0) console.log(`[vectorStore]   sections → ${summary}`);

  return unique;
}

// ═════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═════════════════════════════════════════════════════════════════════════════

module.exports = {
  indexDocument,
  retrieveForAnalysis,
  retrieveChunks,
  embed,          // exported for testing
  chunkText,      // exported for testing
};
