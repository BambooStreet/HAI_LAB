import { getJSON, setJSON } from './_lib/store.js';
import { send, isAdmin, readBody } from './_lib/http.js';
import { DEFAULT_CONTENT, DEFAULT_PAPERS, cleanContent, cleanPapers } from './_lib/schema.js';

const CONTENT_KEY = 'hai:content';
const PAPERS_KEY = 'hai:papers';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const [content, papers] = await Promise.all([getJSON(CONTENT_KEY), getJSON(PAPERS_KEY)]);
      return send(res, 200, {
        content: { ...DEFAULT_CONTENT, ...(content || {}) },
        papers: papers ?? DEFAULT_PAPERS,
      });
    }

    if (req.method === 'PUT') {
      if (!isAdmin(req)) return send(res, 401, { error: '비밀번호가 올바르지 않습니다.' });
      const body = readBody(req);
      if (body.content !== undefined) await setJSON(CONTENT_KEY, cleanContent(body.content));
      if (body.papers !== undefined) await setJSON(PAPERS_KEY, cleanPapers(body.papers));
      return send(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, PUT');
    return send(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    if (err.message === 'NO_DB') {
      return send(res, 503, { error: '데이터베이스가 연결되지 않았습니다. Vercel 프로젝트에 Upstash Redis를 연결해 주세요.' });
    }
    console.error(err);
    return send(res, 500, { error: '서버 오류가 발생했습니다.' });
  }
}
