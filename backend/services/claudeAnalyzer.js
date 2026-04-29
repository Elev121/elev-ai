/**
 * claudeAnalyzer.js  v2
 * Sends structured, section-by-section document content to the Claude API.
 * The prompt feeds Claude the actual extracted text of each detected section
 * so feedback is always grounded in the real document — not generic templates.
 *
 * Normalised output shape (all downstream code depends on this):
 * {
 *   elevScore, grade, overallNarrative, overall,
 *   document, documentProfile,
 *   structural, citation, argument, integrity
 * }
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { retrieveForAnalysis } = require('./vectorStore');

// ── Client singleton ──────────────────────────────────────────────────────────
let _client = null;
function getClient() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set in your .env file. ' +
        'Get a key from https://console.anthropic.com/settings/keys'
      );
    }
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

const MODEL      = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 2500;

// Max chars extracted from any single section
const SECTION_CHAR_CAP  = 400;
// Total char budget for ALL document text (sections + chunks combined)
const DOC_TEXT_BUDGET   = 3200;
// Claude API timeout — bail out before Netlify's 26 s proxy limit
const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS, 10) || 25000;

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Analyse a parsed PDF document via Claude.
 *
 * @param {object} parsedDoc   Output of pdfParser.parsePDF()
 * @param {string} [analysisId] UUID from the upload route — used to retrieve
 *                              semantically relevant chunks from Qdrant before
 *                              sending the prompt.  Optional: if omitted, the
 *                              semantic retrieval step is skipped.
 * @returns {Promise<object>} Normalised ELEV result object
 */
async function analyzeWithClaude(parsedDoc, analysisId) {
  const { cleanedText, sections, wordCount, charCount, pageCount, metadata, documentProfile } = parsedDoc;

  console.log(`[claudeAnalyzer] Building structured prompt for Claude (${MODEL})…`);
  console.log(`[claudeAnalyzer] Document: ${wordCount} words | ${pageCount} pages | format: ${metadata?.citationFormat}`);

  // ── Semantic retrieval from Qdrant ─────────────────────────────────────
  // Retrieve the most topically relevant chunks indexed from this document.
  // If Qdrant is not configured or retrieval fails, we continue without it.
  let retrievedChunks = [];
  if (analysisId) {
    try {
      retrievedChunks = await retrieveForAnalysis(analysisId);
    } catch (retrieveErr) {
      console.warn(`[claudeAnalyzer] Semantic retrieval failed (non-fatal): ${retrieveErr.message}`);
    }
  }

  const prompt = buildPrompt(parsedDoc, retrievedChunks);

  console.log(`[claudeAnalyzer] Prompt length: ${prompt.length} chars (${retrievedChunks.length} retrieved chunks). Sending to Claude API…`);
  const t0 = Date.now();

  const client = getClient();

  // Race the API call against a hard timeout so we can fall back before
  // Netlify's 26-second proxy deadline fires a 504.
  const timeoutErr = Object.assign(
    new Error(`Claude API timed out after ${CLAUDE_TIMEOUT_MS / 1000}s`),
    { code: 'CLAUDE_TIMEOUT' }
  );
  const message = await Promise.race([
    client.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: prompt }],
    }),
    new Promise((_, reject) => setTimeout(() => reject(timeoutErr), CLAUDE_TIMEOUT_MS)),
  ]);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  const inputTokens  = message.usage?.input_tokens  ?? '?';
  const outputTokens = message.usage?.output_tokens ?? '?';
  console.log(`[claudeAnalyzer] Claude responded in ${elapsed}s | tokens: ${inputTokens} in / ${outputTokens} out`);

  const rawText = message.content[0]?.text || '';
  const parsed  = parseJSON(rawText);
  return normalise(parsed, parsedDoc);
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  'You are ELEV (Evaluative Learning & Evidence Validator), an expert academic research evaluator.',
  'You evaluate uploaded research papers with the rigour and honesty of a senior academic reviewer.',
  'CRITICAL RULES:',
  '1. Your feedback must be based EXCLUSIVELY on the document text provided. Do NOT invent, assume, or genericise.',
  '2. Quote or closely paraphrase actual phrases, sentences, or passages from the text.',
  '3. Be specific: name the section, page area, or claim you are referring to.',
  '4. Be honest: if a section is genuinely weak or missing, say so clearly with educational explanation.',
  '5. Return ONLY valid JSON — no markdown, no code fences, no text outside the JSON object.',
].join('\n');

