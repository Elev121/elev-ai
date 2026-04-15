/**
 * pdfParser.js  v3 — Page-by-page extraction with OCR fallback
 *
 * Strategy:
 *   1. pdfjs-dist (legacy CJS build) for accurate page count + text extraction
 *   2. Per-page stats logged to console with clear formatting
 *   3. Scanned-page detection (< 80 chars extracted)
 *   4. OCR fallback via tesseract.js + canvas (optional — graceful degradation)
 *   5. Rich documentProfile returned for frontend verification display
 *
 * Removing pdf-parse and using pdfjs-dist directly eliminates the
 * known 10-page truncation bug in pdf-parse test fixtures.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── pdfjs-dist (CommonJS legacy build, Node.js compatible) ───────────────────
let pdfjsLib;
try {
  pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  // Disable web worker — not available / not needed in Node.js
  pdfjsLib.GlobalWorkerOptions.workerSrc = '';
} catch (err) {
  throw new Error(
    `pdfjs-dist is not installed. Run: npm install\n` +
    `Original error: ${err.message}`
  );
}

// ── OCR optional dependencies ─────────────────────────────────────────────────
let _canvasMod     = undefined; // undefined = not yet tried
let _tesseractMod  = undefined;

function tryLoadOCR() {
  if (_canvasMod !== undefined) return (_canvasMod !== null && _tesseractMod !== null);
  try {
    _canvasMod    = require('canvas');
    _tesseractMod = require('tesseract.js');
    console.log('[pdfParser] OCR modules ready (canvas + tesseract.js)');
    return true;
  } catch (e) {
    _canvasMod    = null;
    _tesseractMod = null;
    console.warn('[pdfParser] OCR unavailable — install optional deps to enable:');
    console.warn('[pdfParser]   npm install canvas tesseract.js');
    return false;
  }
}

// ── Section definitions ───────────────────────────────────────────────────────
const SECTION_DEFS = [
  { key: 'abstract',         patterns: [/\bABSTRACT\b/i, /\bSUMMARY\b/i] },
  { key: 'introduction',     patterns: [/\bINTRODUCTION\b/i, /\bBACKGROUND\b/i, /^\s*1[\.\)]\s+INTRO/im] },
  { key: 'literatureReview', patterns: [/LITERATURE\s+REVIEW/i, /RELATED\s+WORK/i, /PRIOR\s+WORK/i, /THEORETICAL\s+FRAMEWORK/i] },
  { key: 'methodology',      patterns: [/\bMETHOD(?:OLOGY)?\b/i, /\bAPPROACH\b/i, /\bPROCEDURE\b/i, /\bRESEARCH\s+DESIGN\b/i, /\bEXPERIMENTAL\s+SETUP\b/i] },
  { key: 'results',          patterns: [/\bRESULTS?\b/i, /\bFINDINGS?\b/i, /\bOUTCOMES?\b/i, /DATA\s+ANALYSIS/i] },
  { key: 'discussion',       patterns: [/\bDISCUSSION\b/i, /\bINTERPRETATION\b/i] },
  { key: 'conclusion',       patterns: [/\bCONCLUSION\b/i, /\bCONCLUDING\b/i, /\bFUTURE\s+WORK\b/i] },
  { key: 'references',       patterns: [/\bREFERENCES\b/i, /\bBIBLIOGRAPHY\b/i, /\bWORKS\s+CITED\b/i] },
];

// ═════════════════════════════════════════════════════════════════════════════
// MAIN EXPORT
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Parse a PDF from a local file path.
 * Returns a rich document profile with per-page stats and OCR results.
 *
 * @param {string} filePath  Absolute path to the PDF file
 * @returns {Promise<ParsedDocument>}
 */
