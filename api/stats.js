import { send, isAdmin, readBody } from './_lib/http.js';
import { recordVisit, readStats, isBot } from './_lib/visits.js';

const PAPER_ID = /^[\w.:-]{1,40}$/;

export default async function handler(req, res) {
  try {
    // Public: the site beacons one hit per page view. Never let a counter failure surface to visitors.
    if (req.method === 'POST') {
      if (isBot(req.headers['user-agent'])) return send(res, 200, { ok: true, skipped: 'bot' });
      const body = readBody(req);
      const path =
        body.type === 'home' ? 'home' :
        body.type === 'paper' && PAPER_ID.test(body.id ?? '') ? `paper:${body.id}` :
        null;
      if (!path) return send(res, 400, { error: 'bad path' });
      try {
        await recordVisit(path, body.newVisitor === true);
      } catch (err) {
        console.error('visit not recorded:', err.message);
      }
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 401, { error: '비밀번호가 올바르지 않습니다.' });
      return send(res, 200, await readStats(30));
    }

    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: '서버 오류가 발생했습니다.' });
  }
}
