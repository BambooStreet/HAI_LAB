import { put } from '@vercel/blob';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { send, isAdmin } from './_lib/http.js';
import { blobToken, hasBlob } from './_lib/store.js';

// Images arrive already resized by the admin page, as a raw application/octet-stream body.
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_BYTES = 4 * 1024 * 1024; // Vercel functions reject bodies over 4.5 MB
const LOCAL_DIR = join(tmpdir(), 'hai-lab-uploads');

async function readBuffer(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  // Local dev only: serve files saved without a Blob token.
  if (req.method === 'GET' && !process.env.VERCEL) {
    const name = String(new URL(req.url, 'http://x').searchParams.get('file') || '').replace(/[^a-z0-9.-]/gi, '');
    const ext = name.split('.').pop();
    const type = Object.keys(TYPES).find((t) => TYPES[t] === ext);
    try {
      const body = await readFile(join(LOCAL_DIR, name));
      res.setHeader('Content-Type', type || 'application/octet-stream');
      return res.end(body);
    } catch {
      return send(res, 404, { error: 'Not found' });
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Method not allowed' });
  }
  if (!isAdmin(req)) return send(res, 401, { error: '비밀번호가 올바르지 않습니다.' });

  const type = req.headers['x-image-type'];
  const ext = TYPES[type];
  if (!ext) return send(res, 400, { error: 'JPG, PNG, WEBP, GIF 이미지만 올릴 수 있어요.' });

  try {
    const buffer = await readBuffer(req);
    if (!buffer.length) return send(res, 400, { error: '빈 파일입니다.' });
    if (buffer.length > MAX_BYTES) return send(res, 413, { error: '사진이 너무 커요 (최대 4MB).' });

    const name = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;

    if (!hasBlob) {
      if (process.env.VERCEL) {
        return send(res, 503, { error: '사진 저장소가 연결되지 않았습니다. Vercel 프로젝트에 Blob을 연결해 주세요.' });
      }
      await mkdir(LOCAL_DIR, { recursive: true });
      await writeFile(join(LOCAL_DIR, name), buffer);
      return send(res, 200, { url: `http://${req.headers.host}/api/upload?file=${name}` });
    }

    const blob = await put(`hai/${name}`, buffer, { access: 'public', contentType: type, ...(blobToken && { token: blobToken }) });
    return send(res, 200, { url: blob.url });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: `사진을 올리지 못했습니다: ${err.message}` });
  }
}
