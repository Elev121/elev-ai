/**
 * routes/upload.js  v3
 * POST /api/upload  — Real PDF analysis pipeline:
 *   1. multer saves the file locally
 *   2. pdfParser extracts text page-by-page (with OCR fallback)
 *   3. claudeAnalyzer sends structured content to Claude API
 *   4. Normalised result (including documentProfile) is returned
 *
 * No mock data, no hardcoded feedback.  Every result is real.
 */

'use strict';

const express         = require('express');
const { v4: uuidv4 } = require('uuid');

const { upload, uploadToFirebaseStorage, deleteLocalFile } = require('../config/storage');
const { parsePDF }             = require('../services/pdfParser');
const { runFullAnalysis }      = require('../services/analysisEngine');
const { analyzeWithClaude }    = require('../services/claudeAnalyzer');
const { indexDocument }        = require('../services/vectorStore');
const { getDb }                = require('../config/firebase');

const router = express.Router();

// In-memory results cache (1 hour TTL)
const resultsCache = new Map();

// ── POST /api/upload ──────────────────────────────────────────────────────────
router.post('/', upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No PDF file provided.' });
  }

  const localPath    = req.file.path;
  const originalName = req.file.originalname;
  const analysisId   = uuidv4();

  console.log(`\n[upload] ── New request ──────────────────────────`);
  console.log(`[upload] File      : ${originalName}`);
  console.log(`[upload] Temp path : ${localPath}`);
  console.log(`[upload] ID        : ${analysisId}`);

  try {
    // ── Step 1: Parse PDF ────────────────────────────────────────────────────
    let parsed;
    try {
      parsed = await parsePDF(localPath);
    } catch (parseErr) {
      console.error('[upload] PDF parse failed:', parseErr.message);
      deleteLocalFile(localPath);
      return res.status(422).json({
        success: false,
        message: parseErr.message.includes('Cannot parse PDF')
          ? parseErr.message
          : 'Could not extract text from this PDF. Ensure it is a valid, non-corrupted PDF.',
        detail: parseErr.message,
      });
    }

    // ── Guard: minimum usable content ────────────────────────────────────────
    if (parsed.wordCount < 30) {
      deleteLocalFile(localPath);
      console.warn(`[upload] Rejected: only ${parsed.wordCount} words extracted.`);
      return res.status(422).json({
        success: false,
        message:
          `Only ${parsed.wordCount} words could be extracted from this PDF. ` +
          'The file may be image-based (scanned without OCR), encrypted, or empty. ' +
          'If the file is scanned, install OCR support: npm install canvas tesseract.js',
        documentProfile: parsed.documentProfile,
      });
    }

    // ── Step 2: Index document chunks into Qdrant ────────────────────────────
    // Non-blocking: a Qdrant failure never aborts the analysis.
    try {
      const idxResult = await indexDocument(parsed, analysisId);
      if (idxResult.skipped) {
        console.log('[upload] Qdrant not configured — vector indexing skipped.');
      } else {
        console.log(`[upload] Qdrant: ${idxResult.indexed} chunks indexed in ${idxResult.elapsed}s`);
      }
    } catch (idxErr) {
      console.warn(`[upload] Qdrant indexing error (non-fatal): ${idxErr.message}`);
    }

    // ── Step 3: Analyse ──────────────────────────────────────────────────────
    let results;

    if (process.env.ANTHROPIC_API_KEY) {
      try {
        results = await analyzeWithClaude(parsed, analysisId);
        results.analysedBy = 'claude';
        console.log(`[upload] Claude analysis complete. ELEV score: ${results.elevScore}`);
      } catch (claudeErr) {
        const isTimeout    = claudeErr.code === 'CLAUDE_TIMEOUT' ||
                             claudeErr.message.toLowerCase().includes('timeout');
        const isConfigErr  = claudeErr.message.includes('API_KEY') ||
                             claudeErr.message.includes('401') ||
                             claudeErr.message.includes('403');

        if (isConfigErr) {
          deleteLocalFile(localPath);
          return res.status(503).json({
            success: false,
            message:
              'AI authentication failed. Check that ANTHROPIC_API_KEY is correct.',
            detail: claudeErr.message,
          });
        }

        if (isTimeout) {
          console.warn(`[upload] Claude timed out — switching to heuristic analysis (user still gets a result).`);
        } else {
          console.error(`[upload] Claude error (${claudeErr.message}) — switching to heuristic analysis.`);
        }

        results = normaliseHeuristic(runFullAnalysis(parsed), parsed);
        results.analysedBy    = 'heuristic';
        results.fallbackReason = isTimeout ? 'timeout' : 'error';
      }
    } else {
      console.warn('[upload] ANTHROPIC_API_KEY not set — using heuristic analysis.');
      results = normaliseHeuristic(runFullAnalysis(parsed), parsed);
      results.analysedBy = 'heuristic';
    }

    results.analysisId   = analysisId;
    results.originalFile = originalName;

    // Ensure documentProfile is present (Claude path already includes it)
    if (!results.documentProfile) {
      results.documentProfile = parsed.documentProfile;
    }

    // ── Step 4: Optionally upload PDF to Firebase Storage ────────────────────
    const storageUrl = await uploadToFirebaseStorage(localPath, req.file.filename);
    if (storageUrl) results.storageUrl = storageUrl;

    // ── Step 5: Persist to Firestore ─────────────────────────────────────────
    const db = getDb();
    if (db) {
      try {
        await db.collection('analyses').doc(analysisId).set(results);
      } catch (dbErr) {
        console.warn('[upload] Firestore save skipped:', dbErr.message);
      }
    }

    // ── Step 6: Cache & clean up ──────────────────────────────────────────────
    resultsCache.set(analysisId, results);
    setTimeout(() => resultsCache.delete(analysisId), 60 * 60 * 1000);
    if (storageUrl) deleteLocalFile(localPath);

    console.log(`[upload] ── Done ─────────────────────────────────\n`);
    return res.status(200).json({ success: true, ...results });

  } catch (err) {
    console.error('[upload] Unexpected error:', err);
    deleteLocalFile(localPath);
    return res.status(500).json({
      success: false,
      message: 'Analysis failed unexpectedly. Please try again.',
      detail:  err.message,
    });
  }
});

