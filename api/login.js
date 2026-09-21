import { hasDb, hasBlob } from './_lib/store.js';
import { send, isAdmin, passwordRequired } from './_lib/http.js';

export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Method not allowed' });
  }
  if (!isAdmin(req)) return send(res, 401, { error: '비밀번호가 올바르지 않습니다.' });
  const local = !process.env.VERCEL;
  // Env var *names* only (never values), to help diagnose a missing Blob connection.
  const blobEnv = Object.keys(process.env).filter((k) => /BLOB|READ_WRITE/i.test(k));
  return send(res, 200, { ok: true, db: hasDb || local, blob: hasBlob || local, blobEnv, passwordRequired: passwordRequired() });
}
