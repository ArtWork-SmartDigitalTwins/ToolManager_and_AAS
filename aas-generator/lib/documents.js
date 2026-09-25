'use strict';

const dns = require('dns').promises;
const net = require('net');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');

async function extractPdfText(buffer) {
  const data = await pdfParse(buffer);
  return data.text;
}

async function extractDocxText(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function extractXlsxText(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const lines = [];
  wb.eachSheet((sheet) => {
    lines.push('--- Sheet: ' + sheet.name + ' ---');
    sheet.eachRow((row) => {
      const vals = row.values.slice(1).map((v) => {
        if (v == null) return '';
        if (typeof v === 'object' && v.text != null) return v.text;
        if (typeof v === 'object' && v.result != null) return String(v.result);
        return String(v);
      });
      if (vals.some((v) => v !== '')) lines.push(vals.join('\t'));
    });
  });
  return lines.join('\n');
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function isPrivateIp(ip) {
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    return lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd');
  }
  const parts = ip.split('.').map(Number);
  if (parts[0] === 127 || parts[0] === 10 || parts[0] === 0) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

async function assertPublicHost(hostname) {
  if (hostname === 'localhost') throw new Error('refusing to fetch a localhost URL');
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('refusing to fetch a private/internal address');
    return;
  }
  const addrs = await dns.lookup(hostname, { all: true });
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error('refusing to fetch a private/internal address');
  }
}

async function extractUrlText(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('only http/https URLs are supported');
  }
  await assertPublicHost(parsed.hostname);

  const resp = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!resp.ok) throw new Error('failed to fetch (HTTP ' + resp.status + ')');
  const contentType = resp.headers.get('content-type') || '';

  if (contentType.includes('application/pdf')) {
    const buf = Buffer.from(await resp.arrayBuffer());
    return extractPdfText(buf);
  }
  const html = await resp.text();
  return stripHtml(html);
}

async function extractDocument(file) {
  const name = (file.originalname || '').toLowerCase();
  if (name.endsWith('.pdf')) return extractPdfText(file.buffer);
  if (name.endsWith('.docx')) return extractDocxText(file.buffer);
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) return extractXlsxText(file.buffer);
  if (name.endsWith('.txt') || name.endsWith('.csv')) return file.buffer.toString('utf-8');
  throw new Error('unsupported document type: ' + file.originalname);
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_EXT_BY_CONTENT_TYPE = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/svg+xml': 'svg',
  'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/x-icon': 'ico'
};

// Downloads and validates a candidate image URL (e.g. one an LLM found via web search) so
// it can be embedded directly into the .aasx package - same SSRF guard as document URLs,
// plus a content-type check (must actually be an image) and a size cap.
async function downloadImage(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('only http/https URLs are supported');
  }
  await assertPublicHost(parsed.hostname);

  const resp = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!resp.ok) throw new Error('failed to fetch (HTTP ' + resp.status + ')');
  const contentType = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('image/')) {
    throw new Error('URL did not return an image (content-type: ' + (contentType || 'unknown') + ')');
  }
  const bytes = Buffer.from(await resp.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('image too large (' + Math.round(bytes.length / 1024 / 1024) + 'MB, limit ' + (MAX_IMAGE_BYTES / 1024 / 1024) + 'MB)');
  }
  const ext = IMAGE_EXT_BY_CONTENT_TYPE[contentType] || (parsed.pathname.split('.').pop() || 'bin').toLowerCase().slice(0, 5);
  return { bytes, contentType, ext };
}

module.exports = { extractDocument, extractUrlText, downloadImage };
