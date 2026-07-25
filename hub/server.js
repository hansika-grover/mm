// MetaManager hub — dependency-free HTTP server (Node built-in http).
// Serves the dashboard + the ingest/query API. No Express, no npm installs.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

// Load a local .env file (KEY=VALUE per line) BEFORE requiring ./db, which reads
// DATABASE_URL at import time. Lets you keep the cloud DB URL in a file instead of
// juggling shell environment variables. No dependency.
for (const p of [path.join(__dirname, '..', '.env'), path.join(process.cwd(), '.env')]) {
  try {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
    break; // use the first .env found
  } catch { /* no .env here — fine */ }
}

const store = require('./db');

const PORT = Number(process.env.PORT || 5051);
// bind all interfaces when running on a host (Render sets DATABASE_URL); loopback locally
const HOST = process.env.HOST || (process.env.DATABASE_URL ? '0.0.0.0' : '127.0.0.1');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};

function readBody(req, limitBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  // prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback -> index.html
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); res.end('not found'); }
        else { res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(idx); }
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname, query } = url.parse(req.url, true);
  // CORS: let the browser extension (and any hosted dashboard) call the API cross-origin.
  // The extension's POST of asset dumps is a preflighted request, so answer OPTIONS too.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  try {
    // ---- API ----
    if (pathname === '/api/summary' && req.method === 'GET')
      return json(res, 200, await store.summary());

    if (pathname === '/api/tree' && req.method === 'GET')
      return json(res, 200, { profiles: await store.tree() });

    if (pathname === '/api/search' && req.method === 'GET')
      return json(res, 200, { results: await store.search(query.q || '') });

    if (pathname === '/api/list' && req.method === 'GET')
      return json(res, 200, { type: query.type || '', rows: await store.list(query.type || '') });

    if (pathname === '/api/changes' && req.method === 'GET')
      return json(res, 200, { changes: await store.changes(Number(query.limit) || 100,
        query.type && query.id ? { type: query.type, id: query.id } : null) });

    if (pathname === '/api/sessions' && req.method === 'GET')
      return json(res, 200, { sessions: await store.sessions() });

    if (pathname === '/api/session-clear' && req.method === 'POST') {
      const raw = await readBody(req);
      let b = {}; try { b = raw ? JSON.parse(raw) : {}; } catch {}
      return json(res, 200, await store.clearSession(b.source_label || '*'));
    }

    if (pathname === '/api/session-status' && req.method === 'POST') {
      const raw = await readBody(req);
      let s; try { s = JSON.parse(raw); } catch { return json(res, 400, { error: 'invalid JSON' }); }
      try { return json(res, 200, await store.reportSession(s)); }
      catch (e) { return json(res, 400, { error: String(e.message || e) }); }
    }

    if (pathname === '/api/lookup' && req.method === 'GET') {
      if (!query.type || !query.id) return json(res, 400, { error: 'type and id required' });
      const r = await store.lookup(query.type, query.id);
      return r ? json(res, 200, r) : json(res, 404, { error: 'not found' });
    }

    if (pathname === '/api/ingest' && req.method === 'POST') {
      const raw = await readBody(req);
      let dump;
      try { dump = JSON.parse(raw); } catch { return json(res, 400, { error: 'invalid JSON' }); }
      // accept a single dump, or {dumps:[...]} / an array for batch ingest
      const dumps = Array.isArray(dump) ? dump : (Array.isArray(dump.dumps) ? dump.dumps : [dump]);
      const results = [];
      for (const d of dumps) {
        try { results.push({ ok: true, ...(await store.ingest(d, { sourceLabel: d.sourceLabel })) }); }
        catch (e) { results.push({ ok: false, error: String(e.message || e) }); }
      }
      const ok = results.every((r) => r.ok);
      return json(res, ok ? 200 : 207, { ingested: results.length, results });
    }

    if (pathname === '/api/reset' && req.method === 'POST') {
      await store.reset();
      return json(res, 200, { ok: true });
    }

    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'no such endpoint' });

    // ---- static dashboard ----
    return serveStatic(req, res, pathname);
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
});

store.init().then((info) => {
  server.listen(PORT, HOST, () => {
    console.log(`\n  MetaManager hub  →  http://${HOST}:${PORT}`);
    console.log(`  database   →  ${info.kind}: ${store.DB_PATH}`);
    console.log(`  ingest     →  POST http://${HOST}:${PORT}/api/ingest  (asset-dump.json)\n`);
  });
}).catch((e) => {
  console.error('\n  failed to start MetaManager hub:', e.message || e, '\n');
  process.exit(1);
});
