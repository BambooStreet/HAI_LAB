import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { send, isAdmin, readBody } from './_lib/http.js';
import { getJSON, setJSON } from './_lib/store.js';
import { listMemos } from './_lib/memos.js';
import {
  hasMedia, putMedia, deleteMedia, listMedia, keyFromUrl, PREFIX, PART_SIZE,
  startUpload, uploadPart, finishUpload, abortUpload,
} from './_lib/media.js';

// Images arrive already resized by the admin page, as a raw application/octet-stream body.
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
// Videos are too big for a function body (4.5 MB), so the browser cuts one into pieces and posts
// them here one at a time; the store joins them back together (see _lib/media.js).
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

// Checks the file over and opens an upload the pieces can be added to.
async function startVideo(req, res) {
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
  return send(res, 200, { key, uploadId: await startUpload(key, type), partSize: PART_SIZE });
}

// One piece of a video on its way through. The bytes arrive raw, as with photos.
async function takePart(req, res, params) {
  const key = params.get('key') || '';
  const uploadId = params.get('uploadId') || '';
  const part = Number(params.get('part'));
  if (!key.startsWith(PREFIX) || !uploadId || !(part >= 1)) return send(res, 400, { error: '잘못된 요청입니다.' });
  const body = await readBuffer(req);
  if (!body.length) return send(res, 400, { error: '빈 조각입니다.' });
  return send(res, 200, { etag: await uploadPart(key, uploadId, part, body) });
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
const USAGE_KEY = 'hai:blob-usage'; // last reading, kept so an unreachable store still shows something
                                    // (named from the store this project used to be on)

// The store names a file hai/<name>, but a link inside a post carries it through the URL's
// path, where the slash is written %2F. Both spellings mean the same file, so every comparison
// here goes through this and never through the raw text.
const KEY_RE = /hai(?:\/|%2F)([\w.-]+)/gi;
export const keysUsedIn = (text) => new Set([...text.matchAll(KEY_RE)].map((m) => PREFIX + m[1]));

// What the posts point at, worked out without touching the store.
async function referencedFiles() {
  const [memos, papers, content] = await Promise.all([listMemos(), getJSON('hai:papers'), getJSON('hai:content')]);
  const files = [...keysUsedIn(JSON.stringify([memos, papers, content]))];
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
  // Compared by name, not URL, so a link saved under an older host still counts as in use.
  const used = keysUsedIn(JSON.stringify([memos, papers, content]));
  const fresh = Date.now() - KEEP_RECENT_MS;
  const orphans = blobs.filter((b) => !used.has(b.pathname) && new Date(b.uploadedAt).getTime() < fresh);
  const size = (rows) => rows.reduce((n, b) => n + b.size, 0);
  const file = (b) => ({ pathname: b.pathname, size: b.size, uploadedAt: b.uploadedAt });

  // Links in posts whose file is gone: reported, never "fixed" automatically, since only a
  // person can tell what the post was meant to show.
  const have = new Set(blobs.map((b) => b.pathname));
  const missing = [...used].filter((p) => !have.has(p));

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
      referenced: used.size,
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

  // Storage housekeeping, both admin-only.
  if (params.has('orphans') && (req.method === 'GET' || req.method === 'DELETE')) {
    if (!isAdmin(req)) return send(res, 401, { error: '비밀번호가 올바르지 않습니다.' });
    if (!hasMedia) return send(res, 503, { error: '저장소가 연결되지 않았습니다.' });
    try {
      const { orphans, summary } = await findOrphans();
      // Kept so the page can still say how full the store was the last time it could look.
      await setJSON(USAGE_KEY, { at: Date.now(), total: summary.total, totalBytes: summary.totalBytes });
      if (req.method === 'GET') return send(res, 200, summary);
      // Every file in the store looking unused, while the posts point at none at all, is what a
      // broken comparison looks like — not a store full of junk. Deleting on that reading would
      // empty it, so stop instead.
      if (summary.total && !summary.referenced && summary.unused === summary.total) {
        return send(res, 409, {
          error: '글이 쓰고 있는 파일을 하나도 찾지 못했습니다. 잘못 지울 수 있어 멈췄습니다.',
        });
      }
      for (const b of orphans) await deleteMedia(b.pathname);
      return send(res, 200, { ...summary, deleted: orphans.length });
    } catch (err) {
      // The store refusing to answer is nearly always the keys, not the files. Say that, and
      // show what can still be worked out from the posts themselves.
      if (/403|forbidden|denied|authenticat|credential|signature/i.test(err.message)) {
        return send(res, 200, { unreachable: true, reason: err.message, ...(await referencedFiles()) });
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
    if (!key.startsWith(PREFIX)) return send(res, 400, { error: '이 저장소의 파일이 아닙니다.' });
    if (!hasMedia) return send(res, 503, { error: '저장소가 연결되지 않았습니다.' });
    try {
      await deleteMedia(key);
      return send(res, 200, { ok: true });
    } catch (err) {
      console.error(err);
      return send(res, 500, { error: `파일을 지우지 못했습니다: ${err.message}` });
    }
  }

  // A video arrives in pieces: one call to begin, one per piece, one to put them together.
  if (params.has('video')) {
    const step = params.get('video');
    try {
      if (step === 'part') return await takePart(req, res, params);
      if (step === 'finish') {
        const { key, uploadId, parts } = readBody(req);
        return send(res, 200, { url: await finishUpload(key, uploadId, parts) });
      }
      if (step === 'abort') {
        const { key, uploadId } = readBody(req);
        await abortUpload(key, uploadId);
        return send(res, 200, { ok: true });
      }
      return await startVideo(req, res); // 'start', and the local-dev shortcut
    } catch (err) {
      console.error(err);
      return send(res, 500, { error: `동영상을 올리지 못했습니다: ${err.message}` });
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
