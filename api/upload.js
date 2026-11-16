import { del } from '@vercel/blob'; // only for deleting files posted before the move
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { send, isAdmin, readBody } from './_lib/http.js';
import { blobToken, hasBlob, getJSON, setJSON } from './_lib/store.js';
import { listMemos } from './_lib/memos.js';
import {
  hasMedia, putMedia, deleteMedia, listMedia, signUpload, allowOrigin, publicUrl, keyFromUrl, PREFIX,
} from './_lib/media.js';

// Images arrive already resized by the admin page, as a raw application/octet-stream body.
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
// Videos are too big for a function body (4.5 MB), so the browser uploads them straight to Blob
// with a presigned PUT URL this route hands out. The URL itself caps the type and the size.
const VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
const VIDEO_MAX_BYTES = 300 * 1024 * 1024;
const MAX_BYTES = 4 * 1024 * 1024; // Vercel functions reject bodies over 4.5 MB
const LOCAL_DIR = join(tmpdir(), 'hai-lab-uploads');

// Uploads while developing go to a temp folder and are served back from it, so photos and videos
// can be tested without a Blob store (Blob only authorizes deployments).
const isLocal = !process.env.VERCEL;

async function saveLocally(req, name, buffer) {
  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(join(LOCAL_DIR, name), buffer);
  return `http://${req.headers.host}/api/upload?file=${name}`;
}

// A read-write token looks like vercel_blob_rw_<storeId>_<secret>; the public URL needs the store id
// without the "store_" prefix that BLOB_STORE_ID carries (that prefix makes the host 400).
const storeId = () => (process.env.BLOB_STORE_ID || blobToken.split('_')[3] || '').replace(/^store_/, '');

