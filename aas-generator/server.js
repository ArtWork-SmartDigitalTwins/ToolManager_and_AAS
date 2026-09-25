'use strict';

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');

const { parseAasxTemplate, collectLeaves, collectShellLeaves, applyValue, applyShellValue, applyShellThumbnail, buildEmbeddedFilePath, buildAasxBuffer } = require('./lib/aasx');
const { extractDocument, extractUrlText, downloadImage } = require('./lib/documents');
const { extractAllValues } = require('./lib/extract');

const app = express();
// 15mb comfortably covers a base64-encoded upload up to the client's own 8MB image cap
// (base64 inflates by ~33%) plus room for the rest of a /api/generate values payload.
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 20 }
});

// In-memory session store: sessionId -> parsed template + supplementary files.
// Fine for a local single-user tool; sessions expire after an hour.
const sessions = new Map();
const extractJobs = new Map();
const SESSION_TTL_MS = 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
  for (const [id, job] of extractJobs) {
    if (job.status === 'done' || job.status === 'failed') {
      if (now - job.updatedAt > 5 * 60 * 1000) extractJobs.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

function updateExtractJob(jobId, patch) {
  if (!jobId) return null;
  const current = extractJobs.get(jobId) || { id: jobId, status: 'pending', total: 0, processed: 0, current: 'Starting extraction' };
  const next = { ...current, ...patch, updatedAt: Date.now() };
  if (typeof next.total === 'number' && next.total > 0) {
    next.percent = Math.min(100, Math.max(0, Math.round((next.processed / next.total) * 100)));
  } else if (typeof next.processed === 'number' && typeof next.total === 'number' && next.total === 0) {
    next.percent = 100;
  }
  extractJobs.set(jobId, next);
  return next;
}

app.post(
  '/api/extract',
  upload.fields([{ name: 'template', maxCount: 1 }, { name: 'documents' }]),
  async (req, res) => {
    try {
      const jobId = req.body.jobId || crypto.randomUUID();
      const templateFile = req.files.template && req.files.template[0];
      if (!templateFile) return res.status(400).json({ error: 'A template .aasx file is required.' });
      if (!/\.aasx$/i.test(templateFile.originalname)) {
        return res.status(400).json({ error: 'Template must be a .aasx file.' });
      }

      let parsed;
      try {
        parsed = parseAasxTemplate(templateFile.buffer);
      } catch (err) {
        return res.status(400).json({ error: 'Could not read the template package - ' + err.message + '.' });
      }
      if (!parsed.shells.length) {
        return res.status(400).json({ error: 'No Asset Administration Shell found in the template.' });
      }

      const docFiles = req.files.documents || [];
      let urls = [];
      try { urls = JSON.parse(req.body.urls || '[]'); } catch (_) { urls = []; }
      const assetName = (req.body.assetName || '').trim();
      const leaves = collectShellLeaves(parsed.shells).concat(collectLeaves(parsed.submodels));
      updateExtractJob(jobId, { status: 'in_progress', total: leaves.length, processed: 0, current: 'Preparing extraction' });

      const documents = [];
      for (const f of docFiles) {
        try {
          const text = await extractDocument(f);
          documents.push({ name: f.originalname, text, error: null });
        } catch (err) {
          documents.push({ name: f.originalname, text: '', error: err.message });
        }
      }
      for (const url of urls) {
        try {
          const text = await extractUrlText(url);
          documents.push({ name: url, text, error: null });
        } catch (err) {
          documents.push({ name: url, text: '', error: err.message });
        }
      }

      const usableDocuments = documents.filter((d) => d.text);
      const useWebSearch = req.body.useWebSearch === 'true';

      let extracted = [];
      let webSearchesUsed = 0;
      let extractError = null;
      let truncatedSubmodels = [];
      if (leaves.length && (usableDocuments.length || useWebSearch)) {
        try {
          const outcome = await extractAllValues(parsed.submodels, leaves, usableDocuments, useWebSearch, assetName, (progress) => {
            updateExtractJob(jobId, {
              status: 'in_progress',
              total: progress.total ?? leaves.length,
              processed: progress.processed ?? 0,
              current: progress.current || 'Extracting values'
            });
          });
          extracted = outcome.results;
          webSearchesUsed = outcome.searches;
          truncatedSubmodels = outcome.truncatedSubmodels || [];
          updateExtractJob(jobId, { status: 'done', total: leaves.length, processed: leaves.length, current: 'Extraction complete' });
        } catch (err) {
          extractError = err.message;
          updateExtractJob(jobId, { status: 'failed', total: leaves.length, processed: 0, current: 'Extraction failed' });
        }
      } else {
        updateExtractJob(jobId, { status: 'done', total: leaves.length, processed: leaves.length, current: 'No fields to extract' });
      }

      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, {
        shells: parsed.shells,
        submodels: parsed.submodels,
        conceptDescriptions: parsed.conceptDescriptions,
        files: parsed.files,
        createdAt: Date.now()
      });

      const byKey = new Map(extracted.map((e) => [e.key, e]));
      const leavesOut = leaves.map((l) => ({
        ...l,
        extracted: byKey.get(l.key) || { found: false, value: null, confidence: 'low', evidence: '' }
      }));

      const shellName = (parsed.shells[0].displayName && parsed.shells[0].displayName[0] && parsed.shells[0].displayName[0].text)
        || parsed.shells[0].idShort;

      res.json({
        sessionId,
        shellName,
        documents: documents.map((d) => ({ name: d.name, chars: d.text.length, error: d.error })),
        extractError,
        webSearchesUsed,
        truncatedSubmodels,
        leaves: leavesOut
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || 'Extraction failed.' });
    }
  }
);

app.get('/api/extract-progress/:jobId', (req, res) => {
  const job = extractJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: 'missing' });
  res.json(job);
});

