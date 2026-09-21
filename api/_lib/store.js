// Neon Postgres key-value store: one row per key, value stored as jsonb.
// Vercel's Neon integration injects DATABASE_URL (or <PREFIX>_DATABASE_URL when connected with a custom prefix).
const DATABASE_URL =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  Object.entries(process.env).find(([k, v]) => k.endsWith('DATABASE_URL') && /^postgres(ql)?:\/\//.test(v || ''))?.[1];

export const hasDb = Boolean(DATABASE_URL);

// Blob token: default name is BLOB_READ_WRITE_TOKEN, but a store connected with a custom prefix uses <PREFIX>_READ_WRITE_TOKEN.
export const blobToken =
  process.env.BLOB_READ_WRITE_TOKEN ||
  Object.entries(process.env).find(([k, v]) => /BLOB|READ_WRITE/i.test(k) && k.endsWith('TOKEN') && v?.startsWith('vercel_blob_'))?.[1] ||
  '';

// Local dev without a database falls back to memory; on Vercel that would silently lose data, so it errors instead.
const memory = new Map();

let sqlPromise;
function db() {
  sqlPromise ??= (async () => {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(DATABASE_URL);
    await sql`CREATE TABLE IF NOT EXISTS hai_kv (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
    return sql;
  })().catch((err) => {
    sqlPromise = undefined;
    throw err;
  });
  return sqlPromise;
}

export async function getJSON(key) {
  if (!hasDb) return memory.get(key) ?? null;
  const sql = await db();
  const rows = await sql`SELECT value FROM hai_kv WHERE key = ${key}`;
  return rows[0]?.value ?? null;
}

export async function setJSON(key, value) {
  if (!hasDb) {
    if (process.env.VERCEL) throw new Error('NO_DB');
    memory.set(key, value);
    return;
  }
  const sql = await db();
  await sql`INSERT INTO hai_kv (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}
