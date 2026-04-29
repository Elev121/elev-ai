/**
 * Novelty routes:
 *   POST /api/novelty-check      — check research problem novelty
 *   POST /api/generate-problems  — AI-generated research ideas
 *   GET  /api/scholar-search     — raw academic search proxy
 */

'use strict';

const express  = require('express');
const { body, query, validationResult } = require('express-validator');
const { checkNovelty, generateProblems } = require('../services/noveltyAnalyzer');
const { searchAcademic }                 = require('../services/academicSearch');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
}

// ── POST /api/novelty-check ───────────────────────────────────────────────────
router.post('/novelty-check', [
  body('problem').notEmpty().withMessage('problem is required').isLength({ max: 3000 }),
  body('title').optional().isLength({ max: 500 }),
  body('keywords').optional().isLength({ max: 500 }),
  body('field').optional().isLength({ max: 200 }),
  body('country').optional().isLength({ max: 100 }),
  body('methodology').optional().isLength({ max: 500 }),
], validate, async (req, res) => {
  try {
    const result = await checkNovelty(req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[novelty] check error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/generate-problems ───────────────────────────────────────────────
router.post('/generate-problems', [
  body('field').notEmpty().withMessage('field is required').isLength({ max: 200 }),
  body('interests').optional().isLength({ max: 500 }),
  body('country').optional().isLength({ max: 100 }),
  body('difficulty').optional().isIn(['Beginner', 'Intermediate', 'Advanced']),
  body('methodology').optional().isLength({ max: 200 }),
  body('count').optional().isInt({ min: 3, max: 6 }).toInt(),
], validate, async (req, res) => {
  try {
    const result = await generateProblems({ count: 5, ...req.body });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[novelty] generate error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/scholar-search?q= ────────────────────────────────────────────────
router.get('/scholar-search', [
  query('q').notEmpty().withMessage('q query param is required').isLength({ max: 300 }),
  query('limit').optional().isInt({ min: 1, max: 20 }).toInt(),
], validate, async (req, res) => {
  try {
    const limit  = req.query.limit || 10;
    const { papers, broadened } = await searchAcademic(req.query.q, limit);
    res.json({ success: true, papers, count: papers.length, broadened });
  } catch (err) {
    console.error('[novelty] scholar-search error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
