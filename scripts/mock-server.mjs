#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend');
const port = Number(process.env.PORT || 8000);

const items = {
  ABC123: { item_id: 'ABC123', item_label: 'Blue water bottle', status: 'active' },
  XYZ789: { item_id: 'XYZ789', item_label: 'Laptop charger', status: 'active' },
  DISABLED: { item_id: 'DISABLED1', item_label: 'Old wallet', status: 'disabled' },
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);

  if (url.pathname.startsWith('/v1/')) {
    const getMatch = url.pathname.match(/^\/v1\/item\/([^/]+)\/?$/);
    if (req.method === 'GET' && getMatch) {
      const id = decodeURIComponent(getMatch[1]);
      const item = items[id];
      if (!item || item.status !== 'active') return sendJson(res, 404, { error: 'item not registered' });
      return sendJson(res, 200, { item_id: item.item_id, item_label: item.item_label, status: 'active' });
    }

    if (req.method === 'POST' && /^\/v1\/report\/?$/.test(url.pathname)) {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body' });
      }
      const contact = String(body.finder_contact || '');
      const message = String(body.message || '');
      if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(contact) && !/^\+?[0-9][0-9\s().-]{6,19}$/.test(contact)) {
        return sendJson(res, 400, { error: 'finder_contact must be a valid email or phone number' });
      }
      if (message.trim().length < 10) {
        return sendJson(res, 400, { error: 'message must be at least 10 characters' });
      }
      const item = items[String(body.item_id || '')];
      if (!item || item.status !== 'active') return sendJson(res, 404, { error: 'item not registered' });

      console.log('--- MOCK: email to owner of', body.item_id, '---');
      console.log(JSON.stringify({ from: contact, name: body.finder_name || '(not given)', message }, null, 2));
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  let filePath = path.normalize(path.join(frontendDir, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!filePath.startsWith(frontendDir)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(frontendDir, 'index.html'), (err2, index) => {
        if (err2) {
          res.writeHead(500);
          return res.end('mock server error');
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(index);
      });
      return;
    }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'content-type': types[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(port, () => {
  console.log(`Mock server on http://localhost:${port}`);
  console.log('Try: http://localhost:' + port + '/item/ABC123  (known), /item/UNKNOWN1 (404), /item/DISABLED1 (404)');
});
