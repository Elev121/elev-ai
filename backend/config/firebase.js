const admin = require('firebase-admin');
require('dotenv').config();

let db = null;

function initializeFirebase() {
  if (admin.apps.length > 0) {
    db = admin.firestore();
    return db;
  }

  const requiredVars = [
    'FIREBASE_PROJECT_ID',
    'FIREBASE_PRIVATE_KEY',
    'FIREBASE_CLIENT_EMAIL',
  ];

  const missing = requiredVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.warn(
      `[Firebase] Missing env vars: ${missing.join(', ')}. Running in demo mode.`
    );
    return null;
  }

  try {
    const serviceAccount = {
      type: 'service_account',
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID,
      auth_uri: process.env.FIREBASE_AUTH_URI,
      token_uri: process.env.FIREBASE_TOKEN_URI,
    };

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    db = admin.firestore();
    console.log('[Firebase] Initialized successfully.');
    return db;
  } catch (err) {
    console.error('[Firebase] Initialization error:', err.message);
    return null;
  }
}

function getDb() {
  if (!db) {
    return initializeFirebase();
  }
  return db;
}

module.exports = { initializeFirebase, getDb };