async function presignVideo(req, res) {
  const body = readBody(req);
  const type = String(body.type || '');
  const size = Number(body.size) || 0;
  const ext = VIDEO_TYPES[type];
  if (!ext) return send(res, 400, { error: 'MP4, WebM, MOV 동영상만 올릴 수 있어요.' });
  if (size > VIDEO_MAX_BYTES) {
    return send(res, 413, { error: `동영상이 너무 커요 (최대 ${VIDEO_MAX_BYTES / 1024 / 1024}MB).` });
  }
  // Local dev keeps files in a temp folder; there are no storage credentials to sign with.
  if (isLocal) return send(res, 200, { uploadUrl: `/api/upload?video=direct&ext=${ext}`, url: '' });
  if (!hasMedia) {
    return send(res, 503, { error: '동영상 저장소가 연결되지 않았습니다. 환경변수(OCI_*)를 확인해 주세요.' });
  }

  const key = `${PREFIX}${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
  return send(res, 200, {
    uploadUrl: await signUpload(key, type, 3600), // an hour: big files upload slowly on lab wifi
    url: publicUrl(key),
  });
}

async function readBuffer(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Files no post shows any more. Anything uploaded in the last hour is kept, so a photo that is
// still sitting in an unsaved post is never swept away.
const KEEP_RECENT_MS = 60 * 60 * 1000;
const USAGE_KEY = 'hai:blob-usage'; // last reading, so a blocked store can still show something

// What the posts point at, worked out without touching the store.
async function referencedFiles() {
  const [memos, papers, content] = await Promise.all([listMemos(), getJSON('hai:papers'), getJSON('hai:content')]);
  const shown = JSON.stringify([memos, papers, content]);
  const files = [...new Set([...shown.matchAll(/hai\/[\w.-]+/g)].map((m) => m[0]))];
  const videos = files.filter((p) => /\.(mp4|webm|mov)$/i.test(p));
  return { referenced: files.length, videos: videos.length, lastSeen: await getJSON(USAGE_KEY) };
}

async function findOrphans() {
  const [blobs, memos, papers, content] = await Promise.all([
    listMedia(),
    listMemos(),
    getJSON('hai:papers'),
    getJSON('hai:content'),
  ]);
  // Compared by pathname, not URL, so a link saved under an older host still counts as in use.
  const shown = JSON.stringify([memos, papers, content]);
  const fresh = Date.now() - KEEP_RECENT_MS;
  const orphans = blobs.filter((b) => !shown.includes(b.pathname) && new Date(b.uploadedAt).getTime() < fresh);
  const size = (rows) => rows.reduce((n, b) => n + b.size, 0);
  const file = (b) => ({ pathname: b.pathname, size: b.size, uploadedAt: b.uploadedAt });

  // Links in posts whose file is gone (deleted from the Blob dashboard, say): reported, never
  // "fixed" automatically, since only a person can tell what the post was meant to show.
  const have = new Set(blobs.map((b) => b.pathname));
  const missing = [...new Set([...shown.matchAll(/hai\/[\w.-]+/g)].map((m) => m[0]))].filter((p) => !have.has(p));

  // Same size and extension usually means the same file uploaded twice. Only ever reported:
  // telling them apart for real would mean downloading both, which costs transfer.
  const groups = new Map();
  for (const b of blobs) {
    const key = `${b.size}|${b.pathname.split('.').pop()}`;
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  const maybeDuplicates = [...groups.values()].filter((g) => g.length > 1).map((g) => g.map(file));

  return {
    orphans,
    summary: {
      total: blobs.length,
      totalBytes: size(blobs),
      unused: orphans.length,
      unusedBytes: size(orphans),
      files: orphans.map(file),
      missing,
      maybeDuplicates,
    },
  };
}

export default async function handler(req, res) {
  const params = new URL(req.url, 'http://x').searchParams;

  // Tells the store to accept uploads sent straight from this site, which is what a video needs.
  if (params.has('allow-origin') && req.method === 'POST') {
    if (!isAdmin(req)) return send(res, 401, { error: '비밀번호가 올바르지 않습니다.' });
    if (!hasMedia) return send(res, 503, { error: '저장소가 연결되지 않았습니다.' });
    const origin = `https://${req.headers.host}`;
    try {
      const result = await allowOrigin(origin);
      return send(res, 200, { ...result, origin, error: result.ok ? '' : result.tried.at(-1)?.error });
    } catch (err) {
      return send(res, 200, { ok: false, origin, error: err.message });
    }
  }

  // Storage housekeeping, both admin-only.
  if (params.has('orphans') && (req.method === 'GET' || req.method === 'DELETE')) {
    if (!isAdmin(req)) return send(res, 401, { error: '비밀번호가 올바르지 않습니다.' });
    if (!hasMedia) return send(res, 503, { error: '저장소가 연결되지 않았습니다.' });
    try {
      const { orphans, summary } = await findOrphans();
      // Kept so the page can still say how full the store was the last time it could look.
      await setJSON(USAGE_KEY, { at: Date.now(), total: summary.total, totalBytes: summary.totalBytes });
      if (req.method === 'GET') return send(res, 200, summary);
      if (orphans.length) await del(orphans.map((b) => b.url), { ...(blobToken && { token: blobToken }) });
      return send(res, 200, { ...summary, deleted: orphans.length });
    } catch (err) {
      // Over the plan's limits the whole store answers 403, reads included. Say so plainly and
      // show what can still be worked out from the posts themselves.
      if (/blocked|403|forbidden|limit/i.test(err.message)) {
        return send(res, 200, { blocked: true, reason: err.message, ...(await referencedFiles()) });
      }
      console.error(err);
      return send(res, 500, { error: `저장소를 정리하지 못했습니다: ${err.message}` });
    }
  }

  // Local dev only: take a video straight into the temp folder (no 4.5MB function limit here).
  if (req.method === 'PUT' && isLocal && params.get('video') === 'direct') {
    if (!isAdmin(req)) return send(res, 401, { error: '비밀번호가 올바르지 않습니다.' });
    const ext = Object.values(VIDEO_TYPES).includes(params.get('ext')) ? params.get('ext') : 'mp4';
    const buffer = await readBuffer(req);
    if (!buffer.length) return send(res, 400, { error: '빈 파일입니다.' });
    const name = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
    return send(res, 200, { url: await saveLocally(req, name, buffer) });
  }

  // Local dev only: serve files saved without a Blob token.
  if (req.method === 'GET' && isLocal) {
    const name = String(params.get('file') || '').replace(/[^a-z0-9.-]/gi, '');
    const ext = name.split('.').pop();
    const types = { ...TYPES, ...VIDEO_TYPES };
    const type = Object.keys(types).find((t) => types[t] === ext);
    try {
      const body = await readFile(join(LOCAL_DIR, name));
      res.setHeader('Content-Type', type || 'application/octet-stream');
      return res.end(body);
    } catch {
      return send(res, 404, { error: 'Not found' });
    }
  }

  if (req.method !== 'POST' && req.method !== 'DELETE') {
    res.setHeader('Allow', 'POST, DELETE, PUT');
    return send(res, 405, { error: 'Method not allowed' });
  }
  if (!isAdmin(req)) return send(res, 401, { error: '비밀번호가 올바르지 않습니다.' });

  // Frees the storage a photo or video took once no post shows it any more.
  if (req.method === 'DELETE') {
    const url = new URL(req.url, 'http://x').searchParams.get('url') || '';
    const key = keyFromUrl(url);
    // Posts written before the move still point at Blob, so either store may be the target.
    if (!key.startsWith(PREFIX)) return send(res, 400, { error: '이 저장소의 파일이 아닙니다.' });
    try {
      if (url.includes('oraclecloud.com')) {
        if (hasMedia) await deleteMedia(key);
      } else if (hasBlob) {
        await del(url, { ...(blobToken && { token: blobToken }) });
      }
      return send(res, 200, { ok: true });
    } catch (err) {
      console.error(err);
      return send(res, 500, { error: `파일을 지우지 못했습니다: ${err.message}` });
    }
  }

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

    if (isLocal) return send(res, 200, { url: await saveLocally(req, name, buffer) });
    if (!hasMedia) {
      return send(res, 503, { error: '사진 저장소가 연결되지 않았습니다. 환경변수(OCI_*)를 확인해 주세요.' });
    }

    return send(res, 200, { url: await putMedia(PREFIX + name, buffer, type) });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: `사진을 올리지 못했습니다: ${err.message}` });
  }
}
