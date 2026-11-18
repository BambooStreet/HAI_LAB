// 실제 저장소에 대고 업로드 경로를 그대로 밟아본다. npm test 는 메모리와 임시 폴더만
// 쓰기 때문에 오라클까지 가는 길은 확인하지 못한다 — 특히 동영상 조각 하나가 4MB 인데,
// S3 규격은 마지막을 뺀 조각이 최소 5MB 라 오라클이 받아주는지는 실제로 해봐야 안다.
//
//   node --env-file=.env.local scripts/check-storage.mjs
//
// 올린 것은 끝나면 반드시 지운다. 기존 파일은 건드리지 않는다.
import { randomUUID } from 'node:crypto';
import {
  hasMedia, putMedia, deleteMedia, publicUrl, PREFIX, PART_SIZE,
  startUpload, uploadPart, finishUpload, abortUpload,
} from '../api/_lib/media.js';

let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

if (!hasMedia) { console.error('OCI_* 없음'); process.exit(1); }

const tag = randomUUID().slice(0, 8);
const photoKey = `${PREFIX}_selftest-${tag}.webp`;
const videoKey = `${PREFIX}_selftest-${tag}.mp4`;
const made = [];

try {
  console.log('\n사진 경로 (단일 업로드)');
  const photo = Buffer.alloc(120_000);
  for (let i = 0; i < photo.length; i++) photo[i] = (i * 31) & 0xff;
  const url = await putMedia(photoKey, photo, 'image/webp');
  made.push(photoKey);
  check('올라감', url === publicUrl(photoKey), url);
  const got = await fetch(url);
  const back = Buffer.from(await got.arrayBuffer());
  check('공개 주소로 다시 받아짐', got.status === 200, String(got.status));
  check('바이트가 그대로', back.equals(photo), `${back.length} vs ${photo.length}`);
  check('형식이 image/webp', got.headers.get('content-type') === 'image/webp', got.headers.get('content-type'));
  check('캐시 헤더가 붙음', /max-age=/.test(got.headers.get('cache-control') || ''), got.headers.get('cache-control'));

  console.log('\n동영상 경로 (조각 업로드)');
  // 조각 하나는 4MB — S3 규격의 최소 5MB보다 작다. 오라클이 받아주는지가 핵심.
  const parts = 3;
  const body = Buffer.alloc(PART_SIZE * (parts - 1) + 1_000_000);
  for (let i = 0; i < body.length; i += 997) body[i] = (i / 997) & 0xff;
  const uploadId = await startUpload(videoKey, 'video/mp4');
  check('업로드 시작됨', Boolean(uploadId));
  const etags = [];
  try {
    for (let n = 1; n <= parts; n++) {
      const piece = body.subarray((n - 1) * PART_SIZE, n * PART_SIZE);
      etags.push({ n, etag: await uploadPart(videoKey, uploadId, n, piece) });
    }
    check(`${PART_SIZE / 1024 / 1024}MB 조각을 받아줌 (${parts}개)`, etags.every((p) => p.etag));
    const vurl = await finishUpload(videoKey, uploadId, etags);
    made.push(videoKey);
    check('조각이 하나로 합쳐짐', vurl === publicUrl(videoKey));
    const vg = await fetch(vurl);
    const vback = Buffer.from(await vg.arrayBuffer());
    check('크기가 보낸 것과 같음', vback.length === body.length, `${vback.length} vs ${body.length}`);
    check('내용이 그대로', vback.equals(body));
    check('형식이 video/mp4', vg.headers.get('content-type') === 'video/mp4', vg.headers.get('content-type'));
  } catch (err) {
    check('조각 업로드', false, err.message);
    await abortUpload(videoKey, uploadId).catch(() => {});
  }

  console.log('\n지우기');
  for (const key of made.splice(0)) {
    await deleteMedia(key);
    const r = await fetch(publicUrl(key));
    check(`${key.replace(PREFIX, '')} 가 지워짐`, r.status === 404, String(r.status));
  }
} finally {
  // 어느 단계에서 터지든 시험용 파일은 남기지 않는다.
  for (const key of made) {
    try { await deleteMedia(key); console.log('  (정리)', key); } catch {}
  }
}

console.log(`\n${pass}개 통과, ${fails.length}개 실패`);
if (fails.length) process.exitCode = 1;
