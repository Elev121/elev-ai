const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/firebase');

const router = express.Router();

// ─── Scoring helpers ──────────────────────────────────────────────────────────

function scoreInRange(min, max) {
  return Math.round(min + Math.random() * (max - min));
}

/**
 * Simulated NLP analysis pipeline.
 * In production, replace with real ML model calls (e.g., spaCy, HuggingFace, OpenAI).
 */
function analyzeAbstract(title, abstract, keywords) {
  const wordCount = abstract.split(/\s+/).filter(Boolean).length;
  const hasMethodology = /method|approach|technique|algorithm|model|framework|experiment/i.test(abstract);
  const hasResults = /result|finding|show|demonstrate|achieve|improve|accuracy|performance/i.test(abstract);
  const hasContribution = /contribut|novel|propos|new|first|introduc/i.test(abstract);
  const keywordDensity = keywords
    ? keywords.split(',').filter((k) => abstract.toLowerCase().includes(k.trim().toLowerCase())).length
    : 0;

  // Semantic coherence — penalize very short abstracts
  const semanticCoherence =
    wordCount < 50
      ? scoreInRange(30, 55)
      : wordCount < 100
      ? scoreInRange(55, 72)
      : scoreInRange(72, 95);

  // Citation quality — demo heuristic
  const citationQuality = scoreInRange(60, 92);

  // Methodology rigor
  const methodologyRigor = hasMethodology
    ? scoreInRange(70, 95)
    : scoreInRange(40, 65);

  // Originality
  const originalityIndex = hasContribution
    ? scoreInRange(68, 93)
    : scoreInRange(48, 72);

  // Results clarity
  const resultsClarity = hasResults
    ? scoreInRange(72, 94)
    : scoreInRange(45, 68);

  // ELEV composite score
  const elevScore = Math.round(
    semanticCoherence * 0.2 +
      citationQuality * 0.2 +
      methodologyRigor * 0.25 +
      originalityIndex * 0.2 +
      resultsClarity * 0.15
  );

  // Recommendations
  const recommendations = [];
  if (semanticCoherence < 65) recommendations.push('Improve abstract clarity and logical flow.');
  if (citationQuality < 70) recommendations.push('Strengthen citation foundation with peer-reviewed sources.');
  if (!hasMethodology) recommendations.push('Explicitly state the research methodology used.');
  if (!hasContribution) recommendations.push('Clarify the novel contribution of the research.');
  if (!hasResults) recommendations.push('Include a concise summary of key results or findings.');
  if (wordCount < 100) recommendations.push('Consider expanding the abstract to 150–250 words.');
  if (recommendations.length === 0)
    recommendations.push('Abstract meets ELEV quality standards. Proceed to full validation.');

  // Flags
  const flags = [];
  if (wordCount < 50) flags.push({ level: 'warning', message: 'Abstract is very short.' });
  if (methodologyRigor < 55) flags.push({ level: 'warning', message: 'Methodology section appears weak.' });
  if (elevScore < 50) flags.push({ level: 'critical', message: 'Overall quality below acceptance threshold.' });

  return {
    elevScore,
    dimensions: {
      semanticCoherence,
      citationQuality,
      methodologyRigor,
      originalityIndex,
      resultsClarity,
    },
    recommendations,
    flags,
    wordCount,
    keywordsMatched: keywordDensity,
    grade:
      elevScore >= 85
        ? 'A'
        : elevScore >= 75
        ? 'B'
        : elevScore >= 65
        ? 'C'
        : elevScore >= 50
        ? 'D'
        : 'F',
  };
}

// ─── POST /api/validate ───────────────────────────────────────────────────────
router.post(
  '/',
  [
    body('title').trim().notEmpty().withMessage('Paper title is required').isLength({ max: 300 }),
    body('abstract').trim().notEmpty().withMessage('Abstract is required').isLength({ min: 20, max: 5000 }),
    body('keywords').trim().optional().isLength({ max: 500 }),
    body('discipline').trim().optional().isLength({ max: 100 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { title, abstract, keywords, discipline } = req.body;
    const result = analyzeAbstract(title, abstract, keywords);

    const record = {
      id: uuidv4(),
      title,
      abstract: abstract.substring(0, 500), // store truncated for privacy
      keywords: keywords || null,
      discipline: discipline || null,
      ...result,
      createdAt: new Date().toISOString(),
    };

    const db = getDb();
    if (db) {
      try {
        await db.collection('validations').doc(record.id).set(record);
      } catch (err) {
        console.warn('[validate] Firestore write skipped:', err.message);
      }
    }

    return res.json({
      success: true,
      validationId: record.id,
      title,
      ...result,
      processedAt: record.createdAt,
    });
  }
);

module.exports = router;
