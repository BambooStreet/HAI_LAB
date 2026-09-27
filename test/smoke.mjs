// Smoke test: starts the dev server on its own port with in-memory data (never touches the real
// database) and walks the API the admin page uses. Run with: npm test
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

  console.log('\n로그인');
  check('비밀번호가 틀리면 거절', (await api('/api/memo', { headers: { 'x-admin-password': 'nope' } })).status === 401);
  check('맞으면 통과', (await api('/api/memo')).status === 200);

  console.log('\n메모');
  const seeded = (await api('/api/memo')).body.memos;
  check('기본 글 2개가 있고 공지가 맨 위', seeded.length === 2 && seeded[0].title === '공지',
    seeded.map((m) => m.title).join(' / '));

  const photo = 'https://x.public.blob.vercel-storage.com/hai/1-a.png';
  const clip = 'https://x.public.blob.vercel-storage.com/hai/2-b.mp4';
  const body = `![](${photo})\n![](${clip})\n설명입니다`;
  const created = (await api('/api/memo', { method: 'POST', body: { title: '테스트', body } })).body.memo;
  check('새 글이 저장됨', created?.body === body);
  check('새 글이 맨 위로', (await api('/api/memo')).body.memos[0].id === created.id);

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
