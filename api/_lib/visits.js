// Visitor counters. One row per (day, path) so concurrent hits increment atomically
// instead of racing through a read-modify-write on the KV store.
//
// path '*' holds the per-day site totals (views = every hit, visitors = unique people);
// 'home' and 'paper:<id>' rows hold views only, so summing paths never double-counts visitors.
import { hasDb, sql, once } from './store.js';

const TZ = 'Asia/Seoul';
export const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ });

export const daysAgo = (n, from = today()) => {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

// Crawlers hit the page but never run the beacon; this only catches the odd scripted client.
const BOT = /bot|crawl|spider|slurp|facebookexternalhit|headless|lighthouse|pingdom|curl|wget|python-requests/i;
export const isBot = (ua) => BOT.test(String(ua || ''));

// Local dev without DATABASE_URL: keep counts in memory so the admin tab still has something to show.
const memory = new Map(); // `${day}\n${path}` -> { views, visitors }
const bump = (day, path, views, visitors) => {
  const key = `${day}\n${path}`;
  const row = memory.get(key) ?? { views: 0, visitors: 0 };
  memory.set(key, { views: row.views + views, visitors: row.visitors + visitors });
};

const table = {};
async function db() {
  const q = await sql();
  await once(table, () => q`CREATE TABLE IF NOT EXISTS hai_visits (
    day date NOT NULL,
    path text NOT NULL,
    views integer NOT NULL DEFAULT 0,
    visitors integer NOT NULL DEFAULT 0,
    PRIMARY KEY (day, path)
  )`);
  return q;
}

export async function recordVisit(path, newVisitor) {
  if (path === '*') throw new Error('reserved path');
  const day = today();
  const unique = newVisitor ? 1 : 0;

  if (!hasDb) {
    bump(day, '*', 1, unique);
    bump(day, path, 1, 0);
    return;
  }
  const q = await db();
  await q`INSERT INTO hai_visits (day, path, views, visitors)
    VALUES (${day}, '*', 1, ${unique}), (${day}, ${path}, 1, 0)
    ON CONFLICT (day, path) DO UPDATE
      SET views = hai_visits.views + EXCLUDED.views,
          visitors = hai_visits.visitors + EXCLUDED.visitors`;
}

const sum = (rows) => rows.reduce(
  (a, r) => ({ views: a.views + r.views, visitors: a.visitors + r.visitors }),
  { views: 0, visitors: 0 },
);

// Fills gaps so the chart has one bar per day even on days nobody came by.
function fillDays(rows, span) {
  const end = today();
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return Array.from({ length: span }, (_, i) => {
    const day = daysAgo(span - 1 - i, end);
    const r = byDay.get(day);
    return { day, views: r?.views ?? 0, visitors: r?.visitors ?? 0 };
  });
}

export async function readStats(span = 30) {
  const start = daysAgo(span - 1);

  if (!hasDb) {
    const all = [...memory].map(([key, v]) => {
      const [day, path] = key.split('\n');
      return { day, path, ...v };
    });
    const totals = all.filter((r) => r.path === '*');
    const pages = new Map();
    for (const r of all) if (r.path !== '*') pages.set(r.path, (pages.get(r.path) ?? 0) + r.views);
    return build(
      totals.filter((r) => r.day >= start).map(({ day, views, visitors }) => ({ day, views, visitors })),
      sum(totals),
      [...pages].map(([path, views]) => ({ path, views })).sort((a, b) => b.views - a.views).slice(0, 50),
      span,
    );
  }

  const q = await db();
  const [daily, total, pages] = await Promise.all([
    q`SELECT to_char(day, 'YYYY-MM-DD') AS day, views, visitors
        FROM hai_visits WHERE path = '*' AND day >= ${start}::date ORDER BY day`,
    q`SELECT COALESCE(SUM(views), 0)::int AS views, COALESCE(SUM(visitors), 0)::int AS visitors
        FROM hai_visits WHERE path = '*'`,
    q`SELECT path, SUM(views)::int AS views
        FROM hai_visits WHERE path <> '*' GROUP BY path ORDER BY views DESC LIMIT 50`,
  ]);
  return build(daily, total[0] ?? { views: 0, visitors: 0 }, pages, span);
}

function build(daily, total, pages, span) {
  const days = fillDays(daily, span);
  return {
    hasDb,
    today: days.at(-1) ?? { views: 0, visitors: 0 },
    week: sum(days.slice(-7)),
    month: sum(days),
    total,
    days,
    pages,
  };
}
