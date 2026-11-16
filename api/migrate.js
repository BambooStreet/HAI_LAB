// Moves the photos and videos from Vercel Blob to Oracle Object Storage, a few at a time.
// A function only gets a minute, and there is far more than a minute of copying to do, so each
// call works until its time is nearly up and reports what is left; the settings tab keeps calling
// until nothing is. Each file's links are rewritten as soon as it lands, so a call that stops
// half way has still made progress and a re-run skips what it already moved. Nothing is deleted
// from Blob.
//
// Comments carry photos too, and the first pass missed them: post bodies, the papers and the
// homepage were rewritten, but photos attached to comments were left pointing at Blob. They are
// included here.
import { list } from '@vercel/blob';
import { send, isAdmin } from './_lib/http.js';
import { blobToken, hasBlob, getJSON, setJSON, sql, hasDb } from './_lib/store.js';
import { hasMedia, putMedia, publicUrl, PREFIX } from './_lib/media.js';

export const config = { maxDuration: 60 };

const BUDGET_MS = 45_000; // leave room to answer before the function is cut off
const BLOB_URL_RE = /https:\/\/[\w.-]*\.blob\.vercel-storage\.com\/(hai\/[\w.-]+)/g;
const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};
const typeOf = (key) => TYPES[key.split('.').pop().toLowerCase()] ?? 'application/octet-stream';

async function stillOnBlob() {
  const q = hasDb ? await sql() : null;
  const memos = q ? await q`SELECT id, body FROM hai_memos` : [];
  const comments = q ? await q`SELECT id, body FROM hai_memo_comments` : [];
  const [papers, content] = await Promise.all([getJSON('hai:papers'), getJSON('hai:content')]);
  const text = JSON.stringify([memos, comments, papers, content]);
  return { memos, comments, keys: [...new Set([...text.matchAll(BLOB_URL_RE)].map((m) => m[1]))] };
}

// Swaps one file's links wherever they appear, so progress survives a call running out of time.
async function relink(key, memos, comments) {
  const one = new RegExp(`https://[\\w.-]*\\.blob\\.vercel-storage\\.com/${key.replace('.', '\\.')}`, 'g');
  const fresh = publicUrl(key);
  let posts = 0;
  if (hasDb) {
    const q = await sql();
    for (const m of memos) {
      if (!one.test(m.body)) { one.lastIndex = 0; continue; }
      one.lastIndex = 0;
      m.body = m.body.replace(one, fresh);
      await q`UPDATE hai_memos SET body = ${m.body} WHERE id = ${m.id}`;
      posts += 1;
    }
    for (const c of comments) {
      if (!one.test(c.body)) { one.lastIndex = 0; continue; }
      one.lastIndex = 0;
      c.body = c.body.replace(one, fresh);
      await q`UPDATE hai_memo_comments SET body = ${c.body} WHERE id = ${c.id}`;
      posts += 1;
    }
  }
  // Read each document again rather than trusting the copy loaded at the start: these documents
  // hold several files, and writing back a stale copy would undo the link fixed a moment ago.
  for (const name of ['hai:papers', 'hai:content']) {
    const doc = await getJSON(name);
    if (!doc) continue;
    const before = JSON.stringify(doc);
    const after = before.replace(one, fresh);
    if (after !== before) await setJSON(name, JSON.parse(after));
  }
  return posts;
}

export default async function handler(req, res) {
  if (!isAdmin(req)) return send(res, 401, { error: '비밀번호가 올바르지 않습니다.' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Method not allowed' });
  }
  if (!hasMedia) return send(res, 503, { error: '오라클 저장소 설정(OCI_*)이 없습니다.' });
  if (!hasBlob) return send(res, 503, { error: '옮겨올 Blob 저장소가 연결되어 있지 않습니다.' });

  const startedAt = Date.now();
  try {
    const { memos, comments, keys } = await stillOnBlob();
    if (!keys.length) return send(res, 200, { done: true, copied: 0, remaining: 0, message: '옮길 파일이 없습니다. 모두 끝났어요.' });

    const { blobs } = await list({ prefix: PREFIX, limit: 1000, ...(blobToken && { token: blobToken }) });
    const have = new Map(blobs.map((b) => [b.pathname, b]));

    const copied = [];
    const missing = [];
    let bytes = 0;
    let posts = 0;
    for (const key of keys) {
      if (Date.now() - startedAt > BUDGET_MS) break; // finish cleanly; the next call carries on
      const blob = have.get(key);
      if (!blob) { missing.push(key); continue; }
      const file = await fetch(blob.url);
      if (!file.ok) { missing.push(key); continue; }
      const body = Buffer.from(await file.arrayBuffer());
      await putMedia(key, body, typeOf(key));
      posts += await relink(key, memos, comments);
      bytes += body.length;
      copied.push(key);
    }

    const remaining = keys.length - copied.length - missing.length;
    return send(res, 200, {
      done: remaining === 0,
      copied: copied.length,
      remaining,
      bytes,
      posts,
      missing,
      message: remaining
        ? `${copied.length}개를 옮겼습니다. 남은 ${remaining}개를 이어서 옮깁니다…`
        : `끝났습니다. 이번에 ${copied.length}개를 옮겼어요.`,
    });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: `옮기지 못했습니다: ${err.message}` });
  }
}
