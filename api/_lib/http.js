import { createHash, timingSafeEqual } from 'node:crypto';

export function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

// The client URI-encodes the password so non-ASCII (e.g. Korean) survives the header.
export function isAdmin(req) {
  const expected = process.env.ADMIN_PASSWORD;
  const raw = req.headers['x-admin-password'];
  if (!expected || typeof raw !== 'string') return false;
  let given;
  try {
    given = decodeURIComponent(raw);
  } catch {
    return false;
  }
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  return {};
}
