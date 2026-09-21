// Upstash Redis REST client (no dependencies).
// Vercel's Upstash integration injects KV_REST_API_* ; plain Upstash uses UPSTASH_REDIS_REST_*.
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const hasDb = Boolean(REDIS_URL && REDIS_TOKEN);

// Local dev without Redis falls back to memory; on Vercel that would silently lose data, so it errors instead.
const memory = new Map();

async function redis(args) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error || `Redis HTTP ${res.status}`);
  return json.result;
}

export async function getJSON(key) {
  if (!hasDb) return memory.get(key) ?? null;
  const value = await redis(['GET', key]);
  return value == null ? null : JSON.parse(value);
}

export async function setJSON(key, value) {
  if (!hasDb) {
    if (process.env.VERCEL) throw new Error('NO_DB');
    memory.set(key, value);
    return;
  }
  await redis(['SET', key, JSON.stringify(value)]);
}
