// Smoke test: starts the dev server on its own port with in-memory data (never touches the real
// database) and walks the API the admin page uses. Run with: npm test
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const PORT = 3457;
const PASSWORD = 'smoke-test';
const base = `http://127.0.0.1:${PORT}`;
const admin = { 'Content-Type': 'application/json', 'x-admin-password': PASSWORD, 'x-client-id': 'smoke-client-1' };
const browser = { 'User-Agent': 'Mozilla/5.0 (smoke test)' };

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(path, { method = 'GET', body, headers = admin } = {}) {
  const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

const server = spawn(process.execPath, [fileURLToPath(new URL('../dev-server.js', import.meta.url))], {
  env: { ...process.env, PORT: String(PORT), ADMIN_PASSWORD: PASSWORD, DATABASE_URL: '', POSTGRES_URL: '' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
server.stdout.on('data', () => {});

async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    try {
      if ((await fetch(base + '/api/data')).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('dev server did not start');
}

try {
  await waitForServer();

  // A route that imports something no longer exported dies before it can answer, and the page
  // only ever sees a bare 500. Loading every route here names the file and the missing piece.
  console.log('\n모듈');
  const apiDir = fileURLToPath(new URL('../api/', import.meta.url));
  const routes = (await readdir(apiDir, { recursive: true })).filter((f) => f.endsWith('.js')).sort();
  for (const name of routes) {
    const shown = name.replaceAll('\\', '/');
    try {
      await import(pathToFileURL(join(apiDir, name)).href);
      check(`${shown} 가 불러와짐`, true);
    } catch (err) {
      check(`${shown} 가 불러와짐`, false, err.message);
    }
  }

  console.log('\n로그인');
  check('비밀번호가 틀리면 거절', (await api('/api/memo', { headers: { 'x-admin-password': 'nope' } })).status === 401);
  check('맞으면 통과', (await api('/api/memo')).status === 200);

  console.log('\n메모');
  const seeded = (await api('/api/memo')).body.memos;
  check('기본 글 2개가 있고 공지가 맨 위', seeded.length === 2 && seeded[0].title === '공지',
    seeded.map((m) => m.title).join(' / '));

  const photo = 'https://objectstorage.ap-tokyo-1.oraclecloud.com/n/ns/b/hai/o/hai%2F1-a.png';
  const clip = 'https://objectstorage.ap-tokyo-1.oraclecloud.com/n/ns/b/hai/o/hai%2F2-b.mp4';
  const body = `![](${photo})\n![](${clip})\n설명입니다`;
  const created = (await api('/api/memo', { method: 'POST', body: { title: '테스트', body } })).body.memo;
  check('새 글이 저장됨', created?.body === body);
  check('새 글이 맨 위로', (await api('/api/memo')).body.memos[0].id === created.id);

  const withCaptions = `![첫 사진 설명](${photo})\n![](${clip})\n글 전체 설명`;
  const captioned = (await api('/api/memo', { method: 'POST', body: { title: '사진별 설명', body: withCaptions } })).body.memo;
  check('사진별 설명이 그대로 저장됨', captioned?.body === withCaptions);
  const reread = (await api('/api/memo')).body.memos.find((m) => m.id === captioned.id);
  check('다시 읽어도 설명이 붙어 있음', reread.body.includes('![첫 사진 설명]('), reread.body.slice(0, 60));
  await api(`/api/memo?id=${captioned.id}`, { method: 'DELETE' });

  const edited = await api('/api/memo', { method: 'PUT', body: { id: created.id, version: created.version, title: '테스트2', body } });
  check('수정되면 version이 올라감', edited.body.memo?.version === created.version + 1);
  const stale = await api('/api/memo', { method: 'PUT', body: { id: created.id, version: created.version, body } });
  check('오래된 version으로 저장하면 409', stale.status === 409);
  check('수정해도 순서는 작성 시각 기준', (await api('/api/memo')).body.memos[0].id === created.id);

  console.log('\n댓글과 좋아요');
  const top = (await api('/api/memo?action=comment', { method: 'POST', body: { memoId: created.id, body: '댓글' } })).body.comment;
  const reply = (await api('/api/memo?action=comment', { method: 'POST', body: { memoId: created.id, body: '답글', parentId: top.id } })).body.comment;
  const deep = (await api('/api/memo?action=comment', { method: 'POST', body: { memoId: created.id, body: '답답글', parentId: reply.id } })).body.comment;
  check('답글은 한 단계까지만', reply.parentId === top.id && deep.parentId === top.id);

  const liked = (await api('/api/memo?action=like', { method: 'POST', body: { memoId: created.id, like: true } })).body;
  const again = (await api('/api/memo?action=like', { method: 'POST', body: { memoId: created.id, like: true } })).body;
  check('같은 브라우저는 한 번만 셈', liked.likes === 1 && again.likes === 1);
  const other = await api('/api/memo', { headers: { ...admin, 'x-client-id': 'smoke-client-2' } });
  const seen = other.body.memos.find((m) => m.id === created.id);
  check('다른 브라우저에는 눌린 표시가 없음', seen.likes === 1 && seen.liked === false);
  check('댓글 3개가 글에 붙어 있음', seen.comments.length === 3);

  console.log('\n눈');
  // The movement is plain arithmetic on purpose, so it can be checked without a browser.
  const { flakeCount, makeFlake, stepFlakes } = await import(
    pathToFileURL(fileURLToPath(new URL('../assets/snow.js', import.meta.url))).href);
  check('화면이 넓을수록 눈송이가 많아짐', flakeCount(1440, 900) > flakeCount(390, 780));
  check('눈송이 수에 상한이 있음', flakeCount(6000, 4000) === 220);

  const snow = Array.from({ length: 60 }, () => makeFlake(800, 600));
  const before = snow.map((f) => f.y);
  stepFlakes(snow, 0.5, 800, 600);
  check('눈이 아래로 내림', snow.every((f, i) => f.y > before[i] || f.y < 0));

  const lander = { ...makeFlake(800, 600), x: 400, y: 599, r: 2, fall: 100, drift: 0, sway: 0, swaySpeed: 0 };
  stepFlakes([lander], 0.5, 800, 600);
  check('바닥에 닿은 눈은 위에서 다시 시작', lander.y < 0);

  const strayLeft = { ...makeFlake(800, 600), x: -50, y: 300, r: 2, fall: 0, drift: 0, sway: 0, swaySpeed: 0 };
  const strayRight = { ...strayLeft, x: 860 };
  stepFlakes([strayLeft, strayRight], 0.1, 800, 600);
  check('옆으로 벗어난 눈은 반대편에서 들어옴', strayLeft.x > 700 && strayRight.x < 100,
    `${strayLeft.x} / ${strayRight.x}`);

  const far = Array.from({ length: 40 }, () => makeFlake(800, 600));
  stepFlakes(far, 0.05, 800, 600);
  check('눈송이가 화면 안에 머무름', far.every((f) => f.x >= -f.r - 1 && f.x <= 800 + f.r + 1));

  const { treeSvg } = await import(
    pathToFileURL(fileURLToPath(new URL('../assets/tree.js', import.meta.url))).href);
  const tree = treeSvg();
  check('트리에 별과 전구가 달려 있음',
    tree.includes('tree-star') && (tree.match(/tree-light/g) ?? []).length >= 10);
  check('전구마다 깜빡이는 시점이 다름', new Set(tree.match(/--d:[\d.]+s/g)).size >= 10);

  console.log('\n파일 대조');
  // The store calls a file hai/x.jpg; a link in a post spells the same thing hai%2Fx.jpg.
  // Reading only one of the two once made every file look unused, which is a deletion away
  // from an empty store.
  const { keysUsedIn } = await import(
    pathToFileURL(fileURLToPath(new URL('../api/upload.js', import.meta.url))).href);
  const oracle = 'https://objectstorage.ap-tokyo-1.oraclecloud.com/n/ns/b/bk/o/hai%2F111-a.jpg';
  check('주소에 인코딩된 파일을 알아봄', keysUsedIn(oracle).has('hai/111-a.jpg'));
  check('슬래시 그대로인 옛 주소도 알아봄', keysUsedIn('x/hai/222-b.png y').has('hai/222-b.png'));
  check('같은 파일은 철자가 달라도 하나로 셈',
    keysUsedIn('hai%2F333-c.webp ... hai/333-c.webp').size === 1);
  check('쓰이지 않는 파일은 포함하지 않음', !keysUsedIn(oracle).has('hai/999-zz.jpg'));

  console.log('\n사진·동영상 올리기');
  // Locally there is no cloud storage, so files land in a temp folder and are served back from it.
  const raw = (extra) => ({ 'Content-Type': 'application/octet-stream', 'x-admin-password': PASSWORD, ...extra });
  const bytes = Buffer.from('smoke-test-bytes');
  const shot = await fetch(`${base}/api/upload`, { method: 'POST', headers: raw({ 'x-image-type': 'image/png' }), body: bytes });
  const shotUrl = (await shot.json()).url || '';
  check('사진이 올라감', shot.status === 200 && shotUrl.includes('/api/upload?file='));
  check('올린 사진을 다시 받을 수 있음', Buffer.from(await (await fetch(shotUrl)).arrayBuffer()).equals(bytes));

  const badType = await api('/api/upload?video=start', { method: 'POST', body: { type: 'video/avi', size: 10 } });
  check('지원하지 않는 동영상 형식은 거절', badType.status === 400);
  const tooBig = await api('/api/upload?video=start', { method: 'POST', body: { type: 'video/mp4', size: 999 * 1024 * 1024 } });
  check('너무 큰 동영상은 거절', tooBig.status === 413);

  const start = await api('/api/upload?video=start', { method: 'POST', body: { type: 'video/mp4', size: bytes.length } });
  check('동영상 올릴 곳을 받음', start.status === 200 && typeof start.body.uploadUrl === 'string');
  const put = await fetch(base + start.body.uploadUrl, { method: 'PUT', headers: raw(), body: bytes });
  const clipUrl = (await put.json()).url || '';
  check('동영상이 올라감', put.status === 200 && clipUrl.includes('/api/upload?file='));
  check('올린 동영상을 다시 받을 수 있음', Buffer.from(await (await fetch(clipUrl)).arrayBuffer()).equals(bytes));

  console.log('\n정리');
  const tidyBefore = (await api('/api/memo?action=tidy')).body;
  check('남은 기록 점검이 동작', typeof tidyBefore.stray?.comments === 'number');
  await api(`/api/memo?id=${created.id}`, { method: 'DELETE' });
  const after = (await api('/api/memo')).body.memos;
  check('글을 지우면 목록에서 사라짐', !after.some((m) => m.id === created.id));
  const tidyAfter = (await api('/api/memo?action=tidy')).body;
  check('글과 함께 댓글·좋아요도 사라짐', tidyAfter.stray.comments === 0 && tidyAfter.stray.likes === 0,
    JSON.stringify(tidyAfter.stray));

  console.log('\n방문자 통계');
  const hit = (opts) => api('/api/stats', { method: 'POST', headers: { ...browser, 'Content-Type': 'application/json' }, ...opts });
  await hit({ body: { type: 'home', newVisitor: true } });
  await hit({ body: { type: 'home', newVisitor: false } });
  await hit({ body: { type: 'paper', id: 'welcome-paper', newVisitor: false } });
  check('잘못된 경로는 거절', (await hit({ body: { type: 'paper', id: '../etc' } })).status === 400);
  const bot = await api('/api/stats', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Googlebot/2.1' }, body: { type: 'home' } });
  check('봇은 세지 않음', bot.body.skipped === 'bot');
  const stats = (await api('/api/stats')).body;
  check('오늘 방문 3, 방문자 1', stats.today.views === 3 && stats.today.visitors === 1,
    JSON.stringify(stats.today));
  check('페이지별로 나뉘어 집계', stats.pages.find((p) => p.path === 'home')?.views === 2);
  check('30일치 그래프 데이터', stats.days.length === 30);

  console.log('\n홈페이지 내용');
  const data = (await api('/api/data')).body;
  check('공개 API가 내용과 논문을 돌려줌', Boolean(data.content?.hero) && Array.isArray(data.papers));
  check('공개 API에 메모는 없음', !JSON.stringify(data).includes('memos'));
  const papers = [{ ...data.papers[0], title: '수정된 논문' }];
  check('논문 저장', (await api('/api/data', { method: 'PUT', body: { papers } })).status === 200);
  check('저장된 논문이 다시 읽힘', (await api('/api/data')).body.papers[0].title === '수정된 논문');
} catch (err) {
  failures.push(`테스트 실행 중 오류 — ${err.message}`);
  console.error(err);
} finally {
  server.kill();
}

console.log(`\n${passed}개 통과, ${failures.length}개 실패`);
if (failures.length) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
