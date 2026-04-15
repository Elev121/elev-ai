const express = require('express');
const { getDb } = require('../config/firebase');

const router = express.Router();

// Static benchmark data comparing ELEV vs. traditional methods
const benchmarkData = {
  categories: [
    'Semantic Accuracy',
    'Citation Validity',
    'Plagiarism Detection',
    'Methodology Assessment',
    'Processing Speed',
    'Overall Score',
  ],
  methods: {
    ELEV: [92, 89, 96, 88, 95, 91],
    'Manual Review': [78, 82, 71, 80, 22, 71],
    'Turnitin Only': [55, 60, 94, 48, 85, 65],
    'iThenticate': [58, 65, 91, 52, 80, 67],
  },
  summary: {
    ELEV: {
      label: 'ELEV Framework',
      accuracy: '91%',
      avgProcessingTime: '< 3 minutes',
      citationCoverage: '89%',
      description: 'AI-powered multi-dimensional validation',
    },
    manual: {
      label: 'Traditional Manual Review',
      accuracy: '71%',
      avgProcessingTime: '3–7 days',
      citationCoverage: '82%',
      description: 'Human expert evaluation',
    },
  },
  publications: {
    totalValidated: 1248,
    acceptanceRate: '67%',
    avgElevScore: 74.3,
    disciplines: [
      { name: 'Computer Science', count: 312, avgScore: 77.1 },
      { name: 'Social Sciences', count: 287, avgScore: 72.4 },
      { name: 'Natural Sciences', count: 341, avgScore: 75.8 },
      { name: 'Engineering', count: 198, avgScore: 76.2 },
      { name: 'Humanities', count: 110, avgScore: 70.9 },
    ],
  },
};

// ─── GET /api/metrics ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const db = getDb();
  let liveStats = null;

  if (db) {
    try {
      const [feedbackSnap, validationSnap] = await Promise.all([
        db.collection('feedback').count().get(),
        db.collection('validations').count().get(),
      ]);
      liveStats = {
        totalFeedback: feedbackSnap.data().count,
        totalValidations: validationSnap.data().count,
      };
    } catch (err) {
      console.warn('[metrics] Firestore count error:', err.message);
    }
  }

  return res.json({
    success: true,
    benchmark: benchmarkData,
    liveStats,
    updatedAt: new Date().toISOString(),
  });
});

module.exports = router;
