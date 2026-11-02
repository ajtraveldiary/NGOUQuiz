// Kerala NGO Union Quiz — Cloudflare Worker (API + hidden admin page)
// Static game files are served from /public by Workers Static Assets. Data is in Cloudflare D1 (binding DB).
import ADMIN_HTML from './admin.html';
import SCHEMA_SQL from '../db/schema.sql';
import SEED_QUESTIONS from '../db/seed-questions.json';
import PKG from '../package.json';

const VERSION = PKG.version; // bump in package.json with every pushed change

const DISTRICTS = [
  'Thiruvananthapuram North', 'Thiruvananthapuram South', 'Kollam', 'Pathanamthitta', 'Alappuzha', 'Kottayam', 'Idukki', 'Ernakulam',
  'Thrissur', 'Palakkad', 'Malappuram', 'Kozhikode', 'Wayanad', 'Kannur', 'Kasaragod',
];
const LEVELS = ['easy', 'medium', 'hard'];

const DEFAULT_SETTINGS = {
  title: 'Arivu Quiz',
  subtitle: 'Kerala NGO Union',
  tagline: 'Know the facts. Defend our rights.',
  values: ['Solidarity', 'Democracy', 'Secularism', 'People-centred public service'],
  easy: 4, medium: 4, hard: 2,
  timeLimitSec: 15,
  points: { easy: 100, medium: 150, hard: 200 },
  penalty: { easy: 25, medium: 40, hard: 50 },   // marks lost for a wrong answer (0 = no negative marking)
  streakBonus: 25,
  streakCap: 100,
  maxAttempts: 0,          // 0 = unlimited replays (best score counts)
  open: true,              // false = quiz closed to new games
  showExplanation: true,
  bonusQuestion: true,     // after the regular questions, one bonus question about the campaign programme (no negative marks)
  // share of each question category among the regular questions (percent); difficulty levels are matched as closely as possible
  categoryMix: [
    { name: 'Political', percent: 60 },
    { name: 'Constitution', percent: 10 },
    { name: 'KSR & Govt rules', percent: 20 },
    { name: 'General political', percent: 10 },
  ],
  campaign: {
    show: true,
    name: 'Secretariat Valayal',
    nameMl: 'സെക്രട്ടേറിയറ്റ് വളയൽ',
    date: '2026-11-21',
    place: 'Thiruvananthapuram',
    organiser: 'Action Council of State Employees & Teachers',
    line: 'Over 25,000 employees and teachers will encircle the Secretariat to protect the rights we have won.',
    demands: [
      'Implement the pay revision now; grant interim relief',
      'Withdraw NPS and restore the old pension; repeal the PFRDA Act',
      'Implement the DA arrears order without delay',
      'Restore earned leave surrender',
      'Cancel unfair transfers; hold general transfers as per norms',
      'Fix the shortcomings in MEDISEP',
      'Drop moves that weaken education and the civil service',
    ],
  },
};

const GRACE_MS = 400;          // network allowance subtracted from measured time
const SKIP_AFTER_MS = 5000;    // Skip opens this long into a question (the game shows a countdown on the button)
const LATE_MS = 1500;          // answers arriving later than limit + this count as timeouts
const RESUME_WINDOW = '-1 hour';  // SQLite date modifier
// the current time as stored in the database (ISO text in UTC)
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
// milliseconds since a stored time, by the database clock
const MS_SINCE = (col) => `CAST(round((julianday('now') - julianday(${col})) * 86400000) AS INTEGER)`;

// ---------- helpers ----------
const enc = new TextEncoder();
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
class HttpError extends Error { constructor(status, msg, headers) { super(msg); this.status = status; this.headers = headers; } }
const fail = (status, msg, headers) => { throw new HttpError(status, msg, headers); };

async function body(req) {
  const text = await req.text();
  if (text.length > 512_000) fail(413, 'Request is too large.');
  try { return text ? JSON.parse(text) : {}; } catch { fail(400, 'Request body must be JSON.'); }
}
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function randInt(n) { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; }
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Columns stored as JSON text and as 1/0, turned back into lists/objects and true/false when read
const JSON_COLS = new Set(['options', 'option_orders', 'config', 'question_ids', 'value']);
const BOOL_COLS = new Set(['campaign', 'active', 'is_correct', 'skipped', 'created']);
function readRow(r) {
  for (const k in r) {
    if (r[k] === null) continue;
    if (JSON_COLS.has(k) && typeof r[k] === 'string') r[k] = JSON.parse(r[k]);
    else if (BOOL_COLS.has(k)) r[k] = !!r[k];
  }
  return r;
}
// Parameters are written $1, $2 …; lists and objects are sent as JSON text, true/false as 1/0
const bindValue = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0)
  : v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