// ── Prompt builder ────────────────────────────────────────────────────────────

// Sections in priority order — references skipped (high char count, low signal)
const PRIORITY_SECTIONS = [
  ['abstract',         'ABSTRACT'],
  ['introduction',     'INTRODUCTION'],
  ['conclusion',       'CONCLUSION'],
  ['methodology',      'METHODOLOGY'],
  ['results',          'RESULTS'],
  ['discussion',       'DISCUSSION'],
  ['literatureReview', 'LIT REVIEW'],
];

const ALL_SECTION_KEYS = [
  'abstract','introduction','literatureReview','methodology',
  'results','discussion','conclusion','references',
];

function buildPrompt(parsedDoc, retrievedChunks = []) {
  const { cleanedText, sections, wordCount, pageCount, metadata, documentProfile } = parsedDoc;
  const dp = documentProfile || {};

  // Compact presence line: "✓ abstract  ✗ methodology  ✓ conclusion …"
  const presenceLine = ALL_SECTION_KEYS
    .map((k) => `${(sections.present || {})[k] ? '✓' : '✗'} ${k}`)
    .join('  ');

  // Citation count estimate (cheap regex on already-parsed text)
  const citCount = (cleanedText.match(/\([A-Z][a-zA-Z]+[^)]*\d{4}\)|\[\d+\]/g) || []).length;

  // ── Build section excerpts within a hard character budget ────────────────
  let budget = DOC_TEXT_BUDGET;
  let sectionBlock = '';

  for (const [key, label] of PRIORITY_SECTIONS) {
    if (budget <= 50) break;
    const raw = ((sections.found || {})[key] || '').trim();
    if (!raw) continue;
    const take    = Math.min(SECTION_CHAR_CAP, budget);
    const excerpt = raw.slice(0, take);
    sectionBlock += `[${label}]\n${excerpt}${raw.length > take ? '…' : ''}\n\n`;
    budget -= excerpt.length;
  }

  // Sparse-document fallback: small slice of raw text, still within budget
  if (!sectionBlock && cleanedText.length > 0) {
    const take    = Math.min(budget, 1500);
    const excerpt = cleanedText.slice(0, take);
    sectionBlock  = `[DOCUMENT TEXT]\n${excerpt}${cleanedText.length > take ? '…' : ''}\n\n`;
    budget       -= excerpt.length;
  }

  // One Qdrant chunk maximum (most relevant), hard-capped at 400 chars
  let retrievedBlock = '';
  if (retrievedChunks.length > 0 && budget > 100) {
    const chunkText = (retrievedChunks[0].text || '').slice(0, Math.min(400, budget));
    retrievedBlock  = `[RETRIEVED PASSAGE]\n${chunkText}\n\n`;
  }

  const docBlock = sectionBlock + retrievedBlock;

  const prompt = `Evaluate this academic document. All feedback must reference the text below.

FILE: ${dp.filename || 'uploaded.pdf'} | ${pageCount}p | ${wordCount} words | ~${citCount} citations | format: ${metadata?.citationFormat || 'unknown'}
SECTIONS: ${presenceLine}

${docBlock}Return ONLY valid JSON — no markdown fences, no text outside the object:
{"overall":{"score":<0-100>,"grade":<"A+"|"A"|"A-"|"B+"|"B"|"B-"|"C+"|"C"|"C-"|"D"|"F">,"summary":"<2 sentences>","topStrengths":["<strength>","<strength>"],"topImprovements":["<improvement>","<improvement>"]},"structural":{"score":<0-100>,"grade":<grade>,"summary":"<2 sentences>","sections":{"abstract":{"present":<bool>,"quality":<"strong"|"adequate"|"weak"|"missing">,"feedback":"<1 sentence>"},"introduction":{"present":<bool>,"quality":<quality>,"feedback":"<1 sentence>"},"literatureReview":{"present":<bool>,"quality":<quality>,"feedback":"<1 sentence>"},"methodology":{"present":<bool>,"quality":<quality>,"feedback":"<1 sentence>"},"results":{"present":<bool>,"quality":<quality>,"feedback":"<1 sentence>"},"discussion":{"present":<bool>,"quality":<quality>,"feedback":"<1 sentence>"},"conclusion":{"present":<bool>,"quality":<quality>,"feedback":"<1 sentence>"},"references":{"present":<bool>,"quality":<quality>,"feedback":"<1 sentence>"}},"flowAnalysis":"<2 sentences>","recommendations":["<rec>","<rec>"]},"citations":{"score":<0-100>,"grade":<grade>,"summary":"<2 sentences>","formatDetected":"<APA|IEEE|MLA|Chicago|mixed|none>","inTextCount":<int>,"densityAssessment":"<1 sentence>","qualityAssessment":"<1 sentence>","recencyAssessment":"<1 sentence>","issues":["<issue>","<issue>"],"recommendations":["<rec>","<rec>"]},"arguments":{"score":<0-100>,"grade":<grade>,"summary":"<2 sentences>","claimAnalysis":"<1 sentence>","evidenceAnalysis":"<1 sentence>","logicAnalysis":"<1 sentence>","counterArgumentAnalysis":"<1 sentence>","weaknesses":[{"title":"<label>","description":"<1 sentence>","suggestion":"<1 sentence>"}],"recommendations":["<rec>","<rec>"]},"integrity":{"score":<0-100>,"grade":<grade>,"riskLevel":<"low"|"moderate"|"high">,"summary":"<2 sentences>","risks":[{"type":"<type>","severity":<"low"|"medium"|"high">,"title":"<label>","description":"<1 sentence>","resolution":"<1 sentence>"}],"preventionAdvice":"<1 sentence>","recommendations":["<rec>","<rec>"]}}`;

  console.log(`[claudeAnalyzer] Prompt size: ${prompt.length} chars | doc text used: ${DOC_TEXT_BUDGET - budget} chars`);
  return prompt;
}

