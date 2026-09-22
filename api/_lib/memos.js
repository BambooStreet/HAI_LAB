// Admin memo board: one row per post, so edits to different posts never collide.
// `version` bumps on every edit; an update built on an older version is refused (conflict).
// Comments and likes live in their own tables so they never touch a post's version.
import { hasDb, sql, once, getJSON, setJSON } from './store.js';

const SEEDED_KEY = 'hai:memo-seeded'; // set once the default posts below have been added

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
export function cleanMemo(input) {
  const m = input && typeof input === 'object' ? input : {};
  return { title: str(m.title, 200).trim(), body: str(m.body, 50000).replace(/\s+$/, '') };
}
export const cleanComment = (body) => str(body, 2000).trim();

// Likes are counted per browser: the admin page keeps a random id in localStorage.
export const CLIENT_RE = /^[\w-]{8,64}$/;

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const toMemo = (r) => ({
  id: r.id, title: r.title, body: r.body,
  createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), version: Number(r.version),
});
const toComment = (r) => ({
  id: r.id, memoId: r.memo_id, parentId: r.parent_id || null, body: r.body, createdAt: Number(r.created_at),
});

// Local dev without DATABASE_URL.
const memory = new Map();
const memComments = new Map(); // id -> row
const memLikes = new Set(); // `${memoId}\n${client}`

const tables = {};
async function db() {
  const q = await sql();
  await once(tables, async () => {
    await q`CREATE TABLE IF NOT EXISTS hai_memos (
      id text PRIMARY KEY,
      title text NOT NULL DEFAULT '',
      author text NOT NULL DEFAULT '', -- unused (authors were dropped); kept so existing tables still match
      body text NOT NULL DEFAULT '',
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      version integer NOT NULL DEFAULT 1
    )`;
    await q`CREATE TABLE IF NOT EXISTS hai_memo_comments (
      id text PRIMARY KEY,
      memo_id text NOT NULL,
      parent_id text, -- set on replies; always a top-level comment (one level of nesting)
      body text NOT NULL,
      created_at bigint NOT NULL
    )`;
    await q`CREATE INDEX IF NOT EXISTS hai_memo_comments_memo ON hai_memo_comments (memo_id)`;
    await q`CREATE TABLE IF NOT EXISTS hai_memo_likes (
      memo_id text NOT NULL,
      client text NOT NULL,
      PRIMARY KEY (memo_id, client)
    )`;
  });
  return q;
}

function requireStore() {
  if (!hasDb && process.env.VERCEL) throw new Error('NO_DB');
}

// Posts the board starts with. Added once: deleting them later doesn't bring them back.
// Listed newest first; the notice gets the later timestamp so it sits on top.
const DEFAULT_MEMOS = [
  {
    id: 'default-notice',
    title: '공지',
    body: [
      '1. 2026.09.22 업데이트',
      '- 방문자 통계 추가',
      '- 메모장 추가',
      '',
      '2. 메모장에 헛소리 추가하지말것. (반드시 학술적 용도로만 사용할 것)',
    ].join('\n'),
  },
  { id: 'default-tancheon', title: '', body: '탄천 학회 일정 정해 주시기 바랍니다 ^^' },
];

async function seedDefaults() {
  if (await getJSON(SEEDED_KEY)) return;
  const now = Date.now();
  const rows = DEFAULT_MEMOS.map((m, i) => ({ ...m, at: now - i }));
  if (hasDb) {
    const q = await db();
    // Fixed ids + DO NOTHING: two first visits at once can't add the posts twice.
    for (const r of rows) {
      await q`INSERT INTO hai_memos (id, title, body, created_at, updated_at)
        VALUES (${r.id}, ${r.title}, ${r.body}, ${r.at}, ${r.at}) ON CONFLICT (id) DO NOTHING`;
    }
  } else {
    for (const r of rows) {
      if (!memory.has(r.id)) memory.set(r.id, { ...r, created_at: r.at, updated_at: r.at, version: 1 });
    }
  }
  await setJSON(SEEDED_KEY, true);
}

// Each memo comes with its comments (oldest first), like count and whether `client` liked it.
export async function listMemos(client = '') {
  requireStore();
  await seedDefaults();
  let memos, comments, likes;
  if (!hasDb) {
    memos = [...memory.values()].map(toMemo).sort((a, b) => b.createdAt - a.createdAt);
    comments = [...memComments.values()].map(toComment).sort((a, b) => a.createdAt - b.createdAt);
    const counts = new Map();
    for (const key of memLikes) {
      const [memoId, who] = key.split('\n');
      const c = counts.get(memoId) ?? { memo_id: memoId, n: 0, liked: false };
      c.n += 1;
      c.liked ||= who === client;
      counts.set(memoId, c);
    }
    likes = [...counts.values()];
  } else {
    const q = await db();
    [memos, comments, likes] = await Promise.all([
      q`SELECT * FROM hai_memos ORDER BY created_at DESC LIMIT 500`.then((rows) => rows.map(toMemo)),
      q`SELECT * FROM hai_memo_comments ORDER BY created_at`.then((rows) => rows.map(toComment)),
      q`SELECT memo_id, count(*)::int AS n, bool_or(client = ${client}) AS liked FROM hai_memo_likes GROUP BY memo_id`,
    ]);
  }
  const byMemo = new Map(memos.map((m) => [m.id, { ...m, comments: [], likes: 0, liked: false }]));
  for (const c of comments) byMemo.get(c.memoId)?.comments.push(c);
  for (const l of likes) {
    const m = byMemo.get(l.memo_id);
    if (m) Object.assign(m, { likes: Number(l.n), liked: Boolean(l.liked) });
  }
  return [...byMemo.values()];
}