// ── GET /api/upload/:id  — retrieve cached/persisted result ──────────────────
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  if (resultsCache.has(id)) {
    return res.json({ success: true, ...resultsCache.get(id) });
  }

  const db = getDb();
  if (db) {
    try {
      const doc = await db.collection('analyses').doc(id).get();
      if (doc.exists) return res.json({ success: true, ...doc.data() });
    } catch (err) {
      console.warn('[upload/get] Firestore read error:', err.message);
    }
  }

  return res.status(404).json({ success: false, message: 'Analysis result not found.' });
});

// ── Multer error handler ──────────────────────────────────────────────────────
router.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, message: 'File too large. Maximum size is 20 MB.' });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ success: false, message: 'Only a single PDF file is accepted.' });
  }
  next(err);
});

// ── Heuristic → normalised shape adapter ─────────────────────────────────────
// Maps old analysisEngine.js output to the unified normalised shape that the
// frontend renderers depend on.  Used as a fallback when Claude is unavailable.

function normaliseHeuristic(h, parsed) {
  const struct  = h.structural || {};
  const cite    = h.citation   || {};
  const arg     = h.argument   || {};
  const integ   = h.integrity  || {};
  const sn      = struct.narrative || {};
  const cn      = cite.narrative   || {};
  const an      = arg.narrative    || {};
  const ign     = integ.narrative  || {};

  const sections = {};
  const KEYS = ['abstract','introduction','literatureReview','methodology','results','discussion','conclusion','references'];
  KEYS.forEach((key) => {
    const ss  = (struct.sectionScores || {})[key] || {};
    const det = ss.detailed || {};
    let quality = 'missing';
    if (ss.present && !ss.tooShort) quality = 'strong';
    else if (ss.present && ss.tooShort) quality = 'weak';
    sections[key] = {
      present:  !!ss.present,
      quality,
      feedback: det.statusMessage
        ? `${det.statusMessage} ${det.improvementTip || ''}`.trim()
        : (ss.present ? `${key} section detected.` : `No ${key} section detected.`),
    };
  });

  const risks = (integ.risks || []).map((r) => ({
    type:        r.type        || 'other',
    severity:    r.severity    || 'medium',
    title:       r.category    || r.type || 'Integrity Note',
    description: r.explanation || r.detail || '',
    resolution:  r.resolution  || '',
  }));

  const weaknesses = [];
  if ((arg.unsupportedClaims || 0) > 1) {
    weaknesses.push({
      title:       'Unsupported Claims',
      description: an.unsupportedClaimsAnalysis || `~${arg.unsupportedClaims} claims appear to lack supporting evidence.`,
      suggestion:  'Add a citation or reference to your own data immediately after each major claim.',
    });
  }

  const grade = toGrade;
  return {
    elevScore:        h.elevScore || 0,
    grade:            grade(h.elevScore || 0),
    overallNarrative: h.overallNarrative || sn.summary || '',
    overall: {
      topStrengths:    (sn.positives   || []).slice(0, 3),
      topImprovements: (sn.watchPoints || []).slice(0, 3),
    },
    document: {
      title:          h.document?.title || parsed?.metadata?.title || 'Uploaded Document',
      wordCount:      h.document?.wordCount || struct.wordCount || 0,
      charCount:      parsed?.charCount || 0,
      pageCount:      h.document?.pageCount || struct.pageCount || 1,
      citationFormat: h.document?.citationFormat || cite.citationFormat || 'Unknown',
    },
    documentProfile: parsed?.documentProfile || {},
    structural: {
      score:           struct.score || 0,
      grade:           grade(struct.score || 0),
      summary:         sn.summary || '',
      sections,
      flowAnalysis:    sn.flowAnalysis || '',
      recommendations: struct.recommendations || [],
    },
    citation: {
      score:             cite.score || 0,
      grade:             grade(cite.score || 0),
      summary:           cn.summary || '',
      formatDetected:    cite.citationFormat || 'Unknown',
      inTextCount:       cite.inTextCount || 0,
      densityAssessment: cn.densityAnalysis || '',
      qualityAssessment: cn.referenceListAnalysis || '',
      recencyAssessment: '',
      issues:            cn.watchPoints || [],
      recommendations:   cite.recommendations || [],
    },
    argument: {
      score:                   arg.score || 0,
      grade:                   grade(arg.score || 0),
      summary:                 an.summary || '',
      claimAnalysis:           an.claimAnalysis || '',
      evidenceAnalysis:        an.evidenceAnalysis || '',
      logicAnalysis:           an.logicAnalysis || '',
      counterArgumentAnalysis: an.counterArgumentAnalysis || '',
      weaknesses,
      recommendations:         arg.recommendations || [],
    },
    integrity: {
      score:            integ.score || 0,
      grade:            grade(integ.score || 0),
      riskLevel:        integ.riskLevel || 'low',
      summary:          ign.summary || '',
      risks,
      preventionAdvice: ign.preventionAdvice || '',
      recommendations:  integ.recommendations || [],
    },
  };
}

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

module.exports = router;