// (a statement may use only some of a shared parameter list; D1 wants exactly as many values as the highest number)
function prep(DB, text, params) {
  const used = Math.max(0, ...[...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  return DB.prepare(text.replace(/\$(\d+)/g, '?$1')).bind(...params.slice(0, used).map(bindValue));
}

const dbCache = new WeakMap();
function db(env) {
  if (!env.DB) fail(500, 'The D1 database is not connected. Add the DB binding ([[d1_databases]]) in wrangler.toml and deploy again.');
  let d = dbCache.get(env.DB);
  if (!d) {
    const DB = env.DB;
    d = {
      q: async (text, params = []) => (await prep(DB, text, params).all()).results.map(readRow),
      // several statements in one database transaction (one round trip); returns the rows of each
      tx: async (list) => (await DB.batch(list.map(([text, params = []]) => prep(DB, text, params))))
        .map((r) => (r.results || []).map(readRow)),
    };
    dbCache.set(env.DB, d);
  }
  return d;
}
async function sha256Hex(s) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- automatic database setup ----------
// Creates missing tables, upgrades older databases and loads starter questions into an empty pool.
// Runs once per Worker instance; afterwards it costs a single quick check.
const SCHEMA_VERSION = 12;
// Questions hidden by v10 (the bonus questions and those naming an organisation), by SHA-256 of their text;
// v12 shows them again
const RETIRED_QUESTIONS = [
  '094cb9259c1aeef799e6b7861d92f547b74210d01cfbe56697d4babe4d859ae6', '0a975fca49c76b20851615149e6d5186bc895ad64ef35172028c16ecd61fb7f8',
  '0d6962700d0893f874c9fad1163bc18de343e4dd043f3a6e9144e20698c9d1a9', '0f4a1132588870524a9a88e48ef238c65c60d0e9adffd55db20851c348bb9d88',
  '187acd10ac85924f1ff45f198a32048ba01980295e7db94d1ff01e0291b6bf8f', '191f58b72f3448a37398c24fe9fa6e59bbca370409a10f2909971ead340faf65',
  '2e05d28bc24911123b1f3162c0f83bacb2a69a2ecf962fd3b1b576522f2dafd1', '48b832a5fcfd5d408a1fde90523351da75d5b6901c8f57da1fd36989a58e7d49',
  '59b3dbd35e0324f0cda28a0af646f28eba72b56f388d77d4798ea3d3e6566f17', '61121e30c759cedd50037f8908d3a3d759f5429db5b6003e69a248adbb1dbadd',
  '636080d3817895760abf7a3114618bd805a85bb98c8b774a605ebe3dbb9406de', '6d1781b30ea4c8183a89d224c7caf89417ca81d62449d72a1cee7397999626c9',
  '7c76b8e0aa3245e786ed5e673772b4bac1a66aa4d01f7d2b3b04d7f5b8f5f474', '7d675ef389177e07e79a736b6fee48db3efbb93a9285ef3f3d12026210973c1d',
  '7ed3b129e60fddf844f0060799c1a755b2131d3f3e8ff8c807e067818851edce', '8a3716fccc3d28bc0d03de2d01225ef36eb8bfcca17363ce9727340d51c1877a',
  '9bca6b942eb639b93fb86370198f637a0bc1966a6f1dc76d22ef8891ba9cd263', '9cf2959f6213df7b35a4c0985c28adfe8ad52426a9719beb659d8682d09ef3d2',
  'a1642c86eee0076a82eedc3366435220034c76b4c8c0c640e525574b416e4fb2', 'aacad52882b660fe0a02da93f57c534731f006605e05e1d82af4c83bff0a08af',
  'b079fd2b068abf2048abeb7c2c5c91c74a0e5c4c66ae7ed1d2d6dfacda72ea85', 'c4479f59dbc495e288ecaa05a55e57108bfdb30afdec18954d79b860dba47d68',
  'cb97baa4cd34988dd0d29dc235f0dcd09d0fda0fab6664ede114a4741ac3bf81', 'cc8cca66c82514db47269cf62094e02e8c49d4285b30ef9864b648b56badfc49',
  'e7934755a611e5751b45542f765ee1491c45852cba40b5c17a75534df660b1f0', 'f513e6741dbc4652b96501c9c61dcb590b8998dcaa238f59f1f762748903e246',
  'fc0afe5b3bd5b6d5ed26faa4c1d355cf0b6829d920c1214be7bc8c53e6001198',
];
const schemaReady = new Map(); // per database
function sqlStatements(text) {
  return text.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    .split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean);
}
// Many rows go to D1 as one JSON list parameter (D1 allows only 100 parameters per statement) and are read back with json_each
const fromJsonRows = (cols) => `SELECT ${cols.map((c) => (c === 'options'
  ? `json(json_extract(value, '$.options'))` : `json_extract(value, '$.${c}')`) + ' AS ' + c).join(', ')} FROM json_each($1)`;
const Q_COLS = ['question', 'options', 'correct_index', 'difficulty', 'category', 'explanation', 'topic', 'campaign', 'active'];
const questionRow = (q) => ({
  question: q.question, options: q.options, correct_index: q.correct, difficulty: q.difficulty, category: q.category || null,
  explanation: q.explanation || null, topic: q.topic || null, campaign: q.campaign ? 1 : 0, active: q.active === false ? 0 : 1,
});
let lastUpgradeError = null;   // shown on /api/health
async function ensureSchema(env, d) {
  const key = env.DB;
  if (!schemaReady.has(key)) {
    schemaReady.set(key, (async () => {
      let current = 0;
      try {
        const r = await d.q(`SELECT value FROM settings WHERE key = 'schema_version'`);
        current = Number(r[0]?.value) || 0;
        if (current >= SCHEMA_VERSION) return;
      } catch (e) {
        if (!/no such table/i.test(String(e?.message))) throw e;
      }
      // 1. tables (idempotent statements, one batch)
      await d.tx(sqlStatements(SCHEMA_SQL).map((s) => [s]));
      // 2. data. If this step fails the quiz keeps running on the questions it has, and /api/health shows the error.
      //    Every step checks the stored version, so when two Worker instances upgrade at once only the first changes anything.
      try {
        const version = `(SELECT coalesce(max(CAST(value AS INTEGER)), 0) FROM settings WHERE key = 'schema_version')`;
        const steps = [];
        const existing = await d.q(`SELECT id, question FROM questions`);
        // a new database gets the starter question pool
        if (!existing.length) {
          steps.push([`INSERT INTO questions (${Q_COLS}) ${fromJsonRows(Q_COLS)}
            WHERE ${version} < ${SCHEMA_VERSION} AND NOT EXISTS (SELECT 1 FROM questions)`, [SEED_QUESTIONS.map(questionRow)]]);
        }
        // v12: back to the 1.9.1 quiz after v10–v11 (2.x): Thiruvananthapuram is North/South again, the questions
        // v10 hid are shown again and the starter bonus questions get their campaign flag back
        if (current >= 10 && current < 12) {
          const hidden = [];
          for (const q of existing) if (RETIRED_QUESTIONS.includes(await sha256Hex(q.question))) hidden.push(q.id);
          steps.push([`UPDATE players SET district = 'Thiruvananthapuram North' WHERE ${version} < 12 AND district = 'Thiruvananthapuram'`]);
          steps.push([`UPDATE questions SET active = 1, updated_at = ${NOW}
            WHERE ${version} < 12 AND id IN (SELECT value FROM json_each($1))`, [hidden]]);
          steps.push([`UPDATE questions SET campaign = 1, updated_at = ${NOW}
            WHERE ${version} < 12 AND question IN (SELECT value FROM json_each($1))`, [SEED_QUESTIONS.filter((q) => q.campaign).map((q) => q.question)]]);
        }
        steps.push([`INSERT INTO settings (key, value) VALUES ('schema_version', $1)
          ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [JSON.stringify(SCHEMA_VERSION)]]);
        await d.tx(steps);
        lastUpgradeError = null;
      } catch (e) {
        console.error('question upgrade failed', e);
        lastUpgradeError = explainDbError(e) || String(e?.message || e).slice(0, 300);
      }
    })().catch((e) => { schemaReady.delete(key); throw e; }));
  }
  return schemaReady.get(key);
}

// Turns low-level database errors into a message the admin can act on
function explainDbError(e) {
  const m = String(e?.message || e || '');
  if (/no such table|no such column/i.test(m)) return 'The database tables are missing or out of date. Open /api/health once to set them up.';
  if (/D1_ERROR|D1 DB|database .* (not found|unavailable)|overloaded/i.test(m)) return 'The D1 database could not be reached. Check the DB binding in wrangler.toml and try again in a minute.';
  return null;
}
function secret(env) {
  if (!env.APP_SECRET || env.APP_SECRET.length < 16) fail(500, 'APP_SECRET is not configured (min 16 chars).');
  return env.APP_SECRET;
}

async function getSettings(d) {
  const rows = await d.q(`SELECT value FROM settings WHERE key = 'game'`);
  const v = rows[0]?.value || {};
  return {
    ...DEFAULT_SETTINGS, ...v,
    points: { ...DEFAULT_SETTINGS.points, ...(v.points || {}) },
    penalty: { ...DEFAULT_SETTINGS.penalty, ...(v.penalty || {}) },
    campaign: { ...DEFAULT_SETTINGS.campaign, ...(v.campaign || {}) },
    categoryMix: Array.isArray(v.categoryMix) ? v.categoryMix : DEFAULT_SETTINGS.categoryMix,
  };
}

async function getAreas(d) {
  const rows = await d.q(`SELECT district, name FROM areas ORDER BY district, lower(name)`);
  const map = Object.fromEntries(DISTRICTS.map((x) => [x, []]));
  for (const r of rows) if (map[r.district]) map[r.district].push(r.name);
  return map;
}

// ---------- player auth ----------
async function playerKey(env, id) { return `${id}.${await hmac(secret(env), 'player:' + id)}`; }
async function verifyPlayer(env, key) {
  const [id, sig] = String(key || '').split('.');
  if (!/^\d+$/.test(id || '') || !safeEqual(sig, await hmac(secret(env), 'player:' + id))) fail(401, 'Please register again.');
  return Number(id);
}

// ---------- admin auth ----------
const loginFails = new Map(); // best-effort, per isolate
async function adminToken(env) {
  const exp = Date.now() + 12 * 3600_000;
  return `${exp}.${await hmac(secret(env), 'admin:' + exp)}`;
}
async function requireAdmin(env, req) {
  const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const [exp, sig] = tok.split('.');
  if (!exp || Number(exp) < Date.now() || !safeEqual(sig, await hmac(secret(env), 'admin:' + exp))) fail(401, 'Session expired. Log in again.');
}

// ---------- leaderboard ----------
function boardCte(withDistrict) {
  return `
    WITH games_ranked AS (
      SELECT g.player_id, g.id AS game_id, g.score, g.total_ms, g.correct_count, g.finished_at,
        ROW_NUMBER() OVER (PARTITION BY g.player_id ORDER BY g.score DESC, g.total_ms ASC, g.finished_at ASC) AS n
      FROM games g JOIN players p ON p.id = g.player_id
      WHERE g.status = 'finished' ${withDistrict ? 'AND p.district = $1' : ''}
    ),
    best AS (SELECT player_id, game_id, score, total_ms, correct_count, finished_at FROM games_ranked WHERE n = 1),
    ranked AS (
      SELECT best.*, ROW_NUMBER() OVER (ORDER BY score DESC, total_ms ASC, finished_at ASC) AS rank
      FROM best
    )`;
}
// With env, the public part (top 10, counts) is reused for 10 seconds; the player's own rank is always fresh.
// The queries run side by side.
async function leaderboard(d, district, playerId, env = null) {
  const params = district ? [district] : [];
  const pub = async () => {
    const [top, totalRow, plays] = await Promise.all([
      d.q(`${boardCte(!!district)}
        SELECT r.rank, r.player_id, r.score, r.total_ms, r.correct_count, p.name, p.office, p.district, p.area
        FROM ranked r JOIN players p ON p.id = r.player_id
        ORDER BY r.rank LIMIT 10`, params),
      d.q(`${boardCte(!!district)} SELECT count(*) AS n FROM ranked`, params),
      district || !env ? null : playCount(d), // the play count is only shown on the opening screen
    ]);
    return { top, total: totalRow[0]?.n || 0, plays };
  };
  const [board, meRows] = await Promise.all([
    env ? memo(env, 'board:' + (district || ''), 10_000, pub) : pub(),
    playerId ? d.q(
      `${boardCte(!!district)}
       SELECT r.rank, r.player_id, r.score, r.total_ms, r.correct_count, p.name, p.office, p.district, p.area
       FROM ranked r JOIN players p ON p.id = r.player_id WHERE r.player_id = $${params.length + 1}`,
      [...params, playerId]) : [],
  ]);
  const map = (x) => x && ({
    rank: x.rank, score: x.score, timeMs: x.total_ms, correct: x.correct_count,
    name: x.name, office: x.office, district: x.district, area: x.area || null, isMe: x.player_id === playerId,
  });
  return { top: board.top.map(map), me: map(meRows[0] || null), total: board.total, ...(district ? {} : { plays: board.plays }) };
}
// Every game started counts as a play (voided games don't), and so does filling in the player card:
// a player who registered but never started a game counts once
async function playCount(d) {
  const r = await d.q(`SELECT (SELECT count(*) FROM games WHERE status <> 'void')
    + (SELECT count(*) FROM players p WHERE NOT EXISTS (SELECT 1 FROM games g WHERE g.player_id = p.id AND g.status <> 'void')) AS n`);
  return Number(r[0]?.n) || 0;
}

// ---------- public API ----------
async function apiConfig(env) {
  return json(await memo(env, 'config', 10_000, () => configData(env)));
}
async function configData(env) {
  const d = db(env);
  const s = await getSettings(d);
  const counts = await d.q(`SELECT difficulty, count(*) FILTER (WHERE NOT campaign) AS n,
    count(*) FILTER (WHERE campaign) AS c FROM questions WHERE active GROUP BY difficulty`);
  const avail = Object.fromEntries(counts.map((c) => [c.difficulty, c.n]));
  const total = LEVELS.reduce((t, l) => t + Math.min(s[l], avail[l] || 0), 0);
  const hasBonus = s.bonusQuestion !== false && counts.some((c) => c.c > 0);
  const areas = await getAreas(d);
  return ({
    title: s.title, subtitle: s.subtitle, tagline: s.tagline, values: s.values,
    districts: DISTRICTS, areas, levels: { easy: s.easy, medium: s.medium, hard: s.hard },
    totalQuestions: total || s.easy + s.medium + s.hard,
    timeLimitSec: s.timeLimitSec, points: s.points, penalty: s.penalty, streakBonus: s.streakBonus, streakCap: s.streakCap,
    maxAttempts: s.maxAttempts, open: s.open, version: VERSION,
    campaign: s.campaign.show ? s.campaign : null, bonusQuestion: hasBonus,
  });
}

async function apiRegister(env, req) {
  const b = await body(req);
  const name = clean(b.name, 80), office = clean(b.office, 120), district = clean(b.district, 40);
  const phone = String(b.phone || '').replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
  if (name.length < 2) fail(400, 'Enter your name.');
  if (office.length < 2) fail(400, 'Enter your office.');
  if (!DISTRICTS.includes(district)) fail(400, 'Choose your district.');
  if (!/^[6-9]\d{9}$/.test(phone)) fail(400, 'Enter a valid 10-digit mobile number.');
  const d = db(env);
  const areaList = (await d.q(`SELECT name FROM areas WHERE district = $1`, [district])).map((r) => r.name);
  let area = null;
  if (areaList.length) {
    area = areaList.find((n) => n === clean(b.area, 80)) || null;
    if (!area) fail(400, 'Choose your area.');
  }
  const rows = await d.q(
    `INSERT INTO players (name, office, district, area, phone) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (phone) DO UPDATE SET name = excluded.name, office = excluded.office,
       district = excluded.district, area = excluded.area, updated_at = ${NOW}
     RETURNING id, name, office, district, area, phone, created_at = updated_at AS created`,
    [name, office, district, area, phone]);
  const p = rows[0];
  if (p.created) memoClear(env); // a new player card counts as a play straight away
  const stats = await d.q(
    `SELECT count(*) FILTER (WHERE status <> 'void') AS played, max(score) FILTER (WHERE status = 'finished') AS best
     FROM games WHERE player_id = $1`, [p.id]);
  return json({
    playerKey: await playerKey(env, p.id),
    player: { name: p.name, office: p.office, district: p.district, area: p.area, phone: p.phone },
    returning: !p.created, played: stats[0].played, best: stats[0].best,
  });
}

// Picks the game's questions: the configured number per level, never two questions with the
// same topic tag (rephrased versions of one fact). Hardest level is filled first because it has
// the fewest questions; if a level runs short, the gap is filled from other levels.
// Questions about the campaign programme never appear among the regular questions; when the bonus
// question is on, exactly one of them is added at the end as the bonus question.
export function pickQuestions(pool, s) {
  const counts = { easy: s.easy || 0, medium: s.medium || 0, hard: s.hard || 0 };
  const ids = pickRegular(pool.filter((q) => !q.campaign), counts, s.categoryMix || []);
  const bonus = s.bonusQuestion !== false && pool.find((q) => q.campaign);
  if (bonus) ids.push(bonus.id);
  return ids;
}

// How many of n questions each category gets (largest remainder, so the counts always add up to n or less).
export function categoryQuotas(mix, n) {
  const rows = (mix || []).map((m) => ({ key: String(m.name || '').trim().toLowerCase(), p: Math.max(0, Number(m.percent) || 0) }))
    .filter((m) => m.key && m.p > 0);
  const sum = rows.reduce((t, r) => t + r.p, 0);
  if (!sum) return [];
  const share = Math.min(1, sum / 100);
  const exact = rows.map((r) => ({ ...r, x: (n * share * r.p) / sum }));
  exact.forEach((r) => { r.n = Math.floor(r.x); });
  let left = Math.round(n * share) - exact.reduce((t, r) => t + r.n, 0);
  [...exact].sort((a, b) => (b.x - b.n) - (a.x - a.n)).forEach((r) => { if (left > 0) { r.n++; left--; } });
  return exact.map(({ key, n: k }) => ({ key, n: k }));
}

// Regular questions: category quotas first (smallest quota first, as those categories are scarcest),
// each pick taking the difficulty level that still needs the most questions; no repeated topic;
// any gap is filled from the rest of the pool. Returned easy → medium → hard.
function pickRegular(pool, counts, mix) {
  const n = counts.easy + counts.medium + counts.hard;
  const need = { ...counts };
  const used = new Set(), chosen = [];
  const tag = (q) => (q.topic ? 't:' + q.topic.trim().toLowerCase() : 'id:' + q.id);
  const cat = (q) => String(q.category || '').trim().toLowerCase();
  const free = (q, allowRepeat) => !chosen.includes(q) && (allowRepeat || !used.has(tag(q)));
  const best = (cands) => cands.reduce((b, q) => ((need[q.difficulty] ?? -1) > (need[b.difficulty] ?? -1) ? q : b), cands[0]);
  const take = (q) => { chosen.push(q); used.add(tag(q)); if (q.difficulty in need) need[q.difficulty]--; };
  for (const { key, n: quota } of categoryQuotas(mix, n).sort((a, b) => a.n - b.n)) {
    for (let k = 0; k < quota; k++) {
      const cands = pool.filter((q) => cat(q) === key && free(q, false));
      if (!cands.length) break;
      take(best(cands));
    }
  }
  for (const allowRepeat of [false, true]) {
    while (chosen.length < n) {
      const cands = pool.filter((q) => free(q, allowRepeat));
      if (!cands.length) break;
      take(best(cands));
    }
  }
  const rank = { easy: 0, medium: 1, hard: 2 };
  return chosen.map((q, i) => ({ q, i })).sort((a, b) => (rank[a.q.difficulty] ?? 3) - (rank[b.q.difficulty] ?? 3) || a.i - b.i).map((x) => x.q.id);
}

async function apiStart(env, req) {
  const b = await body(req);
  const pid = await verifyPlayer(env, b.playerKey);
  await rateLimit(env, 'start', pid);
  const d = db(env);
  const s = await getSettings(d);
  if (!s.open) fail(403, 'The quiz is closed right now. Watch for the next round.');

  // Resume an unfinished recent game instead of starting a fresh one
  const open = await d.q(
    `SELECT id, json_array_length(question_ids) AS total, current_index FROM games
     WHERE player_id = $1 AND status = 'playing' AND started_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${RESUME_WINDOW}')
     ORDER BY started_at DESC LIMIT 1`, [pid]);
  if (open[0]) return json({ gameId: open[0].id, total: open[0].total, index: open[0].current_index, resumed: true });

  if (s.maxAttempts > 0) {
    const c = await d.q(`SELECT count(*) AS n FROM games WHERE player_id = $1 AND status <> 'void'`, [pid]);
    if (c[0].n >= s.maxAttempts) fail(403, `You have used all ${s.maxAttempts} attempts. Your best score is on the board.`);
  }

  const pool = shuffle(await d.q(
    `SELECT id, difficulty, category, topic, campaign, json_array_length(options) AS n FROM questions WHERE active`));
  const picked = pickQuestions(pool, s);
  if (!picked.length) fail(503, 'No questions are available yet.');
  const nById = Object.fromEntries(pool.map((x) => [x.id, x.n]));
  const orders = picked.map((id) => shuffle([...Array(nById[id]).keys()]));
  const config = { limitMs: s.timeLimitSec * 1000, points: s.points, penalty: s.penalty, streakBonus: s.streakBonus, streakCap: s.streakCap, showExplanation: s.showExplanation };
  const g = await d.q(
    `INSERT INTO games (id, player_id, question_ids, option_orders, config) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [crypto.randomUUID(), pid, picked, orders, config]);
  return json({ gameId: g[0].id, total: picked.length, index: 0, resumed: false });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function loadGame(d, gameId, pid) {
  if (!UUID.test(String(gameId))) fail(400, 'Unknown game.');
  const r = await d.q(
    `SELECT g.*, ${MS_SINCE('g.served_at')} AS elapsed
     FROM games g WHERE g.id = $1 AND g.player_id = $2`, [gameId, pid]);
  if (!r[0]) fail(404, 'Game not found.');
  return r[0];
}

async function apiNext(env, req) {
  const b = await body(req);
  const pid = await verifyPlayer(env, b.playerKey);
  await rateLimit(env, 'play', pid);
  const d = db(env);
  if (!UUID.test(String(b.gameId))) fail(400, 'Unknown game.');
  // One round trip: start the clock if this question isn't served yet, and read the game with its question.
  // A question served just now has elapsed (about) 0.
  const [, r] = await d.tx([
    [`UPDATE games SET served_at = ${NOW}
      WHERE id = $1 AND player_id = $2 AND status = 'playing' AND served_at IS NULL AND current_index < json_array_length(question_ids)`,
    [b.gameId, pid]],
    [`SELECT g.status, g.current_index, g.question_ids, g.option_orders, g.config, g.score, g.streak, g.id,
       ${MS_SINCE('g.served_at')} AS elapsed,
       q.id AS q_id, q.question, q.options, q.difficulty, q.category, q.campaign
     FROM games g LEFT JOIN questions q ON q.id = json_extract(g.question_ids, '$[' || g.current_index || ']')
     WHERE g.id = $1 AND g.player_id = $2`, [b.gameId, pid]],
  ]);
  const g = r[0];
  if (!g) fail(404, 'Game not found.');
  if (g.status !== 'playing' || g.current_index >= g.question_ids.length) return json({ done: true });
  const idx = g.current_index;
  const q = g.q_id ? g : null;
  if (!q) { // question was deleted while this game was in progress
    await d.q(`UPDATE games SET status = 'void', finished_at = ${NOW} WHERE id = $1`, [g.id]);
    fail(409, 'The questions were updated. Start a new game.');
  }
  const order = g.option_orders[idx];
  const limitMs = g.config.limitMs;
  return json({
    done: false, index: idx, total: g.question_ids.length,
    question: q.question, category: q.category, difficulty: q.difficulty,
    bonus: !!q.campaign && idx === g.question_ids.length - 1,
    options: order.map((i) => q.options[i]),
    points: g.config.points[q.difficulty], limitMs,
    remainingMs: Math.max(0, limitMs - Math.max(0, (g.elapsed || 0) - GRACE_MS)),
    score: g.score, streak: g.streak,
  });
}

async function apiAnswer(env, req) {
  const b = await body(req);
  const pid = await verifyPlayer(env, b.playerKey);
  await rateLimit(env, 'play', pid);
  const d = db(env);
  if (!UUID.test(String(b.gameId))) fail(400, 'Unknown game.');
  const r = await d.q(
    `SELECT g.*, ${MS_SINCE('g.served_at')} AS elapsed,
       q.id AS q_id, q.correct_index, q.difficulty AS q_difficulty, q.explanation, q.campaign
     FROM games g LEFT JOIN questions q ON q.id = json_extract(g.question_ids, '$[' || g.current_index || ']')
     WHERE g.id = $1 AND g.player_id = $2`, [b.gameId, pid]);
  const g = r[0];
  if (!g) fail(404, 'Game not found.');
  if (g.status !== 'playing') fail(409, 'This game is over.');
  if (!g.served_at || Number(b.index) !== g.current_index) fail(409, 'That question was already answered.');
  const idx = g.current_index;
  const qid = g.question_ids[idx];
  const q = g.q_id ? { correct_index: g.correct_index, difficulty: g.q_difficulty, explanation: g.explanation, campaign: g.campaign } : null;
  if (!q) {
    await d.q(`UPDATE games SET status = 'void', finished_at = ${NOW} WHERE id = $1`, [g.id]);
    fail(409, 'The questions were updated. Start a new game.');
  }
  // the campaign bonus question (last question) never takes marks away
  const isBonus = !!q.campaign && idx === g.question_ids.length - 1;
  const order = g.option_orders[idx];
  const cfg = g.config;

  // choice: option index, 'skip' (no penalty), or null (time ran out, no penalty)
  const skipped = b.choice === 'skip';
  // 1 s of slack for clock drift; the game itself never sends an early skip
  if (skipped && (g.elapsed || 0) < SKIP_AFTER_MS - 1000) fail(400, 'Skip opens 5 seconds into the question.');
  const choice = skipped || b.choice === null || b.choice === undefined ? null : Number(b.choice);
  if (choice !== null && !(Number.isInteger(choice) && choice >= 0 && choice < order.length)) fail(400, 'Invalid option.');
  const elapsed = Math.max(0, (g.elapsed || 0) - GRACE_MS);
  const late = elapsed > cfg.limitMs + LATE_MS;
  const chosenOrig = choice === null ? null : order[choice];
  const correct = !late && chosenOrig !== null && chosenOrig === q.correct_index;
  const wrong = !late && chosenOrig !== null && !correct;
  const timeMs = Math.min(elapsed, cfg.limitMs);

  const base = correct ? cfg.points[q.difficulty] : 0;
  const speed = correct ? Math.round(base * Math.max(0, cfg.limitMs - timeMs) / cfg.limitMs) : 0;
  const streak = correct ? g.streak + 1 : 0;
  const streakPts = correct && streak >= 2 ? Math.min(cfg.streakCap, cfg.streakBonus * (streak - 1)) : 0;
  // Negative marks: never take the game score below zero
  const penalty = wrong && !isBonus ? Math.min(Number(cfg.penalty?.[q.difficulty]) || 0, Math.max(0, g.score)) : 0;
  const points = correct ? base + speed + streakPts : -penalty;
  const done = idx + 1 >= g.question_ids.length;

  // One round trip, one transaction: move the game on and record the answer. Only the request that moved the game
  // gets a score back; a second answer to the same question finds the game already moved on, and its answer row
  // (same game and question number) is ignored.
  const params = [g.id, idx, idx + 1, points, correct ? 1 : 0, timeMs, streak, done, qid, chosenOrig, correct, skipped];
  const [upd] = await d.tx([
    [`UPDATE games SET current_index = $3, served_at = NULL, score = score + $4,
         correct_count = correct_count + $5, total_ms = total_ms + $6, streak = $7,
         best_streak = max(best_streak, $7),
         status = CASE WHEN $8 THEN 'finished' ELSE status END,
         finished_at = CASE WHEN $8 THEN ${NOW} ELSE finished_at END
       WHERE id = $1 AND current_index = $2 AND status = 'playing'
       RETURNING id, score`, params],
    [`INSERT OR IGNORE INTO answers (game_id, q_index, question_id, chosen_index, is_correct, time_ms, points, skipped)
       SELECT id, $2, $9, $10, $11, $6, $4, $12 FROM games WHERE id = $1 AND current_index = $3`, params],
  ]);
  if (!upd[0]) fail(409, 'That question was already answered.');
  if (done) memoClear(env); // the new score shows on the leaderboard straight away

  return json({
    correct, wrong, skipped, bonus: isBonus, timedOut: !skipped && (choice === null || late), correctChoice: order.indexOf(q.correct_index),
    points, penalty, fullPenalty: wrong && !isBonus ? Number(cfg.penalty?.[q.difficulty]) || 0 : 0,
    breakdown: { base, speed, streak: streakPts }, timeMs,
    score: upd[0].score, streak, done,
    explanation: cfg.showExplanation ? q.explanation || null : null,
  });
}

async function apiResult(env, req) {
  const b = await body(req);
  const pid = await verifyPlayer(env, b.playerKey);
  await rateLimit(env, 'play', pid);
  const d = db(env);
  // Two batches of queries that run side by side, instead of one after another
  const [g, s, pl] = await Promise.all([
    loadGame(d, b.gameId, pid), getSettings(d),
    d.q(`SELECT p.name, p.district,
        (SELECT id FROM games WHERE player_id = p.id AND status = 'finished'
         ORDER BY score DESC, total_ms ASC, finished_at ASC LIMIT 1) AS best_id,
        (SELECT count(*) FROM games WHERE player_id = p.id AND status <> 'void') AS played
      FROM players p WHERE p.id = $1`, [pid]),
  ]);
  if (g.status === 'playing') fail(409, 'Finish the game first.');
  const player = pl[0], best = { id: player.best_id }, played = player.played;
  const [answers, overall, district] = await Promise.all([
    d.q(`SELECT a.is_correct, a.points, a.skipped, a.chosen_index, a.q_index, coalesce(q.campaign, false) AS campaign
      FROM answers a LEFT JOIN questions q ON q.id = a.question_id WHERE a.game_id = $1 ORDER BY a.q_index`, [g.id]),
    leaderboard(d, null, pid), leaderboard(d, player.district, pid),
  ]);
  const state = (a) => (a.is_correct ? 'right' : a.skipped ? 'skipped' : a.chosen_index === null ? 'timeout' : 'wrong');
  return json({
    score: g.score, correct: g.correct_count, total: g.question_ids.length, timeMs: g.total_ms,
    bestStreak: g.best_streak, voided: g.status === 'void',
    personalBest: best?.id === g.id,
    answers: answers.map((a) => ({ correct: a.is_correct, points: a.points, state: state(a),
      bonus: a.campaign && a.q_index === g.question_ids.length - 1 })),
    wrong: answers.filter((a) => state(a) === 'wrong').length,
    skipped: answers.filter((a) => state(a) === 'skipped').length,
    timedOut: answers.filter((a) => state(a) === 'timeout').length,
    marksLost: -answers.reduce((t, a) => t + Math.min(0, a.points), 0),
    attemptsLeft: s.maxAttempts > 0 ? Math.max(0, s.maxAttempts - played) : null,
    district: player.district, overall, districtBoard: district,
  });
}

async function apiLeaderboard(env, url) {
  const district = url.searchParams.get('district');
  if (district && !DISTRICTS.includes(district)) fail(400, 'Unknown district.');
  let pid = null;
  const key = url.searchParams.get('key');
  if (key) { try { pid = await verifyPlayer(env, key); } catch { pid = null; } }
  // not cached in the browser: a leaderboard opened right after a game must show it (the server keeps a 10 s copy)
  return json(await leaderboard(db(env), district || null, pid, env));
}

// ---------- admin API ----------
async function adminLogin(env, req) {
  const ip = req.headers.get('cf-connecting-ip') || 'x';
  const f = loginFails.get(ip) || { n: 0, t: 0 };
  if (f.n >= 8 && Date.now() - f.t < 15 * 60_000) fail(429, 'Too many attempts. Try again in 15 minutes.');
  const b = await body(req);
  if (!env.ADMIN_PASSWORD) fail(500, 'ADMIN_PASSWORD is not configured.');
  const s = secret(env);
  const ok = safeEqual(await hmac(s, 'pw:' + String(b.password || '')), await hmac(s, 'pw:' + env.ADMIN_PASSWORD));
  if (!ok) {
    loginFails.set(ip, { n: f.n + 1, t: Date.now() });
    await new Promise((r) => setTimeout(r, 700));
    fail(401, 'Wrong password.');
  }
  loginFails.delete(ip);
  return json({ token: await adminToken(env) });
}

async function adminStats(env) {
  const d = db(env);
  const [totals] = await d.q(`
    SELECT
      (SELECT count(*) FROM players) AS players,
      (SELECT count(*) FROM players WHERE created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')) AS players_24h,
      (SELECT count(*) FROM games) AS games,
      (SELECT count(*) FROM games WHERE status = 'finished') AS finished,
      (SELECT count(*) FROM games WHERE started_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')) AS games_24h,
      (SELECT coalesce(round(avg(score)), 0) FROM games WHERE status = 'finished') AS avg_score,
      (SELECT coalesce(max(score), 0) FROM games WHERE status = 'finished') AS top_score,
      (SELECT coalesce(round(avg(correct_count), 1), 0) FROM games WHERE status = 'finished') AS avg_correct,
      (SELECT coalesce(round(avg(json_array_length(question_ids)), 1), 10) FROM games WHERE status = 'finished') AS avg_total,
      (SELECT count(*) FROM questions WHERE active) AS active_questions`);
  const byDistrict = await d.q(`
    SELECT p.district, count(DISTINCT p.id) AS players,
      count(g.id) FILTER (WHERE g.status = 'finished') AS games,
      coalesce(round(avg(g.score) FILTER (WHERE g.status = 'finished')), 0) AS avg_score,
      coalesce(max(g.score) FILTER (WHERE g.status = 'finished'), 0) AS top_score
    FROM players p LEFT JOIN games g ON g.player_id = p.id
    GROUP BY p.district ORDER BY players DESC`);
  const byArea = await d.q(`
    SELECT p.district, p.area, count(DISTINCT p.id) AS players,
      count(g.id) FILTER (WHERE g.status = 'finished') AS games,
      coalesce(round(avg(g.score) FILTER (WHERE g.status = 'finished')), 0) AS avg_score,
      coalesce(max(g.score) FILTER (WHERE g.status = 'finished'), 0) AS top_score
    FROM players p LEFT JOIN games g ON g.player_id = p.id
    GROUP BY p.district, p.area`);
  const areas = await getAreas(d);
  const daily = await d.q(`
    SELECT strftime('%Y-%m-%d', started_at, '+330 minutes') AS day,
      count(*) AS games, count(*) FILTER (WHERE status = 'finished') AS finished,
      count(DISTINCT player_id) AS players
    FROM games WHERE started_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days') GROUP BY 1 ORDER BY 1`);
  const hourly = await d.q(`
    SELECT CAST(strftime('%H', started_at, '+330 minutes') AS INTEGER) AS hour, count(*) AS games
    FROM games GROUP BY 1 ORDER BY 1`);
  const byLevel = await d.q(`
    SELECT q.difficulty, count(*) AS attempts,
      coalesce(round(100.0 * avg(a.is_correct)), 0) AS accuracy,
      coalesce(round(avg(a.time_ms)), 0) AS avg_ms
    FROM answers a JOIN questions q ON q.id = a.question_id GROUP BY q.difficulty`);
  const spread = await d.q(`
    SELECT correct_count AS correct, count(*) AS games FROM games WHERE status = 'finished' GROUP BY 1 ORDER BY 1`);
  const hardest = await d.q(`
    SELECT q.id, q.question, q.difficulty, count(*) AS attempts,
      round(100.0 * avg(a.is_correct)) AS accuracy
    FROM answers a JOIN questions q ON q.id = a.question_id
    GROUP BY q.id HAVING count(*) >= 3 ORDER BY accuracy ASC, attempts DESC LIMIT 8`);
  return json({ totals, byDistrict, byArea, areas, daily, hourly, byLevel, spread, hardest, districts: DISTRICTS });
}

function validateQuestion(b) {
  const question = String(b.question || '').trim().slice(0, 600);
  const options = Array.isArray(b.options) ? b.options.map((o) => String(o ?? '').trim().slice(0, 240)) : [];
  const correct = Number(b.correct_index ?? b.correct);
  const difficulty = String(b.difficulty || '').toLowerCase();
  if (!question) fail(400, 'Question text is required.');
  if (options.length < 2 || options.length > 6 || options.some((o) => !o)) fail(400, `Give 2 to 6 filled options (question: "${question.slice(0, 40)}").`);
  if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) fail(400, `Mark which option is correct (question: "${question.slice(0, 40)}").`);
  if (!LEVELS.includes(difficulty)) fail(400, 'Difficulty must be easy, medium or hard.');
  return {
    question, options, correct, difficulty,
    category: clean(b.category, 60) || null, explanation: String(b.explanation || '').trim().slice(0, 600) || null,
    topic: clean(b.topic, 60) || null,
    campaign: b.campaign === true || ['true', 'yes', 'y', '1'].includes(String(b.campaign ?? '').trim().toLowerCase()),
    active: !(b.active === false || ['no', 'n', 'false', '0'].includes(String(b.active ?? '').trim().toLowerCase())),
  };
}

async function adminQuestions(env) {
  const rows = await db(env).q(`
    SELECT q.id, q.question, q.options, q.correct_index, q.difficulty, q.category, q.topic, q.campaign, q.explanation, q.active, q.updated_at,
      count(a.question_id) AS attempts,
      coalesce(round(100.0 * avg(a.is_correct)), 0) AS accuracy,
      coalesce(round(avg(a.time_ms)), 0) AS avg_ms,
      count(*) FILTER (WHERE a.skipped) AS skip_count
    FROM questions q LEFT JOIN answers a ON a.question_id = q.id
    GROUP BY q.id ORDER BY q.id DESC`);
  return json({ questions: rows.map(({ skip_count, ...q }) => ({ ...q, skipped: skip_count })) });
}
async function adminSaveQuestion(env, req, id) {
  const v = validateQuestion(await body(req));
  const d = db(env);
  const params = [v.question, JSON.stringify(v.options), v.correct, v.difficulty, v.category, v.explanation, v.active, v.topic, v.campaign];
  const r = id
    ? await d.q(`UPDATE questions SET question = $1, options = $2, correct_index = $3, difficulty = $4, category = $5,
        explanation = $6, active = $7, topic = $8, campaign = $9, updated_at = ${NOW} WHERE id = $10 RETURNING id`, [...params, id])
    : await d.q(`INSERT INTO questions (question, options, correct_index, difficulty, category, explanation, active, topic, campaign)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`, params);
  if (!r[0]) fail(404, 'Question not found.');
  return json({ id: r[0].id });
}
async function adminDeleteQuestion(env, id) {
  const d = db(env);
  const used = await d.q(`SELECT 1 FROM answers WHERE question_id = $1 LIMIT 1`, [id]);
  if (used[0]) {
    await d.q(`UPDATE questions SET active = false, updated_at = ${NOW} WHERE id = $1`, [id]);
    return json({ deactivated: true });
  }
  await d.q(`DELETE FROM questions WHERE id = $1`, [id]);
  return json({ deleted: true });
}
// A row updates an existing question when its id matches, or else when its question text matches exactly;
// every other row is added. Rows left out of the file are not touched (hide a question with active = no).
// All of it is saved in one transaction, so a file is applied completely or not at all.
async function adminImport(env, req) {
  const b = await body(req);
  const list = Array.isArray(b.questions) ? b.questions : [];
  if (!list.length) fail(400, 'No questions found in the file.');
  if (list.length > 1000) fail(400, 'Import up to 1,000 questions at a time.');
  const vs = list.map((x) => ({ ...validateQuestion(x), id: /^\d+$/.test(String(x.id ?? '').trim()) ? Number(x.id) : null }));
  const d = db(env);
  const existing = await d.q(`SELECT id, question FROM questions`);
  const ids = new Set(existing.map((r) => r.id)), byText = new Map(existing.map((r) => [r.question.trim(), r.id]));
  const updates = [], inserts = [], seen = new Set();
  for (const v of vs) {
    const id = v.id && ids.has(v.id) ? v.id : byText.get(v.question) ?? null;
    if (id) {
      if (seen.has(id)) fail(400, `Question ${id} is in the file twice ("${v.question.slice(0, 40)}").`);
      seen.add(id);
      updates.push({ id, ...questionRow(v) });
    } else inserts.push(questionRow(v));
  }
  // two statements whatever the size of the file
  await d.tx([
    [`UPDATE questions SET ${Q_COLS.map((c) => `${c} = v.${c}`).join(', ')}, updated_at = ${NOW}
      FROM (${fromJsonRows(['id', ...Q_COLS])}) AS v WHERE questions.id = v.id`, [updates]],
    [`INSERT INTO questions (${Q_COLS}) ${fromJsonRows(Q_COLS)}`, [inserts]],
  ]);
  return json({ imported: vs.length, added: inserts.length, updated: updates.length });
}

async function adminPlayers(env, url) {
  const search = clean(url.searchParams.get('q'), 80);
  const district = url.searchParams.get('district') || '';
  const area = url.searchParams.get('area') || '';
  const page = Math.max(0, Number(url.searchParams.get('page')) || 0);
  const like = `%${search}%`;
  const where = `($1 = '' OR p.name LIKE $2 OR p.office LIKE $2 OR p.phone LIKE $2 OR p.area LIKE $2)
    AND ($3 = '' OR p.district = $3) AND ($4 = '' OR coalesce(p.area, '') = $4)`;
  const d = db(env);
  const rows = await d.q(`
    SELECT p.id, p.name, p.office, p.district, p.area, p.phone, p.created_at,
      count(g.id) FILTER (WHERE g.status <> 'void') AS games,
      max(g.score) FILTER (WHERE g.status = 'finished') AS best,
      max(g.correct_count) FILTER (WHERE g.status = 'finished') AS best_correct,
      max(g.started_at) AS last_played
    FROM players p LEFT JOIN games g ON g.player_id = p.id
    WHERE ${where}
    GROUP BY p.id ORDER BY best DESC NULLS LAST, p.created_at DESC
    LIMIT 50 OFFSET $5`, [search, like, district, area, page * 50]);
  const total = await d.q(`SELECT count(*) AS n FROM players p WHERE ${where}`, [search, like, district, area]);
  return json({ players: rows, total: total[0].n, page });
}
async function adminPlayer(env, id) {
  const d = db(env);
  const p = (await d.q(`SELECT * FROM players WHERE id = $1`, [id]))[0];
  if (!p) fail(404, 'Player not found.');
  const games = await d.q(`
    SELECT id, score, correct_count, json_array_length(question_ids) AS total, total_ms, best_streak, status, started_at, finished_at
    FROM games WHERE player_id = $1 ORDER BY started_at DESC`, [id]);
  const answers = await d.q(`
    SELECT a.game_id, a.q_index, a.is_correct, a.skipped, a.time_ms, a.points, a.chosen_index, q.question, q.options, q.correct_index, q.difficulty
    FROM answers a JOIN games g ON g.id = a.game_id JOIN questions q ON q.id = a.question_id
    WHERE g.player_id = $1 ORDER BY a.answered_at`, [id]);
  return json({ player: p, games, answers });
}
async function adminSetGameStatus(env, id, status) {
  if (!UUID.test(id)) fail(400, 'Unknown game.');
  const r = await db(env).q(
    `UPDATE games SET status = $2 WHERE id = $1 AND status <> 'playing' RETURNING id`, [id, status]);
  if (!r[0]) fail(404, 'Only finished games can be voided or restored.');
  return json({ ok: true });
}

// ---------- areas (admin) ----------
async function adminAreas(env) {
  const rows = await db(env).q(`
    SELECT a.id, a.district, a.name,
      (SELECT count(*) FROM players p WHERE p.district = a.district AND p.area = a.name) AS players
    FROM areas a ORDER BY a.district, lower(a.name)`);
  return json({ districts: DISTRICTS, areas: rows });
}
async function adminAddAreas(env, req) {
  const b = await body(req);
  const district = String(b.district || '');
  if (!DISTRICTS.includes(district)) fail(400, 'Choose a district.');
  const names = [...new Set((Array.isArray(b.names) ? b.names : []).map((n) => clean(n, 80)).filter(Boolean))];
  if (!names.length) fail(400, 'Type at least one area name.');
  if (names.length > 200) fail(400, 'Add up to 200 areas at a time.');
  const r = await db(env).q(
    `INSERT INTO areas (district, name) SELECT $1, value FROM json_each($2) WHERE true
     ON CONFLICT (district, name) DO NOTHING RETURNING id`, [district, names]);
  return json({ added: r.length, skipped: names.length - r.length });
}
async function adminRenameArea(env, req, id) {
  const name = clean((await body(req)).name, 80);
  if (!name) fail(400, 'Area name is required.');
  const d = db(env);
  const cur = (await d.q(`SELECT district, name FROM areas WHERE id = $1`, [id]))[0];
  if (!cur) fail(404, 'Area not found.');
  if (cur.name === name) return json({ ok: true, playersUpdated: 0 });
  if ((await d.q(`SELECT 1 FROM areas WHERE district = $1 AND name = $2`, [cur.district, name]))[0]) {
    fail(409, `${cur.district} already has an area named ${name}.`);
  }
  await d.q(`UPDATE areas SET name = $2 WHERE id = $1`, [id, name]);
  const moved = await d.q(
    `UPDATE players SET area = $3, updated_at = ${NOW} WHERE district = $1 AND area = $2 RETURNING id`,
    [cur.district, cur.name, name]);
  return json({ ok: true, playersUpdated: moved.length });
}
async function adminDeleteArea(env, id) {
  const r = await db(env).q(`DELETE FROM areas WHERE id = $1 RETURNING id`, [id]);
  if (!r[0]) fail(404, 'Area not found.');
  return json({ deleted: true });
}

async function adminExport(env, url) {
  const type = url.searchParams.get('type');
  const d = db(env);
  let head, rows;
  if (type === 'leaderboard') {
    head = ['Rank', 'Name', 'Office', 'District', 'Area', 'Phone', 'Best score', 'Correct', 'Time (s)', 'Finished at'];
    const r = await d.q(`${boardCte(false)}
      SELECT r.rank, p.name, p.office, p.district, p.area, p.phone, r.score, r.correct_count, r.total_ms, r.finished_at
      FROM ranked r JOIN players p ON p.id = r.player_id ORDER BY r.rank`);
    rows = r.map((x) => [x.rank, x.name, x.office, x.district, x.area, x.phone, x.score, x.correct_count, (x.total_ms / 1000).toFixed(1), x.finished_at]);
  } else if (type === 'games') {
    head = ['Game', 'Name', 'Office', 'District', 'Area', 'Phone', 'Status', 'Score', 'Correct', 'Wrong', 'Skipped', 'Marks lost', 'Questions', 'Time (s)', 'Best streak', 'Started', 'Finished'];
    const r = await d.q(`
      SELECT g.id, p.name, p.office, p.district, p.area, p.phone, g.status, g.score, g.correct_count,
        (SELECT count(*) FROM answers a WHERE a.game_id = g.id AND NOT a.is_correct AND NOT a.skipped AND a.chosen_index IS NOT NULL) AS wrong,
        (SELECT count(*) FROM answers a WHERE a.game_id = g.id AND a.skipped) AS skip_count,
        (SELECT coalesce(-sum(a.points) FILTER (WHERE a.points < 0), 0) FROM answers a WHERE a.game_id = g.id) AS lost,
        json_array_length(g.question_ids) AS total, g.total_ms, g.best_streak, g.started_at, g.finished_at
      FROM games g JOIN players p ON p.id = g.player_id ORDER BY g.started_at DESC`);
    rows = r.map((x) => [x.id, x.name, x.office, x.district, x.area, x.phone, x.status, x.score, x.correct_count, x.wrong, x.skip_count, x.lost, x.total, (x.total_ms / 1000).toFixed(1), x.best_streak, x.started_at, x.finished_at]);
  } else if (type === 'questions') {
    head = ['id', 'difficulty', 'category', 'topic', 'campaign', 'question', 'option_a', 'option_b', 'option_c', 'option_d', 'option_e', 'option_f', 'correct', 'explanation', 'active'];
    const r = await d.q(`SELECT * FROM questions ORDER BY id`);
    rows = r.map((x) => {
      const o = [...x.options, '', '', '', '', '', ''].slice(0, 6);
      return [x.id, x.difficulty, x.category, x.topic, x.campaign ? 'yes' : '', x.question, ...o, 'ABCDEF'[x.correct_index], x.explanation, x.active ? 'yes' : 'no'];
    });
  } else {
    head = ['Name', 'Office', 'District', 'Area', 'Phone', 'Registered', 'Games', 'Best score'];
    const r = await d.q(`
      SELECT p.name, p.office, p.district, p.area, p.phone, p.created_at,
        count(g.id) FILTER (WHERE g.status <> 'void') AS games, max(g.score) FILTER (WHERE g.status = 'finished') AS best
      FROM players p LEFT JOIN games g ON g.player_id = p.id GROUP BY p.id ORDER BY p.created_at`);
    rows = r.map((x) => [x.name, x.office, x.district, x.area, x.phone, x.created_at, x.games, x.best]);
  }
  const fmt = (v) => (v instanceof Date ? v.toISOString() : v);
  const csv = '﻿' + [head, ...rows].map((r) => r.map((v) => csvCell(fmt(v))).join(',')).join('\r\n');
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="quiz-${type || 'players'}.csv"`,
    },
  });
}

async function adminSettings(env, req) {
  const d = db(env);
  if (req.method === 'GET') return json(await getSettings(d));
  const b = await body(req);
  const cur = await getSettings(d);
  const int = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
  const next = {
    title: clean(b.title ?? cur.title, 60) || DEFAULT_SETTINGS.title,
    subtitle: clean(b.subtitle ?? cur.subtitle, 100),
    tagline: clean(b.tagline ?? cur.tagline, 140),
    values: (Array.isArray(b.values) ? b.values : cur.values).map((v) => clean(v, 40)).filter(Boolean).slice(0, 8),
    easy: int(b.easy, 0, 30, cur.easy), medium: int(b.medium, 0, 30, cur.medium), hard: int(b.hard, 0, 30, cur.hard),
    timeLimitSec: int(b.timeLimitSec, 5, 120, cur.timeLimitSec),
    points: {
      easy: int(b.points?.easy, 0, 10000, cur.points.easy),
      medium: int(b.points?.medium, 0, 10000, cur.points.medium),
      hard: int(b.points?.hard, 0, 10000, cur.points.hard),
    },
    penalty: {
      easy: int(b.penalty?.easy, 0, 10000, cur.penalty.easy),
      medium: int(b.penalty?.medium, 0, 10000, cur.penalty.medium),
      hard: int(b.penalty?.hard, 0, 10000, cur.penalty.hard),
    },
    streakBonus: int(b.streakBonus, 0, 1000, cur.streakBonus),
    streakCap: int(b.streakCap, 0, 5000, cur.streakCap),
    maxAttempts: int(b.maxAttempts, 0, 100, cur.maxAttempts),
    open: b.open === undefined ? cur.open : !!b.open,
    showExplanation: b.showExplanation === undefined ? cur.showExplanation : !!b.showExplanation,
    bonusQuestion: b.bonusQuestion === undefined ? cur.bonusQuestion !== false : !!b.bonusQuestion,
    categoryMix: (Array.isArray(b.categoryMix) ? b.categoryMix : cur.categoryMix)
      .map((m) => ({ name: clean(m.name, 60), percent: int(m.percent, 0, 100, 0) })).filter((m) => m.name && m.percent > 0).slice(0, 12),
    campaign: (() => {
      const c = { ...cur.campaign, ...(b.campaign || {}) };
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(c.date || '')) ? c.date : cur.campaign.date;
      return {
        show: !!c.show, name: clean(c.name, 60), nameMl: clean(c.nameMl, 80), date, place: clean(c.place, 60),
        organiser: clean(c.organiser, 100), line: clean(c.line, 200),
        demands: (Array.isArray(c.demands) ? c.demands : []).map((x) => clean(x, 120)).filter(Boolean).slice(0, 12),
      };
    })(),
  };
  if (next.easy + next.medium + next.hard < 1) fail(400, 'A game needs at least one question.');
  await d.q(`INSERT INTO settings (key, value) VALUES ('game', $1)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [JSON.stringify(next)]);
  return json(next);
}

// ---------- rate limits ----------
// Requests per minute. Uses Cloudflare's rate-limit bindings when wrangler.toml declares them ([[ratelimits]],
// same names and numbers), otherwise a counter inside this Worker instance (best effort; local server and tests).
// Per-address limits are generous because many phones on one mobile network, or one office, share an address.
const LIMITS = {
  read: { binding: 'RL_READ', limit: 120 },          // config, leaderboard (per address)
  register: { binding: 'RL_REGISTER', limit: 20 },   // player cards (per address)
  gameIp: { binding: 'RL_GAME_IP', limit: 600 },     // all game requests (per address)
  start: { binding: 'RL_START', limit: 10 },         // new games (per player)
  play: { binding: 'RL_PLAY', limit: 90 },           // next question / answer / result (per player)
  admin: { binding: 'RL_ADMIN', limit: 300 },        // admin page requests (per address)
};
const hits = new Map();
async function rateLimit(env, kind, key) {
  const { binding, limit } = LIMITS[kind];
  const k = `${kind}:${key}`;
  const tooMany = () => fail(429, 'Too many requests. Wait a minute and try again.', { 'retry-after': '60' });
  if (env[binding]?.limit) {
    // If Cloudflare's rate-limit service itself errors, fall back to the counter below instead of failing the request
    let res = null;
    try { res = await env[binding].limit({ key: k }); } catch (e) { console.error('rate limit binding', binding, e); }
    if (res) { if (!res.success) tooMany(); return; }
  }
  const w = Math.floor(Date.now() / 60_000);
  const h = hits.get(k);
  if (!h || h.w !== w) {
    if (hits.size > 20_000) for (const [x, v] of hits) if (v.w !== w) hits.delete(x);
    hits.set(k, { w, n: 1 });
    return;
  }
  if (++h.n > limit) tooMany();
}

// ---------- short cache for public reads ----------
// The opening screen asks for the settings and the leaderboard on every visit. Within one Worker instance,
// the same answer is reused for a few seconds instead of reading the database each time.
const memoStore = new Map(); // per database
async function memo(env, key, ms, fn) {
  const dbKey = env.DB;
  let m = memoStore.get(dbKey);
  if (!m) memoStore.set(dbKey, (m = new Map()));
  const hit = m.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await fn();
  m.set(key, { value, until: Date.now() + ms });
  return value;
}
const memoClear = (env) => memoStore.delete(env.DB);

// ---------- router ----------
async function route(req, env) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;
  const adminPath = '/' + String(env.ADMIN_PATH || 'union-control-room').replace(/^\/+|\/+$/g, '');

  if (p === adminPath && m === 'GET') {
    return new Response(ADMIN_HTML.replaceAll('{{VERSION}}', VERSION), {
      headers: {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
      },
    });
  }
  if (!p.startsWith('/api/')) return null;
  if (p === '/api/health' && m === 'GET') {
    try {
      const d = db(env);
      schemaReady.delete(env.DB); // always re-check on health
      await ensureSchema(env, d);
      const [r] = await d.q(`SELECT
        (SELECT coalesce(max(CAST(value AS INTEGER)), 0) FROM settings WHERE key = 'schema_version') AS db_version,
        (SELECT count(*) FROM questions WHERE active) AS questions,
        (SELECT count(*) FROM players) AS players,
        (SELECT count(*) FROM areas) AS areas`);
      return json({
        ok: !lastUpgradeError, version: VERSION, database: 'connected', schemaVersion: SCHEMA_VERSION, databaseVersion: r.db_version,
        questionUpgrade: lastUpgradeError || 'done',
        activeQuestions: r.questions, players: r.players, areas: r.areas,
        appSecret: env.APP_SECRET && env.APP_SECRET.length >= 16 ? 'set' : 'MISSING (add APP_SECRET, 16+ characters)',
        adminPassword: env.ADMIN_PASSWORD ? 'set' : 'MISSING (add ADMIN_PASSWORD)',
      });
    } catch (e) {
      if (!(e instanceof HttpError)) console.error('health', e);
      const msg = e instanceof HttpError ? e.message : explainDbError(e) || String(e?.message || e).slice(0, 300);
      return json({ ok: false, error: msg }, 500);
    }
  }
  // Limits are checked before the database is touched
  const ip = req.headers.get('cf-connecting-ip') || 'local';
  if (m === 'GET' && (p === '/api/config' || p === '/api/leaderboard' || p === '/api/version')) await rateLimit(env, 'read', ip);
  else if (p === '/api/register') await rateLimit(env, 'register', ip);
  else if (p.startsWith('/api/game/')) await rateLimit(env, 'gameIp', ip);
  else if (p.startsWith('/api/admin/')) await rateLimit(env, 'admin', ip);
  if (m !== 'GET') {
    // Changes can only come from this site's own pages (a browser always sends Origin on these requests)
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) fail(403, 'Requests from other sites are not allowed.');
    if (!(req.headers.get('content-type') || '').includes('application/json')) fail(415, 'Send JSON.');
  }
  // the game asks this when it opens or comes back on screen; no database needed
  if (p === '/api/version' && m === 'GET') return json({ version: VERSION });
  await ensureSchema(env, db(env));

  if (p === '/api/config' && m === 'GET') return apiConfig(env);
  if (p === '/api/register' && m === 'POST') return apiRegister(env, req);
  if (p === '/api/game/start' && m === 'POST') return apiStart(env, req);
  if (p === '/api/game/next' && m === 'POST') return apiNext(env, req);
  if (p === '/api/game/answer' && m === 'POST') return apiAnswer(env, req);
  if (p === '/api/game/result' && m === 'POST') return apiResult(env, req);
  if (p === '/api/leaderboard' && m === 'GET') return apiLeaderboard(env, url);

  if (p === '/api/admin/login' && m === 'POST') return adminLogin(env, req);
  if (p.startsWith('/api/admin/')) {
    await requireAdmin(env, req);
    if (m !== 'GET') memoClear(env); // admin changes show on the game straight away
    const parts = p.split('/').slice(3); // after /api/admin
    const id = parts[1];
    if (parts[0] === 'stats' && m === 'GET') return adminStats(env);
    if (parts[0] === 'questions') {
      if (!id && m === 'GET') return adminQuestions(env);
      if (id === 'import' && m === 'POST') return adminImport(env, req);
      if (!id && m === 'POST') return adminSaveQuestion(env, req, null);
      if (/^\d+$/.test(id || '') && m === 'PUT') return adminSaveQuestion(env, req, Number(id));
      if (/^\d+$/.test(id || '') && m === 'DELETE') return adminDeleteQuestion(env, Number(id));
    }
    if (parts[0] === 'areas') {
      if (!id && m === 'GET') return adminAreas(env);
      if (!id && m === 'POST') return adminAddAreas(env, req);
      if (/^\d+$/.test(id || '') && m === 'PUT') return adminRenameArea(env, req, Number(id));
      if (/^\d+$/.test(id || '') && m === 'DELETE') return adminDeleteArea(env, Number(id));
    }
    if (parts[0] === 'players') {
      if (!id && m === 'GET') return adminPlayers(env, url);
      if (/^\d+$/.test(id || '') && m === 'GET') return adminPlayer(env, Number(id));
    }
    if (parts[0] === 'games' && id && m === 'POST') {
      if (parts[2] === 'void') return adminSetGameStatus(env, id, 'void');
      if (parts[2] === 'restore') return adminSetGameStatus(env, id, 'finished');
    }
    if (parts[0] === 'export' && m === 'GET') return adminExport(env, url);
    if (parts[0] === 'settings' && (m === 'GET' || m === 'PUT')) return adminSettings(env, req);
  }
  fail(404, 'Not found.');
}

export default {
  async fetch(req, env, ctx) {
    try {
      const res = await route(req, env);
      if (res) return res;
      if (env.ASSETS) return env.ASSETS.fetch(req);
      return new Response('Not found', { status: 404 });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, e.headers);
      console.error(e);
      return json({ error: explainDbError(e) || 'Something went wrong on the server. Try again.' }, 500);
    }
  },
};