async function memoExists(id) {
  if (!hasDb) return memory.has(id);
  const q = await db();
  return (await q`SELECT 1 FROM hai_memos WHERE id = ${id}`).length > 0;
}

export async function createMemo(input) {
  requireStore();
  const m = cleanMemo(input);
  const now = Date.now();
  const row = { id: newId(), ...m, created_at: now, updated_at: now, version: 1 };
  if (!hasDb) {
    memory.set(row.id, row);
    return toMemo(row);
  }
  const q = await db();
  const [r] = await q`INSERT INTO hai_memos (id, title, body, created_at, updated_at)
    VALUES (${row.id}, ${m.title}, ${m.body}, ${now}, ${now}) RETURNING *`;
  return toMemo(r);
}

// Returns the updated memo, or { conflict: current } / { missing: true }.
export async function updateMemo(id, base, input) {
  requireStore();
  const m = cleanMemo(input);
  const now = Date.now();
  if (!hasDb) {
    const cur = memory.get(id);
    if (!cur) return { missing: true };
    if (cur.version !== base) return { conflict: toMemo(cur) };
    const row = { ...cur, ...m, updated_at: now, version: cur.version + 1 };
    memory.set(id, row);
    return toMemo(row);
  }
  const q = await db();
  const [r] = await q`UPDATE hai_memos
    SET title = ${m.title}, body = ${m.body}, updated_at = ${now}, version = version + 1
    WHERE id = ${id} AND version = ${base} RETURNING *`;
  if (r) return toMemo(r);
  const [cur] = await q`SELECT * FROM hai_memos WHERE id = ${id}`;
  return cur ? { conflict: toMemo(cur) } : { missing: true };
}

export async function deleteMemo(id) {
  requireStore();
  if (!hasDb) {
    memory.delete(id);
    for (const [cid, c] of memComments) if (c.memo_id === id) memComments.delete(cid);
    for (const key of memLikes) if (key.startsWith(`${id}\n`)) memLikes.delete(key);
    return;
  }
  const q = await db();
  await q`DELETE FROM hai_memo_comments WHERE memo_id = ${id}`;
  await q`DELETE FROM hai_memo_likes WHERE memo_id = ${id}`;
  await q`DELETE FROM hai_memos WHERE id = ${id}`;
}

async function findComment(id) {
  if (!hasDb) return memComments.get(id) ?? null;
  const q = await db();
  return (await q`SELECT id, memo_id, parent_id FROM hai_memo_comments WHERE id = ${id}`)[0] ?? null;
}

// With `parentId`, the comment is a reply. A reply to a reply attaches to the same top-level
// comment, so threads stay one level deep.
// Returns { comment }, or { missing: 'memo' | 'comment' } when the memo or the parent is gone.
export async function addComment(memoId, body, parentId = '') {
  requireStore();
  if (!(await memoExists(memoId))) return { missing: 'memo' };
  let parent = null;
  if (parentId) {
    const p = await findComment(parentId);
    if (!p || p.memo_id !== memoId) return { missing: 'comment' };
    parent = p.parent_id || p.id;
  }
  const row = { id: newId(), memo_id: memoId, parent_id: parent, body: cleanComment(body), created_at: Date.now() };
  if (!hasDb) {
    memComments.set(row.id, row);
    return { comment: toComment(row) };
  }
  const q = await db();
  const [r] = await q`INSERT INTO hai_memo_comments (id, memo_id, parent_id, body, created_at)
    VALUES (${row.id}, ${row.memo_id}, ${row.parent_id}, ${row.body}, ${row.created_at}) RETURNING *`;
  return { comment: toComment(r) };
}

// Deleting a comment also deletes its replies.
export async function deleteComment(id) {
  requireStore();
  if (!hasDb) {
    for (const [cid, c] of memComments) if (cid === id || c.parent_id === id) memComments.delete(cid);
    return;
  }
  const q = await db();
  await q`DELETE FROM hai_memo_comments WHERE id = ${id} OR parent_id = ${id}`;
}

// Like or unlike; idempotent either way. Returns { likes, liked }, or null when the memo is gone.
export async function setLike(memoId, client, like) {
  requireStore();
  if (!(await memoExists(memoId))) return null;
  const key = `${memoId}\n${client}`;
  if (!hasDb) {
    if (like) memLikes.add(key);
    else memLikes.delete(key);
    return { likes: [...memLikes].filter((k) => k.startsWith(`${memoId}\n`)).length, liked: like };
  }
  const q = await db();
  if (like) await q`INSERT INTO hai_memo_likes (memo_id, client) VALUES (${memoId}, ${client}) ON CONFLICT DO NOTHING`;
  else await q`DELETE FROM hai_memo_likes WHERE memo_id = ${memoId} AND client = ${client}`;
  const [r] = await q`SELECT count(*)::int AS n FROM hai_memo_likes WHERE memo_id = ${memoId}`;
  return { likes: Number(r.n), liked: like };
}
