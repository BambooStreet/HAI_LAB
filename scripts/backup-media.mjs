// Downloads every photo and video the posts point at into a folder outside the repo, with a
// manifest saying which post each file belongs to. Run with: npm run backup:media
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { neon } from '@neondatabase/serverless';

const OUT = process.argv[2] ?? 'C:/Users/ohmyh/OneDrive/projects/Project/personal_projects/hai-lab-media-backup';
const BASE = 'https://qkpv8kgy9dsnrfcl.public.blob.vercel-storage.com/';

const sql = neon(process.env.DATABASE_URL);
const paths = (text) => [...String(text).matchAll(/hai\/[\w.-]+/g)].map((m) => m[0]);

const [memos, kv] = await Promise.all([
  sql.query('SELECT id, title, body, created_at FROM hai_memos ORDER BY created_at'),
  sql.query("SELECT key, value FROM hai_kv WHERE key IN ('hai:papers','hai:content')"),
]);

// file -> where it is used, so a restored file can be matched back to its post
const owners = new Map();
const note = (file, where) => owners.set(file, [...(owners.get(file) ?? []), where]);
for (const m of memos) for (const f of paths(m.body)) note(f, `메모: ${m.title || '(제목 없음)'}`);
for (const row of kv) for (const f of paths(JSON.stringify(row.value))) note(f, row.key === 'hai:papers' ? '논문' : '홈페이지 내용');

await mkdir(OUT, { recursive: true });
console.log(`${owners.size}개 파일을 내려받습니다 → ${OUT}\n`);

const done = [];
const failed = [];
for (const [file, where] of owners) {
  const name = file.replace('hai/', '');
  try {
    const res = await fetch(BASE + file);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    await writeFile(join(OUT, name), bytes);
    done.push({ file, name, bytes: bytes.length, where });
    process.stdout.write('.');
  } catch (err) {
    failed.push({ file, name, where, reason: err.message });
    process.stdout.write('x');
  }
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
await writeFile(join(OUT, '_목록.json'), JSON.stringify({ at: new Date().toISOString(), done, failed }, null, 2), 'utf8');

console.log(`\n\n받음: ${done.length}개 (${mb(done.reduce((n, f) => n + f.bytes, 0))})`);
if (failed.length) {
  console.log(`실패: ${failed.length}개`);
  for (const f of failed) console.log(`  - ${f.name} (${f.reason}) ← ${f.where.join(', ')}`);
}
process.exit(0);
