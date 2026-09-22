// Admin-only memo board. Kept out of /api/data because that endpoint is publicly readable.
import { send, isAdmin, readBody } from './_lib/http.js';
import { listMemos, createMemo, updateMemo, deleteMemo, cleanMemo } from './_lib/memos.js';

export default async function handler(req, res) {
  try {
    if (!isAdmin(req)) return send(res, 401, { error: '비밀번호가 올바르지 않습니다.' });

    if (req.method === 'GET') return send(res, 200, { memos: await listMemos() });

    if (req.method === 'POST' || req.method === 'PUT') {
      const body = readBody(req);
      const m = cleanMemo(body);
      if (!m.title && !m.body.trim()) return send(res, 400, { error: '제목이나 내용을 입력해 주세요.' });
      if (req.method === 'POST') return send(res, 200, { memo: await createMemo(m) });

      const result = await updateMemo(String(body.id ?? ''), Number(body.version), m);
      if (result.missing) return send(res, 404, { error: '이미 삭제된 글입니다.' });
      if (result.conflict) return send(res, 409, { error: '다른 곳에서 이 글이 수정되었습니다.', current: result.conflict });
      return send(res, 200, { memo: result });
    }

    if (req.method === 'DELETE') {
      const id = new URL(req.url, 'http://x').searchParams.get('id');
      if (!id) return send(res, 400, { error: 'id가 없습니다.' });
      await deleteMemo(id);
      return send(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return send(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    if (err.message === 'NO_DB') {
      return send(res, 503, { error: '데이터베이스가 연결되지 않아 메모를 저장할 수 없습니다.' });
    }
    console.error(err);
    return send(res, 500, { error: '서버 오류가 발생했습니다.' });
  }
}