const IMAGE_URL_RE = /^https?:\/\//i;
// A client-side file upload is read as a data: URL (see public/index.html's upload handler)
// rather than fetched over HTTP - same embed path as a downloaded image, just no network call.
const DATA_URL_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([a-zA-Z0-9+/=]+)$/i;
const IMAGE_EXT_BY_CONTENT_TYPE = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp'
};

app.post('/api/generate', async (req, res) => {
  try {
    const { sessionId, values } = req.body || {};
    const session = sessions.get(sessionId);
    if (!session) return res.status(400).json({ error: 'Session expired - please re-upload and extract again.' });

    const leaves = collectShellLeaves(session.shells).concat(collectLeaves(session.submodels));
    const byKey = new Map(leaves.map((l) => [l.key, l]));
    const newFiles = new Map();
    const imageWarnings = [];

    for (const v of values || []) {
      const leaf = byKey.get(v.key);
      if (!leaf) continue;

      // A File element whose value is an http(s) URL means "download and embed this image
      // into the package" (proposed by extraction, or pasted in manually); a data: URL means
      // "embed this image the user uploaded directly" - no network fetch needed, just decode
      // the base64 payload. Anything else (blank, or an existing package-internal path) is
      // passed straight through below. The AAS's own thumbnail (shell-scope, submodelIdx: -1)
      // is modeled as a File leaf too so it shares this same embed path, just applied via
      // applyShellThumbnail instead of applyValue.
      if (leaf.modelType === 'File' && typeof v.value === 'string') {
        const trimmed = v.value.trim();
        const dataMatch = DATA_URL_RE.exec(trimmed);
        const isRemoteUrl = IMAGE_URL_RE.test(trimmed);
        if (dataMatch || isRemoteUrl) {
          try {
            let bytes, contentType, ext;
            if (dataMatch) {
              contentType = dataMatch[1].toLowerCase();
              bytes = Buffer.from(dataMatch[2], 'base64');
              ext = IMAGE_EXT_BY_CONTENT_TYPE[contentType] || 'png';
            } else {
              ({ bytes, contentType, ext } = await downloadImage(trimmed));
            }
            const filePath = buildEmbeddedFilePath(leaf, ext);
            newFiles.set(filePath, bytes);
            if (leaf.submodelIdx === -1) applyShellThumbnail(session.shells, leaf, { path: '/' + filePath, contentType });
            else applyValue(session.submodels, leaf, { path: '/' + filePath, contentType });
          } catch (err) {
            imageWarnings.push((leaf.displayName || leaf.idShort) + ': ' + err.message);
            if (leaf.submodelIdx === -1) applyShellThumbnail(session.shells, leaf, null);
            else applyValue(session.submodels, leaf, null);
          }
          continue;
        }
      }

      if (leaf.submodelIdx === -1) {
        if (leaf.field === 'thumbnail') applyShellThumbnail(session.shells, leaf, v.value);
        else applyShellValue(session.shells, leaf, v.value);
        continue;
      }

      applyValue(session.submodels, leaf, v.value);
    }

    const combinedFiles = new Map(session.files);
    for (const [name, data] of newFiles) combinedFiles.set(name, data);

    const buffer = buildAasxBuffer({ shells: session.shells, submodels: session.submodels, conceptDescriptions: session.conceptDescriptions }, combinedFiles);
    const filename = (session.shells[0].idShort || 'aas-instance').replace(/[^a-z0-9_-]/gi, '_') + '.aasx';

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    if (imageWarnings.length) res.setHeader('X-Image-Warnings', encodeURIComponent(imageWarnings.join(' | ')));
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Generation failed.' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasApiKey: !!process.env.ANTHROPIC_API_KEY });
});

const PORT = process.env.PORT || 4100;
// Loopback only by default: avoids the Windows Firewall prompt and keeps the app off the network.
// Set HOST=0.0.0.0 to expose it (the Docker image does this).
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => console.log('AAS generator running at http://localhost:' + PORT));
