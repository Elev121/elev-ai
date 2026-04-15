const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/firebase');

const router = express.Router();

// In-memory fallback store when Firebase is not configured
const memoryStore = [];

// ─── POST /api/feedback ───────────────────────────────────────────────────────
router.post(
  '/',
  [
    body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 100 }),
    body('email').trim().isEmail().withMessage('Valid email is required').normalizeEmail(),
    body('institution').trim().optional().isLength({ max: 200 }),
    body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be 1–5'),
    body('feedback').trim().notEmpty().withMessage('Feedback message is required').isLength({ max: 2000 }),
    body('useCase').trim().optional().isLength({ max: 100 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { name, email, institution, rating, feedback, useCase } = req.body;

    const entry = {
      id: uuidv4(),
      name,
      email,
      institution: institution || null,
      rating: parseInt(rating, 10),
      feedback,
      useCase: useCase || null,
      createdAt: new Date().toISOString(),
    };

    const db = getDb();

    if (db) {
      try {
        await db.collection('feedback').doc(entry.id).set(entry);
      } catch (err) {
        console.error('[feedback] Firestore write error:', err.message);
        return res.status(500).json({ success: false, message: 'Database error. Please try again.' });
      }
    } else {
      // Demo mode — store in memory
      memoryStore.push(entry);
    }

    return res.status(201).json({
      success: true,
      message: 'Thank you for your feedback!',
      id: entry.id,
    });
  }
);

// ─── GET /api/feedback ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

  if (db) {
    try {
      const snapshot = await db
        .collection('feedback')
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();

      const items = snapshot.docs.map((doc) => {
        const data = doc.data();
        // Omit email for public listing
        const { email, ...safe } = data;
        return safe;
      });

      return res.json({ success: true, count: items.length, items });
    } catch (err) {
      console.error('[feedback] Firestore read error:', err.message);
      return res.status(500).json({ success: false, message: 'Database error.' });
    }
  }

  // Demo mode
  const items = memoryStore
    .slice(-limit)
    .reverse()
    .map(({ email, ...safe }) => safe);

  return res.json({ success: true, count: items.length, items });
});

module.exports = router;