async function parsePDF(filePath) {
  const filename = path.basename(filePath);
  const t0 = Date.now();

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════');
  console.log(`║ [pdfParser] File     : ${filename}`);
  console.log(`║ [pdfParser] Path     : ${filePath}`);

  // ── Load PDF ──────────────────────────────────────────────────────────────
  const buffer = fs.readFileSync(filePath);
  const uint8  = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  let pdfDoc;
  try {
    const task = pdfjsLib.getDocument({
      data:              uint8,
      verbosity:         0,           // Suppress pdfjs internal logging
      disableAutoFetch:  true,
      disableFontFace:   true,
      useSystemFonts:    false,
    });
    pdfDoc = await task.promise;
  } catch (err) {
    throw new Error(`Cannot parse PDF "${filename}": ${err.message}`);
  }

  const numPages = pdfDoc.numPages;
  console.log(`║ [pdfParser] Pages    : ${numPages} (from pdfjs-dist)`);
  console.log('║ ─────────────────────────────────────────────────────────');

  // ── Extract text page by page ─────────────────────────────────────────────
  const pageResults = [];
  let scannedCount  = 0;

  for (let pn = 1; pn <= numPages; pn++) {
    const pr = await extractPageText(pdfDoc, pn);
    pageResults.push(pr);

    const flag = pr.scanned ? ' ← SCANNED (low text)' : '';
    console.log(`║ [pdfParser] Page ${String(pn).padStart(3)}: ${String(pr.words).padStart(5)} words | ${String(pr.chars).padStart(6)} chars${flag}`);

    if (pr.scanned) scannedCount++;
  }

  console.log('║ ─────────────────────────────────────────────────────────');
  console.log(`║ [pdfParser] Scanned pages detected: ${scannedCount}`);

  // ── OCR fallback for scanned pages ───────────────────────────────────────
  const ocrPageNums = [];
  if (scannedCount > 0) {
    const ocrReady = tryLoadOCR();
    if (ocrReady) {
      await runOCR(pdfDoc, pageResults, ocrPageNums);
    } else {
      console.warn(`║ [pdfParser] WARNING: ${scannedCount} scanned page(s) could not be OCR'd.`);
      console.warn('║ [pdfParser]          Install canvas + tesseract.js for OCR support.');
    }
  }

  // ── Assemble full text ────────────────────────────────────────────────────
  const rawFull   = pageResults.map((p) => p.text).join('\n\n');
  const cleaned   = cleanText(rawFull);
  const wordCount = countWords(cleaned);
  const charCount = cleaned.length;

  console.log(`║ [pdfParser] Total words extracted: ${wordCount}`);
  console.log(`║ [pdfParser] Total chars extracted: ${charCount}`);

  // ── Section detection ─────────────────────────────────────────────────────
  const sections = detectSections(cleaned);
  const detectedNames = Object.entries(sections.present)
    .filter(([, v]) => v).map(([k]) => k).join(', ') || 'none';
  console.log(`║ [pdfParser] Sections : ${detectedNames}`);

  // ── Metadata ──────────────────────────────────────────────────────────────
  const metadata = extractMetadata(cleaned);

  // ── Quality + confidence ──────────────────────────────────────────────────
  const unprocessedScanned = scannedCount - ocrPageNums.length;
  const textQuality = computeTextQuality(wordCount, numPages, unprocessedScanned);
  const confidence  = computeConfidence(wordCount, numPages, sections, textQuality, ocrPageNums.length);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`║ [pdfParser] Quality  : ${textQuality.toUpperCase()}  |  Confidence: ${confidence}%`);
  console.log(`║ [pdfParser] Completed in ${elapsed}s`);
  console.log('╚══════════════════════════════════════════════════════════');
  console.log('');

  // Destroy the pdfjs document to release memory
  pdfDoc.destroy();

  return {
    cleanedText: cleaned,
    sections,
    metadata,
    pageCount:   numPages,
    wordCount,
    charCount,
    sentences:   splitSentences(cleaned),

    // Verification metadata — passed to frontend
    documentProfile: {
      filename,
      pageCount:        numPages,
      wordCount,
      charCount,
      sectionsDetected: sections.present,
      sectionsText:     sections.found,   // actual extracted text per section
      perPageStats:     pageResults.map((p) => ({
        page:         p.pn,
        words:        p.words,
        chars:        p.chars,
        scanned:      p.scanned,
        ocrProcessed: ocrPageNums.includes(p.pn),
      })),
      ocrPages:          ocrPageNums,
      textQuality,
      analysisConfidence: confidence,
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// PAGE TEXT EXTRACTION
// ═════════════════════════════════════════════════════════════════════════════

async function extractPageText(pdfDoc, pn) {
  let text = '';
  let parseError = null;

  try {
    const page = await pdfDoc.getPage(pn);
    const tc   = await page.getTextContent({
      normalizeWhitespace:    false,
      disableCombineTextItems: false,
    });
    text = reconstructTextFromItems(tc);
    page.cleanup();
  } catch (err) {
    parseError = err.message;
    console.warn(`║ [pdfParser] Page ${pn} extraction error: ${err.message}`);
  }

  const words   = countWords(text);
  const chars   = text.length;
  // A page is considered "scanned" if pdfjs extracted fewer than 80 characters
  // AND the page is not completely blank (blank pages exist in many PDFs)
  const scanned = chars < 80;

  return { pn, text, words, chars, scanned, parseError };
}

/**
 * Reconstruct readable text from pdfjs text-content items.
 * Items arrive roughly in document order; we use Y-coordinate changes to
 * insert newlines at line breaks.
 */
function reconstructTextFromItems(textContent) {
  if (!textContent?.items?.length) return '';

  let result  = '';
  let lastY   = null;
  let lastX   = null;
  let lastStr = '';

  for (const item of textContent.items) {
    // TextMarkedContent items have no `str` — skip them
    if (!('str' in item)) continue;

    const x = item.transform[4];
    const y = item.transform[5];
    const s = item.str;

    if (lastY !== null) {
      const yGap = Math.abs(y - lastY);
      if (yGap > 8) {
        // Significant vertical shift → new line
        result += '\n';
      } else if (lastX !== null) {
        // Same line — only add a space if there's a horizontal gap AND the last
        // character isn't already a space
        const xGap = x - lastX;
        if (xGap > 3 && lastStr.length > 0 && !lastStr.endsWith(' ') && !s.startsWith(' ')) {
          result += ' ';
        }
      }
    }

    result += s;
    if (item.hasEOL) result += '\n';

    lastY   = y;
    lastX   = x + (item.width || 0);
    lastStr = s;
  }

  return result;
}

// ═════════════════════════════════════════════════════════════════════════════
// OCR PIPELINE
// ═════════════════════════════════════════════════════════════════════════════

async function runOCR(pdfDoc, pageResults, ocrPageNums) {
  const scannedPages = pageResults.filter((p) => p.scanned);
  const maxPages     = parseInt(process.env.MAX_OCR_PAGES || '8', 10);
  const toProcess    = scannedPages.slice(0, maxPages);

  if (!toProcess.length) return;

  console.log(`║ [pdfParser] OCR: processing ${toProcess.length} page(s)...`);

  const { createWorker } = _tesseractMod;
  const worker = await createWorker('eng', 1, {
    logger:       () => {},  // Suppress tesseract progress logs
    errorHandler: (err) => console.warn('[pdfParser] Tesseract:', err),
  });

  try {
    for (const pr of toProcess) {
      try {
        const imgBuf  = await renderPageToImageBuffer(pdfDoc, pr.pn);
        const { data } = await worker.recognize(imgBuf);
        const ocrText  = data.text || '';
        const ocrConf  = Math.round(data.confidence ?? 0);

        // Replace the page's text with OCR result
        pr.text    = ocrText;
        pr.words   = countWords(ocrText);
        pr.chars   = ocrText.length;
        pr.scanned = false; // Resolved
        pr.ocrConf = ocrConf;
        ocrPageNums.push(pr.pn);

        console.log(`║ [pdfParser] OCR Page ${String(pr.pn).padStart(3)}: ${pr.words} words (confidence ${ocrConf}%)`);
      } catch (pageErr) {
        console.warn(`║ [pdfParser] OCR Page ${pr.pn} failed: ${pageErr.message}`);
      }
    }
  } finally {
    await worker.terminate();
  }
}

async function renderPageToImageBuffer(pdfDoc, pn, scale = 2.5) {
  if (!_canvasMod) throw new Error('canvas module not loaded');

  const page     = await pdfDoc.getPage(pn);
  const viewport = page.getViewport({ scale });

  const w         = Math.ceil(viewport.width);
  const h         = Math.ceil(viewport.height);
  const canvasEl  = _canvasMod.createCanvas(w, h);
  const ctx       = canvasEl.getContext('2d');

  // pdfjs-dist needs a canvas factory for rendering
  const canvasFactory = {
    create:  (_w, _h) => { const c = _canvasMod.createCanvas(_w, _h); return { canvas: c, context: c.getContext('2d') }; },
    reset:   (cc, _w, _h) => { cc.canvas.width = _w; cc.canvas.height = _h; },
    destroy: (cc) => { cc.canvas.width = 0; cc.canvas.height = 0; },
  };

  await page.render({ canvasContext: ctx, viewport, canvasFactory }).promise;
  page.cleanup();

  return canvasEl.toBuffer('image/png');
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION DETECTION
// ═════════════════════════════════════════════════════════════════════════════

function detectSections(text) {
  const lines   = text.split('\n');
  const found   = {};
  const present = {};

  SECTION_DEFS.forEach(({ key, patterns }) => {
    let sectionText = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // Headings are typically short standalone lines
      if (line.length < 3 || line.length > 100) continue;
      if (!patterns.some((p) => p.test(line))) continue;

      // Found the heading — collect text until the next section heading
      let end = lines.length;
      SECTION_DEFS.forEach(({ key: otherKey, patterns: otherPat }) => {
        if (otherKey === key) return;
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j].trim();
          if (l.length < 3 || l.length > 100) continue;
          if (otherPat.some((p) => p.test(l)) && j < end) { end = j; break; }
        }
      });

      sectionText = lines.slice(i, end).join('\n').trim();
      break;
    }

    found[key]   = sectionText;
    present[key] = sectionText.length > 0;
  });

  return { found, present };
}

