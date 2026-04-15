/**
 * storage.js
 * Multer configuration for PDF uploads.
 * Uses local disk storage as the primary store and optionally
 * syncs to Firebase Storage when credentials are available.
 */

const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');

// Ensure the local uploads directory exists
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ── Disk storage ──────────────────────────────────────────────────
const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req,  file, cb) => {
    const ext      = path.extname(file.originalname).toLowerCase();
    const safeName = `${uuidv4()}${ext}`;
    cb(null, safeName);
  },
});

// ── File filter: PDF only ─────────────────────────────────────────
function fileFilter(_req, file, cb) {
  const allowedMimes = ['application/pdf'];
  const allowedExts  = ['.pdf'];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedMimes.includes(file.mimetype) && allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only PDF files are accepted.'));
  }
}

// ── Multer instance ───────────────────────────────────────────────
const upload = multer({
  storage: diskStorage,
  fileFilter,
  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MB
    files:    1,
  },
});

// ── Optional: Firebase Storage upload ────────────────────────────
async function uploadToFirebaseStorage(localPath, filename) {
  const admin = require('firebase-admin');
  if (!admin.apps.length) return null;

  try {
    const bucket = admin.storage().bucket();
    const dest   = `uploads/${filename}`;
    await bucket.upload(localPath, { destination: dest, public: false });
    const [url] = await bucket.file(dest).getSignedUrl({
      action:  'read',
      expires: Date.now() + 60 * 60 * 1000, // 1 hour
    });
    return url;
  } catch (err) {
    console.warn('[storage] Firebase Storage upload skipped:', err.message);
    return null;
  }
}

// ── Cleanup local file ────────────────────────────────────────────
function deleteLocalFile(filePath) {
  try { fs.unlinkSync(filePath); } catch (_) {}
}

module.exports = { upload, uploadToFirebaseStorage, deleteLocalFile, UPLOAD_DIR };
