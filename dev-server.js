// Local preview without the Vercel CLI: serves static files (with clean URLs) and /api/* handlers.
// Data is kept in memory unless KV_REST_API_URL / KV_REST_API_TOKEN are set.
// Usage: ADMIN_PASSWORD=test npm run dev
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT) || 3000;
process.env.ADMIN_PASSWORD ||= 'admin';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname.startsWith('/api/')) {
    const name = pathname.slice(5).replace(/[^a-z0-9-]/gi, '');
    try {
      const { default: handler } = await import(pathToFileURL(join(root, 'api', `${name}.js`)).href);
      let raw = '';
      for await (const chunk of req) raw += chunk;
      req.body = raw ? JSON.parse(raw) : undefined;
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
  console.log(`HAI LAB dev server: http://localhost:${port}  (admin password: ${process.env.ADMIN_PASSWORD})`);
});
