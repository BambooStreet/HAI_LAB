import { put, issueSignedToken, presignUrl } from '@vercel/blob';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { send, isAdmin, readBody } from './_lib/http.js';
import { blobToken, hasBlob } from './_lib/store.js';

// Images arrive already resized by the admin page, as a raw application/octet-stream body.
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
// Videos are too big for a function body (4.5 MB), so the browser uploads them straight to Blob
// with a presigned PUT URL this route hands out. The URL itself caps the type and the size.
const VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
const VIDEO_MAX_BYTES = 300 * 1024 * 1024;
const MAX_BYTES = 4 * 1024 * 1024; // Vercel functions reject bodies over 4.5 MB
const LOCAL_DIR = join(tmpdir(), 'hai-lab-uploads');

// A read-write token looks like vercel_blob_rw_<storeId>_<secret>; the public URL needs the store id.
const storeId = () => process.env.BLOB_STORE_ID || blobToken.split('_')[3] || '';

async function presignVideo(req, res) {
  const body = readBody(req);
  const type = String(body.type || '');
  const size = Number(body.size) || 0;
  const ext = VIDEO_TYPES[type];
  if (!ext) return send(res, 400, { error: 'MP4, WebM, MOV 동영상만 올릴 수 있어요.' });
  if (size > VIDEO_MAX_BYTES) {
    return send(res, 413, { error: `동영상이 너무 커요 (최대 ${VIDEO_MAX_BYTES / 1024 / 1024}MB).` });
  }
  if (!hasBlob) {
    return send(res, 503, {
      error: process.env.VERCEL
        ? '동영상 저장소가 연결되지 않았습니다. Vercel 프로젝트에 Blob을 연결해 주세요.'
        : '동영상 업로드는 배포된 사이트에서만 됩니다 (로컬에는 Blob 저장소가 없어요).',
    });
  }

  const pathname = `hai/${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
  const limits = { allowedContentTypes: [type], maximumSizeInBytes: VIDEO_MAX_BYTES };
  const token = await issueSignedToken({
    pathname,
    operations: ['put'],
    validUntil: Date.now() + 60 * 60 * 1000, // an hour: big files upload slowly on lab wifi
    ...limits,
    ...(blobToken && { token: blobToken }),
  });
  const { presignedUrl } = await presignUrl(token, {
    operation: 'put',
    pathname,
    access: 'public',
    addRandomSuffix: false, // the pathname is already unique, and we need to know the final URL
    allowOverwrite: false,
    cacheControlMaxAge: 365 * 24 * 60 * 60,
    ...limits,
  });
  return send(res, 200, {
    uploadUrl: presignedUrl,
    url: `https://${storeId()}.public.blob.vercel-storage.com/${pathname}`,
  });
}

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

  if (new URL(req.url, 'http://x').searchParams.has('video')) {
    try {
      return await presignVideo(req, res);
    } catch (err) {
      console.error(err);
      return send(res, 500, { error: `동영상 업로드를 준비하지 못했습니다: ${err.message}` });
    }
  }

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
