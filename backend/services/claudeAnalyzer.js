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
const MAX_TOKENS = 4096;

// Maximum characters to send per section (keeps token cost reasonable)
const SECTION_MAX_CHARS = 3500;
// Maximum characters of full text if section extraction is sparse
const FULL_TEXT_MAX_CHARS = 12000;

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
  const message = await client.messages.create({
    model:      MODEL,
    max_tokens: MAX_TOKENS,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: prompt }],
  });

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

/**
 * @param {object}   parsedDoc        Full output of pdfParser.parsePDF()
 * @param {Array}    retrievedChunks  Chunks from retrieveForAnalysis() — may be []
 */
function buildPrompt(parsedDoc, retrievedChunks = []) {
  const { cleanedText, sections, wordCount, charCount, pageCount, metadata, documentProfile } = parsedDoc;
  const dp = documentProfile || {};

  // Build section text block
  let sectionBlock = '';
  let totalSectionChars = 0;

  const SECTION_LABELS = {
    abstract:         'ABSTRACT',
    introduction:     'INTRODUCTION',
    literatureReview: 'LITERATURE REVIEW',
    methodology:      'METHODOLOGY',
    results:          'RESULTS / FINDINGS',
    discussion:       'DISCUSSION',
    conclusion:       'CONCLUSION',
    references:       'REFERENCES',
  };

  for (const [key, label] of Object.entries(SECTION_LABELS)) {
    const raw = (sections.found || {})[key] || '';
    if (raw.trim().length > 0) {
      const excerpt = raw.length > SECTION_MAX_CHARS
        ? raw.slice(0, SECTION_MAX_CHARS) + '\n[... section continues ...]'
        : raw;
      sectionBlock += `\n\n────── ${label} (${countWords(raw)} words) ──────\n${excerpt}`;
      totalSectionChars += excerpt.length;
    } else {
      sectionBlock += `\n\n────── ${label} ──────\n[NOT DETECTED IN DOCUMENT]`;
    }
  }

  // If sections are sparse, supplement with full document text
  let fullTextBlock = '';
  if (totalSectionChars < 2000 && cleanedText.length > 0) {
    const sample = cleanedText.slice(0, FULL_TEXT_MAX_CHARS);
    fullTextBlock = `\n\n═══ FULL DOCUMENT TEXT (first ${Math.min(cleanedText.length, FULL_TEXT_MAX_CHARS).toLocaleString()} of ${cleanedText.length.toLocaleString()} chars) ═══\n${sample}`;
    if (cleanedText.length > FULL_TEXT_MAX_CHARS) fullTextBlock += '\n[... document continues ...]';
  }

  // Build section presence table
  const presenceTable = Object.entries(sections.present || {})
    .map(([k, v]) => `  ${v ? '✓' : '✗'} ${SECTION_LABELS[k] || k}`)
    .join('\n');

  // Citation count estimate
  const citationMatches = cleanedText.match(/\([A-Z][a-zA-Z]+[^)]*\d{4}\)|\[\d+\]/g) || [];

  // OCR note
  const ocrNote = (dp.ocrPages || []).length > 0
    ? `OCR was applied to pages: ${dp.ocrPages.join(', ')}`
    : 'No OCR was required (document is text-based)';

  // ── Build semantic retrieval block ──────────────────────────────────────
  let retrievedBlock = '';
  if (retrievedChunks.length > 0) {
    retrievedBlock = '\n\n═══ SEMANTIC CITATION DISCOVERY — RETRIEVED PASSAGES ═══\n';
    retrievedBlock += 'The following passages were retrieved via vector search as the most relevant to\n';
    retrievedBlock += 'citation analysis, methodology, evidence, arguments, and limitations.\n';
    retrievedBlock += 'Use these alongside the section text above to write grounded, specific feedback.\n';
    retrievedBlock += 'Do NOT invent details not present in any of the text blocks provided.\n';

    retrievedChunks.forEach((chunk, idx) => {
      const sectionLabel = chunk.section.replace(/([A-Z])/g, ' $1').trim();
      const scorePct     = Math.round((chunk.score || 0) * 100);
      retrievedBlock += `\n── Retrieved passage ${idx + 1}/${retrievedChunks.length}`;
      retrievedBlock += ` [section: ${sectionLabel} | relevance: ${scorePct}%] ──\n`;
      retrievedBlock += chunk.text;
      retrievedBlock += '\n';
    });
  }

  return `You are evaluating a real academic document. All feedback must reference the actual text provided below.

═══ DOCUMENT VERIFICATION PROFILE ═══
  Filename        : ${dp.filename || 'uploaded.pdf'}
  Pages           : ${pageCount} (verified by pdfjs-dist parser)
  Words extracted : ${wordCount.toLocaleString()}
  Characters      : ${charCount.toLocaleString()}
  Text quality    : ${dp.textQuality || 'good'}
  Analysis confid : ${dp.analysisConfidence || 0}%
  ${ocrNote}
  Citation format : ${metadata?.citationFormat || 'unknown'}
  Est. in-text citations: ~${citationMatches.length}

Sections detected:
${presenceTable}

═══ EXTRACTED SECTION TEXT ═══
(Use these to write SPECIFIC, GROUNDED feedback. Quote actual phrases.)
${sectionBlock}
${fullTextBlock}${retrievedBlock}

═══ EVALUATION INSTRUCTIONS ═══
Return ONLY the following JSON object. Every string field must contain complete, specific, grounded sentences referencing what you actually read above. DO NOT write generic academic advice unrelated to this specific document.

{
  "overall": {
    "score": <integer 0–100>,
    "grade": <"A+"|"A"|"A-"|"B+"|"B"|"B-"|"C+"|"C"|"C-"|"D"|"F">,
    "summary": "<3–5 sentence paragraph that mentions specific features of THIS document — its topic, what you found strong, what needs work>",
    "topStrengths": [
      "<specific strength referencing actual content — 1–2 sentences>",
      "<another specific strength>"
    ],
    "topImprovements": [
      "<specific improvement needed, referencing an actual gap or weakness — 1–2 sentences>",
      "<another improvement>"
    ]
  },
  "structural": {
    "score": <integer 0–100>,
    "grade": <grade>,
    "summary": "<3–4 sentence paragraph on structural quality, naming sections that are present, absent, or underdeveloped>",
    "sections": {
      "abstract":         { "present": <bool>, "quality": <"strong"|"adequate"|"weak"|"missing">, "feedback": "<2–3 sentences grounded in what the abstract actually says, or explaining what is missing>" },
      "introduction":     { "present": <bool>, "quality": <quality>, "feedback": "<2–3 sentences>" },
      "literatureReview": { "present": <bool>, "quality": <quality>, "feedback": "<2–3 sentences>" },
      "methodology":      { "present": <bool>, "quality": <quality>, "feedback": "<2–3 sentences>" },
      "results":          { "present": <bool>, "quality": <quality>, "feedback": "<2–3 sentences>" },
      "discussion":       { "present": <bool>, "quality": <quality>, "feedback": "<2–3 sentences>" },
      "conclusion":       { "present": <bool>, "quality": <quality>, "feedback": "<2–3 sentences>" },
      "references":       { "present": <bool>, "quality": <quality>, "feedback": "<2–3 sentences>" }
    },
    "flowAnalysis": "<4–6 sentence paragraph on logical flow, transitions, coherence — reference the actual text structure you observed>",
    "recommendations": [
      "<specific, actionable recommendation referencing this document>",
      "<another>",
      "<another>"
    ]
  },
  "citations": {
    "score": <integer 0–100>,
    "grade": <grade>,
    "summary": "<3–4 sentence paragraph on citation quality referencing what you observed in the text>",
    "formatDetected": "<APA|IEEE|MLA|Chicago|mixed|none detected>",
    "inTextCount": <estimated integer>,
    "densityAssessment": "<3–5 sentences on frequency and distribution of citations — are claims backed? Is evidence sparse?>",
    "qualityAssessment": "<3–5 sentences on whether the citations appear credible, relevant, and appropriate for the topic of this paper>",
    "recencyAssessment": "<2–4 sentences on currency of sources based on dates you can infer from the citation patterns>",
    "issues": [
      "<specific issue observed>",
      "<another>"
    ],
    "recommendations": [
      "<specific recommendation>",
      "<another>",
      "<another>"
    ]
  },
  "arguments": {
    "score": <integer 0–100>,
    "grade": <grade>,
    "summary": "<3–4 sentence paragraph on argument quality>",
    "claimAnalysis": "<4–6 sentences analyzing whether claims in THIS document are clear, well-stated, and arguable — reference specific passages>",
    "evidenceAnalysis": "<4–6 sentences on evidence usage — where evidence is strong, where it is absent, what patterns you observed>",
    "logicAnalysis": "<3–5 sentences on logical coherence, use of reasoning language, whether arguments flow>",
    "counterArgumentAnalysis": "<3–5 sentences on whether limitations and opposing views are addressed — be specific about what was and wasn't addressed>",
    "weaknesses": [
      {
        "title": "<short label for the weakness>",
        "description": "<2–3 sentences explaining this specific weakness, referencing the text>",
        "suggestion": "<1–2 sentences with a concrete fix>"
      }
    ],
    "recommendations": [
      "<specific recommendation>",
      "<another>",
      "<another>"
    ]
  },
  "integrity": {
    "score": <integer 0–100>,
    "grade": <grade>,
    "riskLevel": <"low"|"moderate"|"high">,
    "summary": "<3–4 sentence paragraph on academic integrity risk, based on what you actually read>",
    "risks": [
      {
        "type": "<vague_authority|unsupported_claim|citation_gap|weak_evidence|methodological_gap|other>",
        "severity": <"low"|"medium"|"high">,
        "title": "<short descriptive label>",
        "description": "<2–3 sentences explaining the specific risk, referencing patterns in this document>",
        "resolution": "<2–3 sentences with concrete steps to resolve it>"
      }
    ],
    "preventionAdvice": "<3–4 sentences of specific pre-submission advice based on the actual risks you identified in this document>",
    "recommendations": [
      "<specific recommendation>",
      "<another>"
    ]
  }
}

Scoring reference:
  90–100  Exceptional — ready for submission or publication
  75–89   Good — minor refinements needed
  60–74   Adequate — clear improvements required
  45–59   Below standard — significant revision needed
  0–44    Poor — fundamental issues must be addressed

Important:
- If risks array would be empty (truly no concerns), include one low-severity item noting a minor improvement area.
- If weaknesses array would be empty, include one item noting a minor area for growth.
- scores must reflect actual document quality, not aspirational assessment.
- inTextCount: count only what you can reasonably observe in the text above.`;
}

// ── JSON parser (robust) ──────────────────────────────────────────────────────

function parseJSON(text) {
  // Strip any accidental markdown code fences
  const cleaned = text
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to extract the outermost { ... } block
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch {/* fall through */}
    }
    console.error('[claudeAnalyzer] Failed to parse JSON. Raw response (first 500 chars):', text.slice(0, 500));
    throw new Error('Claude returned non-parseable JSON. Check your API key and model availability.');
  }
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