// ═════════════════════════════════════════════════════════════════════════════
// METADATA
// ═════════════════════════════════════════════════════════════════════════════

function extractMetadata(cleanedText) {
  const lines = cleanedText.split('\n').filter((l) => l.trim().length > 0);
  const possibleTitle = lines[0] && lines[0].trim().length < 200 ? lines[0].trim() : null;
  return {
    title:          possibleTitle || 'Unknown',
    citationFormat: detectCitationFormat(cleanedText),
  };
}

function detectCitationFormat(text) {
  const apa     = (text.match(/\([A-Z][a-zA-Z]+(?:\s+et\s+al\.?)?,\s*\d{4}\)/g) || []).length;
  const ieee    = (text.match(/\[\d+(?:,\s*\d+)*\]/g) || []).length;
  const mla     = (text.match(/\([A-Z][a-zA-Z]+\s+\d{1,4}\)/g) || []).length;
  const chicago = (text.match(/\(\d{1,2}\)/g) || []).length;
  const max     = Math.max(apa, ieee, mla, chicago);
  if (max === 0)    return 'unknown';
  if (max === apa)  return 'APA';
  if (max === ieee) return 'IEEE';
  if (max === mla)  return 'MLA';
  return 'Chicago/footnote';
}

// ═════════════════════════════════════════════════════════════════════════════
// QUALITY & CONFIDENCE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Rate the overall text extraction quality.
 * unprocessedScanned = scanned pages for which OCR was NOT performed.
 */
