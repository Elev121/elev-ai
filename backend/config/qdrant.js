/**
 * config/qdrant.js
 *
 * Qdrant Cloud client singleton + collection lifecycle management.
 *
 * Environment variables (set in backend/.env):
 *   QDRANT_URL        — cloud cluster URL, e.g. https://xxx.qdrant.io
 *   QDRANT_API_KEY    — JWT/Bearer API key
 *   QDRANT_COLLECTION — collection name (default: elev_chunks)
 *
 * The collection uses 384-dimensional cosine vectors.  That size matches
 * the standard sentence-transformers all-MiniLM-L6-v2 footprint, so the
 * collection is forward-compatible if the embedding strategy is later
 * upgraded to real dense transformers.
 *
 * Payload indexes are created on `analysisId` and `section` so that
 * per-analysis filtered searches are fast even at large scale.
 */

'use strict';

const { QdrantClient } = require('@qdrant/js-client-rest');

// ── Constants ─────────────────────────────────────────────────────────────────
const VECTOR_SIZE = 384;
const DISTANCE    = 'Cosine';
const COLLECTION  = process.env.QDRANT_COLLECTION || 'elev_chunks';

// ── Client singleton ──────────────────────────────────────────────────────────
let _client = null;

/**
 * Returns the Qdrant client, or null when QDRANT_URL is not configured.
 * All callers must handle the null case gracefully.
 */
function getQdrant() {
  if (_client) return _client;

  const url    = process.env.QDRANT_URL;
  const apiKey = process.env.QDRANT_API_KEY;

  if (!url) {
    // Warn once, not on every call
    if (!getQdrant._warned) {
      console.warn('[qdrant] QDRANT_URL not set — vector store disabled. Add it to backend/.env to enable.');
      getQdrant._warned = true;
    }
    return null;
  }

  _client = new QdrantClient({ url, apiKey: apiKey || undefined });
  return _client;
}
getQdrant._warned = false;

// ── Collection management ─────────────────────────────────────────────────────

/**
 * Ensure the collection exists and has the correct payload indexes.
 * Called once at server startup.  Safe to call multiple times.
 *
 * @returns {Promise<boolean>} true = ready, false = Qdrant not configured / error
 */
async function initCollection() {
  const client = getQdrant();
  if (!client) return false;

  try {
    // ── 1. Create collection if it does not exist ─────────────────────────
    const { collections } = await client.getCollections();
    const exists = collections.some((c) => c.name === COLLECTION);

    if (!exists) {
      await client.createCollection(COLLECTION, {
        vectors: {
          size:     VECTOR_SIZE,
          distance: DISTANCE,
          // on_disk: false — keep vectors in RAM for fast retrieval
        },
        optimizers_config: {
          default_segment_number: 2,       // good for small–medium collections
          indexing_threshold:     20000,   // build HNSW index when segment grows
        },
        hnsw_config: {
          m:              16,
          ef_construct:   100,
          full_scan_threshold: 10000,
        },
      });
      console.log(`[qdrant] ✓ Collection '${COLLECTION}' created (${VECTOR_SIZE}-dim ${DISTANCE})`);
    } else {
      console.log(`[qdrant] ✓ Collection '${COLLECTION}' exists (${VECTOR_SIZE}-dim ${DISTANCE})`);
    }

    // ── 2. Create payload indexes for fast filtered search ────────────────
    //    These are idempotent — safe to call even if the index already exists.
    const indexFields = [
      { field_name: 'analysisId', field_schema: 'keyword' },
      { field_name: 'section',    field_schema: 'keyword' },
      { field_name: 'filename',   field_schema: 'keyword' },
    ];

    for (const idx of indexFields) {
      try {
        await client.createPayloadIndex(COLLECTION, idx);
      } catch (idxErr) {
        // Index already exists → the REST API throws; safe to ignore
        if (!idxErr.message?.includes('already exists') &&
            !idxErr.message?.includes('4xx')) {
          console.warn(`[qdrant] Payload index '${idx.field_name}': ${idxErr.message}`);
        }
      }
    }

    return true;
  } catch (err) {
    console.error(`[qdrant] Collection init failed: ${err.message}`);
    return false;
  }
}

/**
 * Delete all points for a given analysisId.
 * Useful for clean re-analysis without orphaned vectors.
 *
 * @param {string} analysisId
 * @returns {Promise<number>} number of points deleted (or 0 on error/disabled)
 */
async function deleteAnalysisChunks(analysisId) {
  const client = getQdrant();
  if (!client || !analysisId) return 0;

  try {
    const result = await client.delete(COLLECTION, {
      wait:   true,
      filter: {
        must: [{ key: 'analysisId', match: { value: analysisId } }],
      },
    });
    return result?.result?.deleted ?? 0;
  } catch (err) {
    console.warn(`[qdrant] deleteAnalysisChunks error: ${err.message}`);
    return 0;
  }
}

module.exports = {
  getQdrant,
  initCollection,
  deleteAnalysisChunks,
  COLLECTION,
  VECTOR_SIZE,
  DISTANCE,
};