// ── JSON parser ───────────────────────────────────────────────────────────────

function parseJSON(text) {
  // Step 1 — remove ALL code fences regardless of where they appear
  let responseText = (text || '').trim();
  responseText = responseText
    .replace(/```json\s*/gi, '')
    .replace(/```/g, '')
    .trim();

  // Step 2 — extract the JSON object
  const match = responseText.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error('[claudeAnalyzer] No JSON object found in response:', responseText.slice(0, 300));
    throw new Error('No JSON found in AI response. Please retry.');
  }

  // Step 3 — log the cleaned text before parsing
  console.log('[claudeAnalyzer] CLEANED RESPONSE:', match[0].slice(0, 200));

  return JSON.parse(match[0]);
}

// ── Normalise Claude output ───────────────────────────────────────────────────

function normalise(raw, parsedDoc) {
  const overall   = raw.overall   || {};
  const struct    = raw.structural || {};
  const citations = raw.citations  || {};
  const args      = raw.arguments  || {};
  const integ     = raw.integrity  || {};

  const structScore = clamp(struct.score    ?? 65);
  const citeScore   = clamp(citations.score ?? 65);
  const argScore    = clamp(args.score      ?? 65);
  const integScore  = clamp(integ.score     ?? 65);

  // Weighted composite: 30% structural, 25% citation, 25% argument, 20% integrity
  const elevScore = clamp(
    Math.round(structScore * 0.30 + citeScore * 0.25 + argScore * 0.25 + integScore * 0.20)
  );

  const dp = parsedDoc.documentProfile || {};

  return {
    elevScore,
    grade:            toGrade(clamp(overall.score ?? elevScore)),
    overallNarrative: overall.summary || '',
    overall: {
      topStrengths:    ensureArray(overall.topStrengths),
      topImprovements: ensureArray(overall.topImprovements),
    },

    document: {
      title:          parsedDoc.metadata?.title || dp.filename || 'Uploaded Document',
      wordCount:      parsedDoc.wordCount || 0,
      charCount:      parsedDoc.charCount || 0,
      pageCount:      parsedDoc.pageCount || 1,
      citationFormat: citations.formatDetected || parsedDoc.metadata?.citationFormat || 'Unknown',
    },

    documentProfile: {
      ...dp,
      claudeModel:  MODEL,
    },

    structural: {
      score:           structScore,
      grade:           toGrade(structScore),
      summary:         struct.summary || '',
      sections:        normaliseSections(struct.sections || {}, parsedDoc.sections),
      flowAnalysis:    struct.flowAnalysis || '',
      recommendations: ensureArray(struct.recommendations),
    },

    citation: {
      score:             citeScore,
      grade:             toGrade(citeScore),
      summary:           citations.summary || '',
      formatDetected:    citations.formatDetected || 'Unknown',
      inTextCount:       citations.inTextCount || 0,
      densityAssessment: citations.densityAssessment || '',
      qualityAssessment: citations.qualityAssessment || '',
      recencyAssessment: citations.recencyAssessment || '',
      issues:            ensureArray(citations.issues),
      recommendations:   ensureArray(citations.recommendations),
    },

    argument: {
      score:                   argScore,
      grade:                   toGrade(argScore),
      summary:                 args.summary || '',
      claimAnalysis:           args.claimAnalysis || '',
      evidenceAnalysis:        args.evidenceAnalysis || '',
      logicAnalysis:           args.logicAnalysis || '',
      counterArgumentAnalysis: args.counterArgumentAnalysis || '',
      weaknesses:              ensureArray(args.weaknesses).map(normaliseWeakness),
      recommendations:         ensureArray(args.recommendations),
    },

    integrity: {
      score:           integScore,
      grade:           toGrade(integScore),
      riskLevel:       integ.riskLevel || 'low',
      summary:         integ.summary || '',
      risks:           ensureArray(integ.risks).map(normaliseRisk),
      preventionAdvice:integ.preventionAdvice || '',
      recommendations: ensureArray(integ.recommendations),
    },
  };
}

