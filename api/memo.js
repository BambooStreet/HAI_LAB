// Admin-only scratch memo. Kept out of /api/data because that endpoint is publicly readable.
import { getJSON, setJSON } from './_lib/store.js';
import { send, isAdmin, readBody } from './_lib/http.js';

const MEMO_KEY = 'hai:memo';
const EMPTY = { text: '', updatedAt: '' };

export default async function handler(req, res) {
  try {
    if (!isAdmin(req)) return send(res, 401, { error: '비밀번호가 올바르지 않습니다.' });

    if (req.method === 'GET') {
      return send(res, 200, { ...EMPTY, ...((await getJSON(MEMO_KEY)) || {}) });
    }

    if (req.method === 'PUT') {
      const body = readBody(req);
      if (typeof body.text !== 'string') return send(res, 400, { error: '메모 내용이 없습니다.' });
      // Optimistic check: refuse to overwrite a version the client never saw (another admin saved meanwhile).
      const current = { ...EMPTY, ...((await getJSON(MEMO_KEY)) || {}) };
      if ((body.base ?? '') !== current.updatedAt) {
        return send(res, 409, { error: '다른 곳에서 메모가 수정되었습니다.', current });
      }
      const next = { text: body.text.slice(0, 100000), updatedAt: new Date().toISOString() };
      await setJSON(MEMO_KEY, next);
      return send(res, 200, next);
    }

    res.setHeader('Allow', 'GET, PUT');
    return send(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    if (err.message === 'NO_DB') {
      return send(res, 503, { error: '데이터베이스가 연결되지 않아 메모를 저장할 수 없습니다.' });
    }
    console.error(err);
    return send(res, 500, { error: '서버 오류가 발생했습니다.' });
  }
}
