// Kerala NGO Union Quiz — Cloudflare Worker (API + hidden admin page)
// Static game files are served from /public by Workers Static Assets.
import { neon } from '@neondatabase/serverless';
import ADMIN_HTML from './admin.html';

export const DISTRICTS = [
  'Thiruvananthapuram', 'Kollam', 'Pathanamthitta', 'Alappuzha', 'Kottayam', 'Idukki', 'Ernakulam',
  'Thrissur', 'Palakkad', 'Malappuram', 'Kozhikode', 'Wayanad', 'Kannur', 'Kasaragod',
];
const LEVELS = ['easy', 'medium', 'hard'];

export const DEFAULT_SETTINGS = {
  title: 'Arivu Quiz',
  subtitle: 'Kerala NGO Union, State Committee',
  tagline: 'Know your rights. Serve the people.',
  values: ['Solidarity', 'Democracy', 'Secularism', 'People-centred public service'],
  easy: 4, medium: 4, hard: 2,
  timeLimitSec: 15,
  points: { easy: 100, medium: 150, hard: 200 },
  streakBonus: 25,
  streakCap: 100,
  maxAttempts: 0,          // 0 = unlimited replays (best score counts)
  open: true,              // false = quiz closed to new games
  showExplanation: true,
};

const GRACE_MS = 400;          // network allowance subtracted from measured time
const LATE_MS = 1500;          // answers arriving later than limit + this count as timeouts
const RESUME_WINDOW = '1 hour';

// ---------- helpers ----------
const enc = new TextEncoder();
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

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

function db(env) {
  if (env.__db) return env.__db; // test hook
  if (!env.DATABASE_URL) fail(500, 'DATABASE_URL is not configured.');
  const sql = neon(env.DATABASE_URL);
  return { q: (text, params = []) => sql.query(text, params) };
}
function secret(env) {
  if (!env.APP_SECRET || env.APP_SECRET.length < 16) fail(500, 'APP_SECRET is not configured (min 16 chars).');
  return env.APP_SECRET;
}

