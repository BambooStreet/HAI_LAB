// One-off move of the photos and videos from Vercel Blob to Oracle Object Storage, run from the
// settings tab. Copies each file the posts point at, then rewrites those links. Safe to run again:
// anything already carrying an Oracle link is left alone, and nothing is deleted from Blob.
import { list } from '@vercel/blob';
import { send, isAdmin } from './_lib/http.js';
import { blobToken, hasBlob, getJSON, setJSON, sql, hasDb } from './_lib/store.js';
import { hasMedia, putMedia, publicUrl, PREFIX } from './_lib/media.js';

const BLOB_URL_RE = /https:\/\/[\w.-]*\.blob\.vercel-storage\.com\/(hai\/[\w.-]+)/g;
const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};
const typeOf = (key) => TYPES[key.split('.').pop().toLowerCase()] ?? 'application/octet-stream';

// Every place a media link can sit: memo bodies, and the papers/content documents.
async function readAll() {
  const memos = hasDb ? await (await sql())`SELECT id, body FROM hai_memos` : [];
  const [papers, content] = await Promise.all([getJSON('hai:papers'), getJSON('hai:content')]);
  return { memos, papers, content };
}

export default async function handler(req, res) {
  if (!isAdmin(req)) return send(res, 401, { error: '비밀번호가 올바르지 않습니다.' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Method not allowed' });
  }
  if (!hasMedia) return send(res, 503, { error: '오라클 저장소 설정(OCI_*)이 없습니다.' });
  if (!hasBlob) return send(res, 503, { error: '옮겨올 Blob 저장소가 연결되어 있지 않습니다.' });

  try {
    const { memos, papers, content } = await readAll();
    const text = JSON.stringify([memos, papers, content]);
    const wanted = [...new Set([...text.matchAll(BLOB_URL_RE)].map((m) => m[1]))];
    if (!wanted.length) return send(res, 200, { done: true, copied: 0, message: '옮길 파일이 없습니다.' });

    // What the posts ask for, matched against what Blob actually still holds.
    const { blobs } = await list({ prefix: PREFIX, limit: 1000, ...(blobToken && { token: blobToken }) });
    const have = new Map(blobs.map((b) => [b.pathname, b]));

    const copied = [];
    const missing = [];
    let bytes = 0;
    for (const key of wanted) {
      const blob = have.get(key);
      if (!blob) { missing.push(key); continue; }
      const file = await fetch(blob.url);
      if (!file.ok) { missing.push(key); continue; }
      const body = Buffer.from(await file.arrayBuffer());
      await putMedia(key, body, typeOf(key));
      bytes += body.length;
      copied.push(key);
    }

    // Links are swapped only for files that made it across; a missing one keeps its old link so
    // it stays visible as a problem rather than turning into a URL that was never written.
    const swap = (s) => String(s).replace(BLOB_URL_RE, (whole, key) => (copied.includes(key) ? publicUrl(key) : whole));
    let posts = 0;
    if (hasDb) {
      const q = await sql();
      for (const m of memos) {
        const next = swap(m.body);
        if (next === m.body) continue;
        await q`UPDATE hai_memos SET body = ${next} WHERE id = ${m.id}`;
        posts += 1;
      }
    }
    if (papers) await setJSON('hai:papers', JSON.parse(swap(JSON.stringify(papers))));
    if (content) await setJSON('hai:content', JSON.parse(swap(JSON.stringify(content))));

    return send(res, 200, {
      done: true,
      copied: copied.length,
      bytes,
      posts,
      missing,
      message: `${copied.length}개를 옮기고 글 ${posts}개의 주소를 바꿨습니다.`,
    });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: `옮기지 못했습니다: ${err.message}` });
  }
}
