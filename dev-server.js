// Local preview without the Vercel CLI: serves static files (with clean URLs) and /api/* handlers.
// Data is kept in memory unless DATABASE_URL (Neon) is set.
// Usage: npm run dev        in-memory data, nothing to set up
//        npm run dev:live   the real Neon/Blob from .env.local (npx vercel env pull)
//                           — this reads and writes production data
// Set ADMIN_PASSWORD=... to require a password for /admin.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT) || 3000;

// `vercel env pull --environment=production` also writes VERCEL=1, which would make the API think
// it runs on Vercel and refuse to fall back to in-memory data. This is a local server; it doesn't.
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname.startsWith('/api/')) {
    const name = pathname.slice(5).replace(/[^a-z0-9-]/gi, '');
    try {
      const { default: handler } = await import(pathToFileURL(join(root, 'api', `${name}.js`)).href);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      // Mirror Vercel: JSON bodies are parsed, everything else stays a Buffer.
      req.body = !raw.length ? undefined : (req.headers['content-type'] || '').includes('json') ? JSON.parse(raw) : raw;
      return await handler(req, res);
    } catch (err) {
      res.statusCode = err.code === 'ERR_MODULE_NOT_FOUND' ? 404 : 500;
      return res.end(String(err.message));
    }
  }

  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const candidates = extname(rel) ? [rel] : [`${rel}.html`, join(rel, 'index.html')];
  for (const file of candidates) {
    const path = normalize(join(root, file));
    if (!path.startsWith(root)) break;
    try {
      const body = await readFile(path);
      res.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream');
      return res.end(body);
    } catch {}
  }
  res.statusCode = 404;
  res.end('Not found');
}).listen(port, () => {
  const live = Object.entries(process.env).some(([k, v]) => /DATABASE_URL|POSTGRES_URL/.test(k) && /^postgres/.test(v || ''));
  console.log(`HAI LAB dev server: http://localhost:${port}  (/admin password: ${process.env.ADMIN_PASSWORD ? 'set' : 'none'})`);
  console.log(live ? '데이터: 실제 Neon DB (여기서 고치면 운영 사이트에도 반영됩니다)' : '데이터: 메모리 (서버를 끄면 사라집니다)');
});