async function getSettings(d) {
  const rows = await d.q(`SELECT value FROM settings WHERE key = 'game'`);
  const v = rows[0]?.value || {};
  return { ...DEFAULT_SETTINGS, ...v, points: { ...DEFAULT_SETTINGS.points, ...(v.points || {}) } };
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
    WITH best AS (
      SELECT DISTINCT ON (g.player_id) g.player_id, g.id AS game_id, g.score, g.total_ms, g.correct_count, g.finished_at
      FROM games g JOIN players p ON p.id = g.player_id
      WHERE g.status = 'finished' ${withDistrict ? 'AND p.district = $1' : ''}
      ORDER BY g.player_id, g.score DESC, g.total_ms ASC, g.finished_at ASC
    ),
    ranked AS (
      SELECT best.*, ROW_NUMBER() OVER (ORDER BY score DESC, total_ms ASC, finished_at ASC)::int AS rank
      FROM best
    )`;
}
async function leaderboard(d, district, playerId) {
  const params = district ? [district] : [];
  const top = await d.q(
    `${boardCte(!!district)}
     SELECT r.rank, r.player_id, r.score, r.total_ms, r.correct_count, p.name, p.office, p.district
     FROM ranked r JOIN players p ON p.id = r.player_id
     ORDER BY r.rank LIMIT 10`, params);
  const totalRow = await d.q(`${boardCte(!!district)} SELECT count(*)::int AS n FROM ranked`, params);
  let me = null;
  if (playerId) {
    const r = await d.q(
      `${boardCte(!!district)}
       SELECT r.rank, r.player_id, r.score, r.total_ms, r.correct_count, p.name, p.office, p.district
       FROM ranked r JOIN players p ON p.id = r.player_id WHERE r.player_id = $${params.length + 1}`,
      [...params, playerId]);
    me = r[0] || null;
  }
  const map = (x) => x && ({
    rank: x.rank, score: x.score, timeMs: x.total_ms, correct: x.correct_count,
    name: x.name, office: x.office, district: x.district, isMe: x.player_id === playerId,
  });
  return { top: top.map(map), me: map(me), total: totalRow[0]?.n || 0 };
}

// ---------- public API ----------
async function apiConfig(env) {
  const d = db(env);
  const s = await getSettings(d);
  const counts = await d.q(`SELECT difficulty, count(*)::int AS n FROM questions WHERE active GROUP BY difficulty`);
  const avail = Object.fromEntries(counts.map((c) => [c.difficulty, c.n]));
  const total = LEVELS.reduce((t, l) => t + Math.min(s[l], avail[l] || 0), 0);
  return json({
    title: s.title, subtitle: s.subtitle, tagline: s.tagline, values: s.values,
    districts: DISTRICTS, levels: { easy: s.easy, medium: s.medium, hard: s.hard },
    totalQuestions: total || s.easy + s.medium + s.hard,
    timeLimitSec: s.timeLimitSec, points: s.points, streakBonus: s.streakBonus, streakCap: s.streakCap,
    maxAttempts: s.maxAttempts, open: s.open,
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
  const rows = await d.q(
    `INSERT INTO players (name, office, district, phone) VALUES ($1, $2, $3, $4)
     ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, office = EXCLUDED.office,
       district = EXCLUDED.district, updated_at = now()
     RETURNING id, name, office, district, phone, (xmax = 0) AS created`,
    [name, office, district, phone]);
  const p = rows[0];
  const stats = await d.q(
    `SELECT count(*) FILTER (WHERE status <> 'void')::int AS played, max(score) FILTER (WHERE status = 'finished') AS best
     FROM games WHERE player_id = $1`, [p.id]);
  return json({
    playerKey: await playerKey(env, p.id),
    player: { name: p.name, office: p.office, district: p.district, phone: p.phone },
    returning: !p.created, played: stats[0].played, best: stats[0].best,
  });
}

async function apiStart(env, req) {
  const b = await body(req);
  const pid = await verifyPlayer(env, b.playerKey);
  const d = db(env);
  const s = await getSettings(d);
  if (!s.open) fail(403, 'The quiz is closed right now. Watch for the next round.');

  // Resume an unfinished recent game instead of starting a fresh one
  const open = await d.q(
    `SELECT id, cardinality(question_ids) AS total, current_index FROM games
     WHERE player_id = $1 AND status = 'playing' AND started_at > now() - interval '${RESUME_WINDOW}'
     ORDER BY started_at DESC LIMIT 1`, [pid]);
  if (open[0]) return json({ gameId: open[0].id, total: open[0].total, index: open[0].current_index, resumed: true });

  if (s.maxAttempts > 0) {
    const c = await d.q(`SELECT count(*)::int AS n FROM games WHERE player_id = $1 AND status <> 'void'`, [pid]);
    if (c[0].n >= s.maxAttempts) fail(403, `You have used all ${s.maxAttempts} attempts. Your best score is on the board.`);
  }

  const picked = [];
  for (const level of LEVELS) {
    if (!s[level]) continue;
    const r = await d.q(
      `SELECT id FROM questions WHERE active AND difficulty = $1 ORDER BY random() LIMIT $2`, [level, s[level]]);
    picked.push(...r.map((x) => x.id));
  }
  const want = s.easy + s.medium + s.hard;
  if (picked.length < want) { // fill gaps from any level if one level is short
    const r = await d.q(
      `SELECT id FROM questions WHERE active AND NOT (id = ANY($1::int[]))
       ORDER BY CASE difficulty WHEN 'easy' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, random() LIMIT $2`,
      [picked, want - picked.length]);
    picked.push(...r.map((x) => x.id));
  }
  if (!picked.length) fail(503, 'No questions are available yet.');

  const lens = await d.q(`SELECT id, jsonb_array_length(options)::int AS n FROM questions WHERE id = ANY($1::int[])`, [picked]);
  const nById = Object.fromEntries(lens.map((x) => [x.id, x.n]));
  const orders = picked.map((id) => shuffle([...Array(nById[id]).keys()]));
  const config = { limitMs: s.timeLimitSec * 1000, points: s.points, streakBonus: s.streakBonus, streakCap: s.streakCap, showExplanation: s.showExplanation };
  const g = await d.q(
    `INSERT INTO games (player_id, question_ids, option_orders, config) VALUES ($1, $2::int[], $3::jsonb, $4::jsonb) RETURNING id`,
    [pid, picked, JSON.stringify(orders), JSON.stringify(config)]);
  return json({ gameId: g[0].id, total: picked.length, index: 0, resumed: false });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function loadGame(d, gameId, pid) {
  if (!UUID.test(String(gameId))) fail(400, 'Unknown game.');
  const r = await d.q(
    `SELECT g.*, (EXTRACT(EPOCH FROM (now() - g.served_at)) * 1000)::int AS elapsed
     FROM games g WHERE g.id = $1 AND g.player_id = $2`, [gameId, pid]);
  if (!r[0]) fail(404, 'Game not found.');
  return r[0];
}

async function apiNext(env, req) {
  const b = await body(req);
  const pid = await verifyPlayer(env, b.playerKey);
  const d = db(env);
  let g = await loadGame(d, b.gameId, pid);
  if (g.status !== 'playing' || g.current_index >= g.question_ids.length) return json({ done: true });
  if (!g.served_at) {
    await d.q(`UPDATE games SET served_at = now() WHERE id = $1 AND served_at IS NULL`, [g.id]);
    g = await loadGame(d, b.gameId, pid);
  }
  const idx = g.current_index;
  const q = (await d.q(`SELECT question, options, difficulty, category FROM questions WHERE id = $1`, [g.question_ids[idx]]))[0];
  const order = g.option_orders[idx];
  const limitMs = g.config.limitMs;
  return json({
    done: false, index: idx, total: g.question_ids.length,
    question: q.question, category: q.category, difficulty: q.difficulty,
    options: order.map((i) => q.options[i]),
    points: g.config.points[q.difficulty], limitMs,
    remainingMs: Math.max(0, limitMs - Math.max(0, (g.elapsed || 0) - GRACE_MS)),
    score: g.score, streak: g.streak,
  });
}

async function apiAnswer(env, req) {
  const b = await body(req);
  const pid = await verifyPlayer(env, b.playerKey);
  const d = db(env);
  const g = await loadGame(d, b.gameId, pid);
  if (g.status !== 'playing') fail(409, 'This game is over.');
  if (!g.served_at || Number(b.index) !== g.current_index) fail(409, 'That question was already answered.');
  const idx = g.current_index;
  const qid = g.question_ids[idx];
  const q = (await d.q(`SELECT correct_index, difficulty, explanation FROM questions WHERE id = $1`, [qid]))[0];
  const order = g.option_orders[idx];
  const cfg = g.config;

  const choice = b.choice === null || b.choice === undefined ? null : Number(b.choice);
  if (choice !== null && !(Number.isInteger(choice) && choice >= 0 && choice < order.length)) fail(400, 'Invalid option.');
  const elapsed = Math.max(0, (g.elapsed || 0) - GRACE_MS);
  const late = elapsed > cfg.limitMs + LATE_MS;
  const chosenOrig = choice === null ? null : order[choice];
  const correct = !late && chosenOrig !== null && chosenOrig === q.correct_index;
  const timeMs = Math.min(elapsed, cfg.limitMs);

  const base = correct ? cfg.points[q.difficulty] : 0;
  const speed = correct ? Math.round(base * Math.max(0, cfg.limitMs - timeMs) / cfg.limitMs) : 0;
  const streak = correct ? g.streak + 1 : 0;
  const streakPts = correct && streak >= 2 ? Math.min(cfg.streakCap, cfg.streakBonus * (streak - 1)) : 0;
  const points = base + speed + streakPts;
  const done = idx + 1 >= g.question_ids.length;

  const upd = await d.q(
    `UPDATE games SET current_index = $3, served_at = NULL, score = score + $4,
       correct_count = correct_count + $5, total_ms = total_ms + $6, streak = $7,
       best_streak = GREATEST(best_streak, $7),
       status = CASE WHEN $8 THEN 'finished' ELSE status END,
       finished_at = CASE WHEN $8 THEN now() ELSE finished_at END
     WHERE id = $1 AND current_index = $2 AND status = 'playing'
     RETURNING score`,
    [g.id, idx, idx + 1, points, correct ? 1 : 0, timeMs, streak, done]);
  if (!upd[0]) fail(409, 'That question was already answered.');
  await d.q(
    `INSERT INTO answers (game_id, q_index, question_id, chosen_index, is_correct, time_ms, points)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
    [g.id, idx, qid, chosenOrig, correct, timeMs, points]);

  return json({
    correct, timedOut: choice === null || late, correctChoice: order.indexOf(q.correct_index),
    points, breakdown: { base, speed, streak: streakPts }, timeMs,
    score: upd[0].score, streak, done,
    explanation: cfg.showExplanation ? q.explanation || null : null,
  });
}