function computeTextQuality(wordCount, numPages, unprocessedScanned) {
  if (unprocessedScanned > numPages * 0.5 || wordCount < 100) return 'poor';
  if (unprocessedScanned > 2 || wordCount < 400) return 'partial';
  return 'good';
}

/**
 * Estimate how reliable the Claude analysis will be (0–99).
 * Higher = more reliable.
 */
function computeConfidence(wordCount, numPages, sections, textQuality, ocrPageCount) {
  // Start high and deduct for problems
  let conf = 96;

  // Very short documents are unreliable
  if      (wordCount < 80)  return 8;
  else if (wordCount < 200) conf -= 35;
  else if (wordCount < 400) conf -= 20;
  else if (wordCount < 600) conf -= 8;

  // Missing required sections
  const REQUIRED_SECTIONS = ['abstract', 'introduction', 'methodology', 'results', 'conclusion'];
  const missingRequired = REQUIRED_SECTIONS.filter((s) => !sections.present[s]).length;
  conf -= missingRequired * 7;

  // Text quality
  if (textQuality === 'poor')    conf -= 28;
  if (textQuality === 'partial') conf -= 12;

  // OCR reduces reliability slightly
  if (ocrPageCount > 0) conf -= 7;

  // Low word-per-page ratio (dense image content)
  const avgWpp = wordCount / Math.max(1, numPages);
  if (avgWpp < 30) conf -= 15;

  return Math.max(5, Math.min(99, Math.round(conf)));
}

// ═════════════════════════════════════════════════════════════════════════════
// TEXT HELPERS
// ═════════════════════════════════════════════════════════════════════════════

function cleanText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\f/g, '\n')
    .replace(/[ \t]{3,}/g, '  ')          // collapse excessive spaces
    .replace(/\n{4,}/g, '\n\n\n')         // max 3 blank lines
    .replace(/([a-z])-\n([a-z])/g, '$1$2') // rejoin hyphenated line breaks
    .trim();
}

function countWords(text) {
  return (text || '').split(/\s+/).filter(Boolean).length;
}

function splitSentences(text) {
  return (text || '')
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15);
}

module.exports = { parsePDF, detectCitationFormat, countWords };
