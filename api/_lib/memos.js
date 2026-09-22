// Admin memo board: one row per post, so edits to different posts never collide.
// `version` bumps on every edit; an update built on an older version is refused (conflict).
import { hasDb, sql, once, getJSON, setJSON } from './store.js';

const SEEDED_KEY = 'hai:memo-seeded'; // set once the default posts below have been added

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
export function cleanMemo(input) {
  const m = input && typeof input === 'object' ? input : {};
  return { title: str(m.title, 200).trim(), body: str(m.body, 50000).replace(/\s+$/, '') };
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const toMemo = (r) => ({
  id: r.id, title: r.title, body: r.body,
  createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), version: Number(r.version),
});

// Local dev without DATABASE_URL.
const memory = new Map();

const table = {};
async function db() {
  const q = await sql();
  await once(table, () => q`CREATE TABLE IF NOT EXISTS hai_memos (
    id text PRIMARY KEY,
    title text NOT NULL DEFAULT '',
    author text NOT NULL DEFAULT '', -- unused (authors were dropped); kept so existing tables still match
    body text NOT NULL DEFAULT '',
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    version integer NOT NULL DEFAULT 1
  )`);
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

export async function listMemos() {
  requireStore();
  await seedDefaults();
  if (!hasDb) return [...memory.values()].map(toMemo).sort((a, b) => b.createdAt - a.createdAt);
  const q = await db();
  const rows = await q`SELECT * FROM hai_memos ORDER BY created_at DESC LIMIT 500`;
  return rows.map(toMemo);
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
  if (!hasDb) return void memory.delete(id);
  const q = await db();
  await q`DELETE FROM hai_memos WHERE id = ${id}`;
}