async function apiResult(env, req) {
  const b = await body(req);
  const pid = await verifyPlayer(env, b.playerKey);
  const d = db(env);
  const g = await loadGame(d, b.gameId, pid);
  if (g.status === 'playing') fail(409, 'Finish the game first.');
  const s = await getSettings(d);
  const player = (await d.q(`SELECT name, district FROM players WHERE id = $1`, [pid]))[0];
  const answers = await d.q(`SELECT is_correct, points FROM answers WHERE game_id = $1 ORDER BY q_index`, [g.id]);
  const best = (await d.q(
    `SELECT id FROM games WHERE player_id = $1 AND status = 'finished'
     ORDER BY score DESC, total_ms ASC, finished_at ASC LIMIT 1`, [pid]))[0];
  const played = (await d.q(`SELECT count(*)::int AS n FROM games WHERE player_id = $1 AND status <> 'void'`, [pid]))[0].n;
  const [overall, district] = await Promise.all([leaderboard(d, null, pid), leaderboard(d, player.district, pid)]);
  return json({
    score: g.score, correct: g.correct_count, total: g.question_ids.length, timeMs: g.total_ms,
    bestStreak: g.best_streak, voided: g.status === 'void',
    personalBest: best?.id === g.id,
    answers: answers.map((a) => ({ correct: a.is_correct, points: a.points })),
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
  return json(await leaderboard(db(env), district || null, pid), 200, { 'cache-control': 'public, max-age=15' });
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
      (SELECT count(*)::int FROM players) AS players,
      (SELECT count(*)::int FROM players WHERE created_at > now() - interval '24 hours') AS players_24h,
      (SELECT count(*)::int FROM games) AS games,
      (SELECT count(*)::int FROM games WHERE status = 'finished') AS finished,
      (SELECT count(*)::int FROM games WHERE started_at > now() - interval '24 hours') AS games_24h,
      (SELECT coalesce(round(avg(score)), 0)::int FROM games WHERE status = 'finished') AS avg_score,
      (SELECT coalesce(max(score), 0)::int FROM games WHERE status = 'finished') AS top_score,
      (SELECT coalesce(round(avg(correct_count)::numeric, 1), 0)::float FROM games WHERE status = 'finished') AS avg_correct,
      (SELECT coalesce(round(avg(cardinality(question_ids))::numeric, 1), 10)::float FROM games WHERE status = 'finished') AS avg_total,
      (SELECT count(*)::int FROM questions WHERE active) AS active_questions`);
  const byDistrict = await d.q(`
    SELECT p.district, count(DISTINCT p.id)::int AS players,
      count(g.id) FILTER (WHERE g.status = 'finished')::int AS games,
      coalesce(round(avg(g.score) FILTER (WHERE g.status = 'finished')), 0)::int AS avg_score,
      coalesce(max(g.score) FILTER (WHERE g.status = 'finished'), 0)::int AS top_score
    FROM players p LEFT JOIN games g ON g.player_id = p.id
    GROUP BY p.district ORDER BY players DESC`);
  const daily = await d.q(`
    SELECT to_char(date_trunc('day', started_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS day,
      count(*)::int AS games, count(*) FILTER (WHERE status = 'finished')::int AS finished,
      count(DISTINCT player_id)::int AS players
    FROM games WHERE started_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`);
  const hourly = await d.q(`
    SELECT extract(hour FROM started_at AT TIME ZONE 'Asia/Kolkata')::int AS hour, count(*)::int AS games
    FROM games GROUP BY 1 ORDER BY 1`);
  const byLevel = await d.q(`
    SELECT q.difficulty, count(*)::int AS attempts,
      coalesce(round(100.0 * avg(a.is_correct::int)), 0)::int AS accuracy,
      coalesce(round(avg(a.time_ms)), 0)::int AS avg_ms
    FROM answers a JOIN questions q ON q.id = a.question_id GROUP BY q.difficulty`);
  const spread = await d.q(`
    SELECT correct_count AS correct, count(*)::int AS games FROM games WHERE status = 'finished' GROUP BY 1 ORDER BY 1`);
  const hardest = await d.q(`
    SELECT q.id, q.question, q.difficulty, count(*)::int AS attempts,
      round(100.0 * avg(a.is_correct::int))::int AS accuracy
    FROM answers a JOIN questions q ON q.id = a.question_id
    GROUP BY q.id HAVING count(*) >= 3 ORDER BY accuracy ASC, attempts DESC LIMIT 8`);
  return json({ totals, byDistrict, daily, hourly, byLevel, spread, hardest, districts: DISTRICTS });
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
    active: b.active !== false,
  };
}

async function adminQuestions(env) {
  const rows = await db(env).q(`
    SELECT q.id, q.question, q.options, q.correct_index, q.difficulty, q.category, q.explanation, q.active, q.updated_at,
      count(a.question_id)::int AS attempts,
      coalesce(round(100.0 * avg(a.is_correct::int)), 0)::int AS accuracy,
      coalesce(round(avg(a.time_ms)), 0)::int AS avg_ms
    FROM questions q LEFT JOIN answers a ON a.question_id = q.id
    GROUP BY q.id ORDER BY q.id DESC`);
  return json({ questions: rows });
}
async function adminSaveQuestion(env, req, id) {
  const v = validateQuestion(await body(req));
  const d = db(env);
  const params = [v.question, JSON.stringify(v.options), v.correct, v.difficulty, v.category, v.explanation, v.active];
  const r = id
    ? await d.q(`UPDATE questions SET question = $1, options = $2::jsonb, correct_index = $3, difficulty = $4, category = $5,
        explanation = $6, active = $7, updated_at = now() WHERE id = $8 RETURNING id`, [...params, id])
    : await d.q(`INSERT INTO questions (question, options, correct_index, difficulty, category, explanation, active)
        VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7) RETURNING id`, params);
  if (!r[0]) fail(404, 'Question not found.');
  return json({ id: r[0].id });
}
async function adminDeleteQuestion(env, id) {
  const d = db(env);
  const used = await d.q(`SELECT 1 FROM answers WHERE question_id = $1 LIMIT 1`, [id]);
  if (used[0]) {
    await d.q(`UPDATE questions SET active = false, updated_at = now() WHERE id = $1`, [id]);
    return json({ deactivated: true });
  }
  await d.q(`DELETE FROM questions WHERE id = $1`, [id]);
  return json({ deleted: true });
}
async function adminImport(env, req) {
  const b = await body(req);
  const list = Array.isArray(b.questions) ? b.questions : [];
  if (!list.length) fail(400, 'No questions found in the file.');
  if (list.length > 500) fail(400, 'Import up to 500 questions at a time.');
  const vs = list.map(validateQuestion);
  const params = [];
  const values = vs.map((v) => {
    params.push(v.question, JSON.stringify(v.options), v.correct, v.difficulty, v.category, v.explanation);
    const n = params.length;
    return `($${n - 5}, $${n - 4}::jsonb, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
  });
  await db(env).q(`INSERT INTO questions (question, options, correct_index, difficulty, category, explanation) VALUES ${values.join(',')}`, params);
  return json({ imported: vs.length });
}

async function adminPlayers(env, url) {
  const search = clean(url.searchParams.get('q'), 80);
  const district = url.searchParams.get('district') || '';
  const page = Math.max(0, Number(url.searchParams.get('page')) || 0);
  const like = `%${search}%`;
  const where = `($1 = '' OR p.name ILIKE $2 OR p.office ILIKE $2 OR p.phone LIKE $2) AND ($3 = '' OR p.district = $3)`;
  const d = db(env);
  const rows = await d.q(`
    SELECT p.id, p.name, p.office, p.district, p.phone, p.created_at,
      count(g.id) FILTER (WHERE g.status <> 'void')::int AS games,
      max(g.score) FILTER (WHERE g.status = 'finished') AS best,
      max(g.correct_count) FILTER (WHERE g.status = 'finished') AS best_correct,
      max(g.started_at) AS last_played
    FROM players p LEFT JOIN games g ON g.player_id = p.id
    WHERE ${where}
    GROUP BY p.id ORDER BY best DESC NULLS LAST, p.created_at DESC
    LIMIT 50 OFFSET $4`, [search, like, district, page * 50]);
  const total = await d.q(`SELECT count(*)::int AS n FROM players p WHERE ${where}`, [search, like, district]);
  return json({ players: rows, total: total[0].n, page });
}
async function adminPlayer(env, id) {
  const d = db(env);
  const p = (await d.q(`SELECT * FROM players WHERE id = $1`, [id]))[0];
  if (!p) fail(404, 'Player not found.');
  const games = await d.q(`
    SELECT id, score, correct_count, cardinality(question_ids) AS total, total_ms, best_streak, status, started_at, finished_at
    FROM games WHERE player_id = $1 ORDER BY started_at DESC`, [id]);
  const answers = await d.q(`
    SELECT a.game_id, a.q_index, a.is_correct, a.time_ms, a.points, a.chosen_index, q.question, q.options, q.correct_index, q.difficulty
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

async function adminExport(env, url) {
  const type = url.searchParams.get('type');
  const d = db(env);
  let head, rows;
  if (type === 'leaderboard') {
    head = ['Rank', 'Name', 'Office', 'District', 'Phone', 'Best score', 'Correct', 'Time (s)', 'Finished at'];
    const r = await d.q(`${boardCte(false)}
      SELECT r.rank, p.name, p.office, p.district, p.phone, r.score, r.correct_count, r.total_ms, r.finished_at
      FROM ranked r JOIN players p ON p.id = r.player_id ORDER BY r.rank`);
    rows = r.map((x) => [x.rank, x.name, x.office, x.district, x.phone, x.score, x.correct_count, (x.total_ms / 1000).toFixed(1), x.finished_at]);
  } else if (type === 'games') {
    head = ['Game', 'Name', 'Office', 'District', 'Phone', 'Status', 'Score', 'Correct', 'Questions', 'Time (s)', 'Best streak', 'Started', 'Finished'];
    const r = await d.q(`
      SELECT g.id, p.name, p.office, p.district, p.phone, g.status, g.score, g.correct_count,
        cardinality(g.question_ids) AS total, g.total_ms, g.best_streak, g.started_at, g.finished_at
      FROM games g JOIN players p ON p.id = g.player_id ORDER BY g.started_at DESC`);
    rows = r.map((x) => [x.id, x.name, x.office, x.district, x.phone, x.status, x.score, x.correct_count, x.total, (x.total_ms / 1000).toFixed(1), x.best_streak, x.started_at, x.finished_at]);
  } else if (type === 'questions') {
    head = ['difficulty', 'category', 'question', 'option_a', 'option_b', 'option_c', 'option_d', 'option_e', 'option_f', 'correct', 'explanation', 'active'];
    const r = await d.q(`SELECT * FROM questions ORDER BY id`);
    rows = r.map((x) => {
      const o = [...x.options, '', '', '', '', '', ''].slice(0, 6);
      return [x.difficulty, x.category, x.question, ...o, 'ABCDEF'[x.correct_index], x.explanation, x.active];
    });
  } else {
    head = ['Name', 'Office', 'District', 'Phone', 'Registered', 'Games', 'Best score'];
    const r = await d.q(`
      SELECT p.name, p.office, p.district, p.phone, p.created_at,
        count(g.id) FILTER (WHERE g.status <> 'void')::int AS games, max(g.score) FILTER (WHERE g.status = 'finished') AS best
      FROM players p LEFT JOIN games g ON g.player_id = p.id GROUP BY p.id ORDER BY p.created_at`);
    rows = r.map((x) => [x.name, x.office, x.district, x.phone, x.created_at, x.games, x.best]);
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
    streakBonus: int(b.streakBonus, 0, 1000, cur.streakBonus),
    streakCap: int(b.streakCap, 0, 5000, cur.streakCap),
    maxAttempts: int(b.maxAttempts, 0, 100, cur.maxAttempts),
    open: b.open === undefined ? cur.open : !!b.open,
    showExplanation: b.showExplanation === undefined ? cur.showExplanation : !!b.showExplanation,
  };
  if (next.easy + next.medium + next.hard < 1) fail(400, 'A game needs at least one question.');
  await d.q(`INSERT INTO settings (key, value) VALUES ('game', $1::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(next)]);
  return json(next);
}

// ---------- router ----------
async function route(req, env) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;
  const adminPath = '/' + String(env.ADMIN_PATH || 'union-control-room').replace(/^\/+|\/+$/g, '');

  if (p === adminPath && m === 'GET') {
    return new Response(ADMIN_HTML, {
      headers: {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
      },
    });
  }
  if (!p.startsWith('/api/')) return null;
  if (m === 'POST' && !(req.headers.get('content-type') || '').includes('application/json')) fail(415, 'Send JSON.');

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
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Something went wrong on the server. Try again.' }, 500);
    }
  },
};
