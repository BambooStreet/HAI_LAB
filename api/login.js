import { hasDb } from './_lib/store.js';
import { send, isAdmin } from './_lib/http.js';

export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Method not allowed' });
  }
  if (!process.env.ADMIN_PASSWORD) {
    return send(res, 500, { error: 'ADMIN_PASSWORD 환경변수가 설정되지 않았습니다.' });
  }
  if (!isAdmin(req)) return send(res, 401, { error: '비밀번호가 올바르지 않습니다.' });
  return send(res, 200, { ok: true, db: hasDb || !process.env.VERCEL });
}