// ── Normalise helpers ─────────────────────────────────────────────────────────

const SECTION_KEYS = ['abstract','introduction','literatureReview','methodology','results','discussion','conclusion','references'];

function normaliseSections(claudeSections, parsedSections) {
  const out = {};
  SECTION_KEYS.forEach((key) => {
    const cs  = claudeSections[key] || {};
    const det = parsedSections?.present?.[key] ?? false;
    out[key] = {
      present:  cs.present  ?? det,
      quality:  cs.quality  || (det ? 'adequate' : 'missing'),
      feedback: cs.feedback || (det
        ? `The ${key} section is present. Further detail was not available from the AI response.`
        : `No ${key} section was detected in this document.`),
    };
  });
  return out;
}

function normaliseWeakness(w) {
  if (typeof w === 'string') return { title: 'Observation', description: w, suggestion: '' };
  return {
    title:       w.title       || 'Observation',
    description: w.description || '',
    suggestion:  w.suggestion  || '',
  };
}

function normaliseRisk(r) {
  if (typeof r === 'string') return { type: 'other', severity: 'low', title: 'Note', description: r, resolution: '' };
  return {
    type:        r.type        || 'other',
    severity:    r.severity    || 'low',
    title:       r.title       || 'Integrity Note',
    description: r.description || '',
    resolution:  r.resolution  || '',
  };
}

function ensureArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'string') return [v];
  return [];
}

function clamp(n) { return Math.max(0, Math.min(100, Math.round(Number(n) || 0))); }

function toGrade(s) {
  if (s >= 93) return 'A+';
  if (s >= 88) return 'A';
  if (s >= 83) return 'A-';
  if (s >= 78) return 'B+';
  if (s >= 73) return 'B';
  if (s >= 68) return 'B-';
  if (s >= 63) return 'C+';
  if (s >= 58) return 'C';
  if (s >= 53) return 'C-';
  if (s >= 45) return 'D';
  return 'F';
}

function countWords(text) {
  return (text || '').split(/\s+/).filter(Boolean).length;
}

module.exports = { analyzeWithClaude };
