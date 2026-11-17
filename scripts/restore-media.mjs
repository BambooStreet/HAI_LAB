// Puts the backed-up photos and videos back into Oracle under their original names.
//
// Every link already in the posts points at hai/<name>, so restoring a file under exactly that
// name makes the post work again with no change to the database. A file already in the bucket
// is left alone, so this can be re-run safely and picks up where it stopped.
//
//   node --env-file=.env.local scripts/restore-media.mjs
//
// .env.local needs the same OCI_* values the deployment uses. Nothing is deleted, here or in
// the backup folder.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { putMedia, publicUrl, PREFIX, hasMedia } from '../api/_lib/media.js';

const BACKUP = 'C:/Users/ohmyh/OneDrive/projects/Project/personal_projects/hai-lab-media-backup';

const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};
const typeOf = (name) => TYPES[name.split('.').pop().toLowerCase()] ?? 'application/octet-stream';
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;

if (!hasMedia) {
  console.error('OCI_* 환경변수가 없습니다. node --env-file=.env.local 로 실행해 주세요.');
  process.exit(1);
}

const names = (await readdir(BACKUP)).filter((f) => !f.startsWith('_'));
console.log(`백업 ${names.length}개를 확인합니다.\n`);

let restored = 0;
let kept = 0;
let bytes = 0;
const failed = [];

for (const name of names) {
  const key = PREFIX + name;
  // Ask the bucket itself rather than trusting a list: the public URL is exactly what a
  // visitor's browser will request, so a 200 here means the post really works again.
  const there = await fetch(publicUrl(key), { method: 'GET', headers: { Range: 'bytes=0-0' } })
    .then((r) => r.ok || r.status === 206)
    .catch(() => false);
  if (there) {
    kept += 1;
    continue;
  }

  const size = (await stat(join(BACKUP, name))).size;
  process.stdout.write(`  올리는 중 ${name} (${mb(size)}) … `);
  try {
    await putMedia(key, await readFile(join(BACKUP, name)), typeOf(name));
    restored += 1;
    bytes += size;
    console.log('됨');
  } catch (err) {
    failed.push({ name, why: err.message });
    console.log(`실패 — ${err.message}`);
  }
}

console.log(`\n이미 있던 것 ${kept}개 · 되살린 것 ${restored}개 (${mb(bytes)})`);
if (failed.length) {
  console.log(`실패 ${failed.length}개:`);
  for (const f of failed) console.log(`  ${f.name} — ${f.why}`);
  process.exitCode = 1;
}
