#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { parseCsv } from './lib/csv.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const csvPath = arg('csv', 'items.csv');
const baseUrl = (arg('base-url', '')).replace(/\/+$/, '');
const outDir = arg('out', 'stickers');
const format = arg('format', 'svg');
const withSheet = process.argv.includes('--sheet');

if (!baseUrl) {
  console.error('Usage: node scripts/generate-qr.mjs --base-url https://yourdomain.com [--csv items.csv] [--out stickers] [--format svg|png|both] [--sheet]');
  process.exit(1);
}
if (!/^https:\/\//.test(baseUrl)) {
  console.error('base-url must start with https://');
  process.exit(1);
}

const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
const items = rows
  .map((r) => ({ item_id: r.item_id, item_label: r.item_label || '' }))
  .filter((r) => r.item_id);

if (items.length === 0) {
  console.error(`No items found in ${csvPath}. Expected a header row with at least: item_id,item_label,owner_email`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

const stickers = [];
for (const { item_id, item_label } of items) {
  const url = `${baseUrl}/item/${encodeURIComponent(item_id)}`;
  const files = [];
  if (format === 'svg' || format === 'both') {
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    const file = path.join(outDir, `${item_id}.svg`);
    fs.writeFileSync(file, svg);
    files.push(file);
  }
  if (format === 'png' || format === 'both') {
    const file = path.join(outDir, `${item_id}.png`);
    await QRCode.toFile(file, url, { width: 512, margin: 2, errorCorrectionLevel: 'M' });
    files.push(file);
  }
  stickers.push({ item_id, item_label, url, files });
  console.log(`generated ${item_id} -> ${url}`);
}

if (withSheet) {
  const cells = [];
  for (const s of stickers) {
    const svg = await QRCode.toString(s.url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    cells.push(`
      <div class="sticker">
        <div class="qr">${svg}</div>
        <div class="caption"><strong>${escapeHtml(s.item_id)}</strong>${s.item_label ? `<br>${escapeHtml(s.item_label)}` : ''}<br>
        <span class="hint">Scan to contact the owner</span></div>
      </div>`);
  }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sticker sheet</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
  .sticker { border: 1px dashed #999; border-radius: 8px; padding: 12px; text-align: center; page-break-inside: avoid; }
  .qr svg { width: 160px; height: 160px; }
  .caption { margin-top: 8px; font-size: 14px; }
  .hint { color: #666; font-size: 12px; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
<h1>Sticker sheet (${stickers.length} stickers)</h1>
<div class="grid">
${cells}
</div>
</body>
</html>
`;

  const sheetPath = path.join(outDir, 'stickers-sheet.html');
  fs.writeFileSync(sheetPath, html);
  console.log(`print sheet -> ${sheetPath}`);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
