// End-to-end API test against an in-memory Postgres (PGlite) — no Neon needed.
// Usage: npm i -D esbuild @electric-sql/pglite && node scripts/test-api.mjs
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url).pathname;
await build({
  entryPoints: [root + 'src/index.js'], bundle: true, format: 'esm', platform: 'neutral',
  outfile: root + '.test-build/worker.mjs', loader: { '.html': 'text', '.sql': 'text' }, logLevel: 'error',
  mainFields: ['module', 'main'], external: ['node:*'],
});
const worker = (await import(root + '.test-build/worker.mjs?' + Date.now())).default;

// database adapter like the Worker's: q() for one statement, tx() for a transaction
const mkDb = (db) => ({
  q: async (t, p = []) => (await db.query(t, p)).rows,
  tx: (list) => db.transaction(async (t) => { const out = []; for (const [q, p = []] of list) out.push((await t.query(q, p)).rows); return out; }),
});
const POOL = JSON.parse(readFileSync(root + 'db/seed-questions.json', 'utf8'));
const pg = new PGlite();
await pg.exec(readFileSync(root + 'db/schema.sql', 'utf8'));
await pg.exec(readFileSync(root + 'db/seed.sql', 'utf8'));
const env = {
  APP_SECRET: 'test-secret-0123456789abcdef', ADMIN_PASSWORD: 'pass123', ADMIN_PATH: 'secret-room',
  __db: mkDb(pg),
};
async function call(method, path, data, headers = {}) {
  const init = { method, headers: { 'content-type': 'application/json', ...headers } };
  if (data !== undefined) init.body = JSON.stringify(data);
  const res = await worker.fetch(new Request('https://quiz.test' + path, init), env, {});
  const ct = res.headers.get('content-type') || '';
  const out = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body: out, headers: res.headers };
}
const ok = (r, label) => { if (r.status !== 200) { console.error(label, r); process.exit(1); } return r.body; };

// config
const cfg = ok(await call('GET', '/api/config'), 'config');
assert.equal(cfg.totalQuestions, 10);
assert.ok(!['bonusQuestion', 'campaign', 'subtitle', 'tagline', 'values', 'areas'].some((k) => k in cfg), 'no event or organisation details in the config');
assert.equal(cfg.version, JSON.parse(readFileSync(root + 'package.json', 'utf8')).version);
assert.equal(ok(await call('GET', '/api/version'), 'version').version, cfg.version);
assert.equal((await worker.fetch(new Request('https://quiz.test/api/version'), { ...env, __db: undefined, DATABASE_URL: '' }, {})).status, 200, 'version check needs no database');
{
  const html = readFileSync(root + 'public/index.html', 'utf8');
  for (const re of [/name="app-version" content="([^"]+)"/, /\/app\.js\?v=([^"]+)"/, /\/style\.css\?v=([^"]+)"/]) {
    assert.equal(html.match(re)?.[1], cfg.version, 'run node scripts/stamp-version.mjs: ' + re);
  }
}
assert.equal(cfg.districts.length, 14);
assert.ok(cfg.districts.includes('Thiruvananthapuram') && !cfg.districts.some((d) => /North|South/.test(d)));

// validation: a name (or nickname) and a district
assert.equal((await call('POST', '/api/register', { name: 'A', district: 'Kollam' })).status, 400);
assert.equal((await call('POST', '/api/register', { name: 'Anu', district: 'Nowhere' })).status, 400);

async function playGame(player, strategy, existingKey) {
  const key = existingKey || ok(await call('POST', '/api/register', player), 'register').playerKey;
  const st = ok(await call('POST', '/api/game/start', { playerKey: key }), 'start');
  const levels = [];
  let last;
  for (let i = 0; i < st.total; i++) {
    const q = ok(await call('POST', '/api/game/next', { playerKey: key, gameId: st.gameId }), 'next');
    assert.equal(q.index, i);
    assert.ok(q.remainingMs > 13000 && q.remainingMs <= 15000, 'timer starts at 15s');
    assert.ok(!('correct_index' in q) && !('correctChoice' in q), 'answer must not leak');
    levels.push(q.difficulty);
    // refresh-safe: asking again returns the same question
    const again = ok(await call('POST', '/api/game/next', { playerKey: key, gameId: st.gameId }), 'next again');
    assert.equal(again.question, q.question);
    const choice = await strategy(i, q, key, st.gameId);
    last = await call('POST', '/api/game/answer', { playerKey: key, gameId: st.gameId, index: i, choice });
    ok(last, 'answer');
    // double submit is rejected
    const dup = await call('POST', '/api/game/answer', { playerKey: key, gameId: st.gameId, index: i, choice });
    assert.equal(dup.status, 409);
  }
  assert.equal(last.body.done, true);
  const res = ok(await call('POST', '/api/game/result', { playerKey: key, gameId: st.gameId }), 'result');
  return { key, st, levels, res };
}

// Player 1: answers everything correctly (look up the right answer by peeking at the DB)
async function cheatCorrect(i, q, key, gameId) {
  const g = (await pg.query('SELECT question_ids, option_orders FROM games WHERE id = $1', [gameId])).rows[0];
  const qq = (await pg.query('SELECT correct_index FROM questions WHERE id = $1', [g.question_ids[i]])).rows[0];
  return g.option_orders[i].indexOf(qq.correct_index);
}
const p1 = await playGame({ name: 'Anu Mohan', district: 'Thiruvananthapuram' }, cheatCorrect);
assert.deepEqual(p1.levels, ['easy', 'easy', 'easy', 'easy', 'medium', 'medium', 'medium', 'medium', 'hard', 'hard'], '10 questions, no bonus');
assert.ok(p1.res.answers.every((a) => !('bonus' in a)));
assert.equal(p1.res.correct, 10);
assert.equal(p1.res.bestStreak, 10);
assert.equal(p1.res.overall.me.rank, 1);
assert.ok(p1.res.personalBest);
// max score: base*2 per question (instant) + streak bonus 25,50,75,100,100…
const PTS = { easy: 100, medium: 150, hard: 200 };
const expected = p1.levels.reduce((t, l, i) => t + 2 * PTS[l] + Math.min(100, 25 * i), 0);
assert.equal(p1.res.score, expected, `score ${p1.res.score} vs ${expected}`);
console.log('✓ perfect game score', p1.res.score);

// Player 2: wrong on everything, plus a timeout on Q1
const p2 = await playGame({ name: 'Biju K', district: 'Kollam' }, async (i, q, key, gameId) => {
  if (i === 0) { await pg.query(`UPDATE games SET served_at = now() - interval '30 seconds' WHERE id = $1`, [gameId]); return 1; }
  const right = await cheatCorrect(i, q, key, gameId);
  return (right + 1) % q.options.length;
});
assert.equal(p2.res.score, 0);
assert.equal(p2.res.overall.me.rank, 2);
assert.equal(p2.res.districtBoard.me.rank, 1);
console.log('✓ zero game, timeout + wrong answers handled');

// Player 3: half right, slow-ish answers (10s each)
const p3 = await playGame({ name: 'Cicily', district: 'Kottayam' }, async (i, q, key, gameId) => {
  await pg.query(`UPDATE games SET served_at = now() - interval '10.4 seconds' WHERE id = $1`, [gameId]);
  const right = await cheatCorrect(i, q, key, gameId);
  return i % 2 === 0 ? right : (right + 1) % q.options.length;
});
assert.equal(p3.res.correct, 5); // 10 questions, every other one right
assert.equal(p3.res.overall.me.rank, 2);
assert.equal(p3.res.overall.total, 3);
console.log('✓ half-right game score', p3.res.score, 'rank', p3.res.overall.me.rank);

// Player 4: right, wrong, skip, wrong... checks negative marks and skips exactly
{
  const reg = ok(await call('POST', '/api/register', { name: 'Deepa', district: 'Kottayam' }), 'reg4');
  const st = ok(await call('POST', '/api/game/start', { playerKey: reg.playerKey }), 'start4');
  const peek = async (i) => {
    const g = (await pg.query('SELECT question_ids, option_orders FROM games WHERE id = $1', [st.gameId])).rows[0];
    const qq = (await pg.query('SELECT correct_index FROM questions WHERE id = $1', [g.question_ids[i]])).rows[0];
    return g.option_orders[i].indexOf(qq.correct_index);
  };
  const ans = async (i, choice) => {
    ok(await call('POST', '/api/game/next', { playerKey: reg.playerKey, gameId: st.gameId }), 'next4');
    return ok(await call('POST', '/api/game/answer', { playerKey: reg.playerKey, gameId: st.gameId, index: i, choice }), 'ans4');
  };
  const a0 = await ans(0, await peek(0));                       // right (easy): about +200
  assert.ok(a0.correct && a0.points > 190);
  const a1 = await ans(1, ((await peek(1)) + 1) % 4);            // wrong (easy): -25
  assert.equal(a1.wrong, true); assert.equal(a1.points, -25); assert.equal(a1.penalty, 25); assert.equal(a1.streak, 0);
  assert.equal(a1.score, a0.points - 25);
  ok(await call('POST', '/api/game/next', { playerKey: reg.playerKey, gameId: st.gameId }), 'next4');
  const early = await call('POST', '/api/game/answer', { playerKey: reg.playerKey, gameId: st.gameId, index: 2, choice: 'skip' });
  assert.equal(early.status, 400, 'no skip in the first 5 seconds');
  await pg.query(`UPDATE games SET served_at = now() - interval '6 seconds' WHERE id = $1`, [st.gameId]);
  const a2 = ok(await call('POST', '/api/game/answer', { playerKey: reg.playerKey, gameId: st.gameId, index: 2, choice: 'skip' }), 'skip'); // skip: 0, no penalty
  assert.equal(a2.skipped, true); assert.equal(a2.points, 0); assert.equal(a2.score, a1.score); assert.equal(a2.timedOut, false);
  let last;
  for (let i = 3; i < st.total; i++) last = await ans(i, ((await peek(i)) + 1) % 4); // all wrong: score floors at 0
  assert.equal(last.wrong, true); assert.equal(last.points, 0); assert.equal(last.fullPenalty, 50); // hard, score already at zero
  const res = ok(await call('POST', '/api/game/result', { playerKey: reg.playerKey, gameId: st.gameId }), 'res4');
  assert.equal(res.score, 0);
  assert.equal(res.wrong, 8); assert.equal(res.skipped, 1); assert.equal(res.correct, 1);
  assert.equal(res.marksLost, a0.points);
  assert.deepEqual(res.answers.slice(0, 3).map((a) => a.state), ['right', 'wrong', 'skipped']);
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM answers WHERE game_id = $1 AND skipped', [st.gameId])).rows[0].n, 1);
  assert.equal((await call('POST', '/api/game/answer', { playerKey: reg.playerKey, gameId: st.gameId, index: 10, choice: 'nope' })).status, 409);
  console.log('✓ negative marks, skip without penalty, score never below zero');
}

// The same player (same key on their phone) plays again; best score counts once on the board
const again = await playGame(null, cheatCorrect, p2.key);
assert.equal(again.res.overall.total, 4);
assert.ok(again.res.personalBest);
console.log('✓ replay keeps one board entry; Biju now rank', again.res.overall.me.rank);

// Wrong player key
assert.equal((await call('POST', '/api/game/next', { playerKey: '1.bad', gameId: p1.st.gameId })).status, 401);
// Someone else's game
assert.equal((await call('POST', '/api/game/next', { playerKey: p3.key, gameId: p1.st.gameId })).status, 404);

// Public leaderboard
const lb = ok(await call('GET', '/api/leaderboard?district=Kollam&key=' + encodeURIComponent(p2.key)), 'board');
assert.equal(lb.top[0].isMe, true);
assert.ok(lb.top.every((x) => !('phone' in x) && !('office' in x) && !('area' in x)), 'no phone, office or area in public data');

// Admin
assert.equal((await call('GET', '/api/admin/stats')).status, 401);
assert.equal((await call('POST', '/api/admin/login', { password: 'nope' })).status, 401);
const { token } = ok(await call('POST', '/api/admin/login', { password: 'pass123' }), 'login');
const A = { authorization: 'Bearer ' + token };
const page = await call('GET', '/secret-room');
assert.equal(page.status, 200);
assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
const stats = ok(await call('GET', '/api/admin/stats', undefined, A), 'stats');
assert.equal(stats.totals.players, 4);
assert.equal(stats.totals.finished, 5);
const qs = ok(await call('GET', '/api/admin/questions', undefined, A), 'questions');
assert.equal(qs.questions.length, POOL.length);
assert.ok(qs.questions.every((q) => /[\u0D00-\u0D7F]/.test(q.question)), 'pool is Malayalam');
const created = ok(await call('POST', '/api/admin/questions', { question: 'ചോദ്യം?', options: ['ഒന്ന്', 'രണ്ട്', 'മൂന്ന്'], correct_index: 1, difficulty: 'easy', category: 'Test' }, A), 'create q');
ok(await call('PUT', '/api/admin/questions/' + created.id, { question: 'ചോദ്യം 2?', options: ['a', 'b'], correct_index: 0, difficulty: 'hard' }, A), 'edit q');
assert.equal((await call('POST', '/api/admin/questions', { question: 'x', options: ['a'], correct_index: 0, difficulty: 'easy' }, A)).status, 400);
assert.deepEqual(ok(await call('DELETE', '/api/admin/questions/' + created.id, undefined, A), 'del'), { deleted: true });
const usedId = qs.questions.find((q) => q.attempts > 0).id;
assert.deepEqual(ok(await call('DELETE', '/api/admin/questions/' + usedId, undefined, A), 'deact'), { deactivated: true });
const imp = ok(await call('POST', '/api/admin/questions/import', { questions: [
  { question: 'Q1', options: ['a', 'b', 'c', 'd'], correct: 2, difficulty: 'medium' },
  { question: 'Q2', options: ['a', 'b'], correct: 0, difficulty: 'hard', explanation: 'because' },
] }, A), 'import');
assert.equal(imp.imported, 2);
// Edit-and-reimport: id updates that question, same text updates by text, active = no hides, new rows are added
{
  const all = ok(await call('GET', '/api/admin/questions', undefined, A), 'qs').questions;
  const [q1, q2] = all.filter((q) => q.active);
  const before = all.length;
  const r = ok(await call('POST', '/api/admin/questions/import', { questions: [
    { id: String(q1.id), question: q1.question + ' (edited)', options: ['x', 'y', 'z'], correct: 2, difficulty: 'hard', category: 'Edited', active: 'yes' },
    { id: '', question: q2.question, options: q2.options, correct: q2.correct_index, difficulty: q2.difficulty, explanation: 'new note', active: 'no' },
    { question: 'Brand-new imported question?', options: ['a', 'b'], correct: 1, difficulty: 'easy', active: 'yes' },
  ] }, A), 'reimport');
  assert.deepEqual([r.updated, r.added], [2, 1]);
  const after = ok(await call('GET', '/api/admin/questions', undefined, A), 'qs2').questions;
  assert.equal(after.length, before + 1, 'no duplicates');
  const e1 = after.find((q) => q.id === q1.id), e2 = after.find((q) => q.id === q2.id);
  assert.equal(e1.question, q1.question + ' (edited)'); assert.deepEqual(e1.options, ['x', 'y', 'z']); assert.equal(e1.correct_index, 2); assert.equal(e1.difficulty, 'hard');
  assert.equal(e2.active, false); assert.equal(e2.explanation, 'new note');
  const dup = await call('POST', '/api/admin/questions/import', { questions: [
    { id: String(q1.id), question: 'a?', options: ['a', 'b'], correct: 0, difficulty: 'easy' },
    { id: String(q1.id), question: 'b?', options: ['a', 'b'], correct: 0, difficulty: 'easy' },
  ] }, A);
  assert.equal(dup.status, 400, 'the same question twice is refused');
  assert.equal(ok(await call('GET', '/api/admin/questions', undefined, A), 'qs3').questions.find((q) => q.id === q1.id).question, q1.question + ' (edited)', 'a refused file changes nothing');
  const csvQ = await call('GET', '/api/admin/export?type=questions', undefined, A);
  assert.ok(csvQ.body.startsWith('\ufeffid,difficulty') || csvQ.body.startsWith('id,difficulty'), 'question export starts with id');
}
const players = ok(await call('GET', '/api/admin/players?q=biju', undefined, A), 'players');
assert.equal(players.total, 1);
const detail = ok(await call('GET', '/api/admin/players/' + players.players[0].id, undefined, A), 'player');
assert.equal(detail.games.length, 2);
assert.equal(detail.answers.length, 20); // 2 games × 10 questions
const lb1 = ok(await call('GET', '/api/leaderboard'), 'board');
assert.ok(lb1.plays >= stats.totals.finished, 'plays include every game');
assert.ok(!('plays' in lb), 'district board has no play count');
ok(await call('POST', `/api/admin/games/${again.st.gameId}/void`, {}, A), 'void');
const lb2 = ok(await call('GET', '/api/leaderboard'), 'board after void');
assert.equal(lb2.top.find((x) => x.name === 'Biju K').score, 0);
assert.equal(lb2.plays, lb1.plays - 1, 'voided game is not a play');
ok(await call('POST', '/api/register', { name: 'Card Only', district: 'Kottayam' }), 'register only');
assert.equal(ok(await call('GET', '/api/leaderboard'), 'board').plays, lb1.plays, 'filling the player card counts as a play');
ok(await call('POST', `/api/admin/games/${again.st.gameId}/restore`, {}, A), 'restore');
const csv = await call('GET', '/api/admin/export?type=leaderboard', undefined, A);
assert.ok(csv.body.includes('Anu Mohan'));
// office name is optional (blank for members of the public); a phone number is never stored; every card is a new player
{
  const r1 = ok(await call('POST', '/api/register', { name: 'Old Client', office: 'DHS', district: 'Kollam', area: 'X', phone: '9876500000' }), 'old fields');
  assert.deepEqual((await pg.query('SELECT office, phone FROM players WHERE name = $1', ['Old Client'])).rows[0], { office: 'DHS', phone: null });
  const pub = ok(await call('POST', '/api/register', { name: 'Public Person', district: 'Kollam', office: '   ' }), 'public');
  assert.equal((await pg.query('SELECT office FROM players WHERE name = $1', ['Public Person'])).rows[0].office, null, 'blank office is stored as empty');
  assert.ok(!('office' in pub.player));
  assert.equal(ok(await call('GET', '/api/admin/players?q=DHS', undefined, A), 'search office').players[0].office, 'DHS');
  assert.ok((await call('GET', '/api/admin/export?type=players', undefined, A)).body.includes('Office'));
  const r2 = ok(await call('POST', '/api/register', { name: 'Old Client', district: 'Kollam', phone: '9876500000' }), 'same again');
  assert.notEqual(r2.playerKey, r1.playerKey);
  assert.deepEqual(Object.keys(r2.player).sort(), ['district', 'name']);
  // a phone that still holds the key of a deleted player is asked for a new card
  await pg.query('DELETE FROM players WHERE name = $1', ['Old Client']);
  assert.equal((await call('POST', '/api/game/start', { playerKey: r2.playerKey })).status, 401);
  console.log('✓ player card: name, district and optional office; office searchable in admin, never public; no phone stored');
}
const qcsv = await call('GET', '/api/admin/export?type=questions', undefined, A);
assert.ok(qcsv.body.split('\r\n').length > 30);
const set = ok(await call('PUT', '/api/admin/settings', { easy: 2, medium: 2, hard: 1, timeLimitSec: 15, maxAttempts: 1, open: true }, A), 'settings');
assert.equal(set.timeLimitSec, 15);
const cfg2 = ok(await call('GET', '/api/config'), 'config2');
assert.equal(cfg2.totalQuestions, 5);
// attempts limit (Biju has 2 games, limit 1)
assert.equal((await call('POST', '/api/game/start', { playerKey: p2.key })).status, 403);
// closed quiz
ok(await call('PUT', '/api/admin/settings', { open: false, maxAttempts: 0 }, A), 'close');
assert.equal((await call('POST', '/api/game/start', { playerKey: p3.key })).status, 403);

assert.equal((await call('GET', '/api/admin/areas', undefined, A)).status, 404, 'the areas page is gone');
// ---- question picking: never two questions with the same topic in one game ----
{
  const { pickQuestions } = await import(root + '.test-build/worker.mjs?pick');
  const pool = POOL.map((q, i) => ({ id: i + 1, difficulty: q.difficulty, category: q.category, topic: q.topic }));
  const MIX = [{ name: 'Political', percent: 60 }, { name: 'Constitution', percent: 10 }, { name: 'KSR & Govt rules', percent: 20 }, { name: 'General political', percent: 10 }];
  for (let g = 0; g < 300; g++) {
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const ids = pickQuestions(shuffled, { easy: 4, medium: 4, hard: 2, categoryMix: MIX });
    assert.equal(ids.length, 10);
    const qs = ids.map((id) => pool[id - 1]);
    assert.equal(new Set(qs.map((q) => q.topic)).size, 10, 'topics repeat in a game');
    assert.deepEqual(qs.map((q) => q.difficulty), ['easy', 'easy', 'easy', 'easy', 'medium', 'medium', 'medium', 'medium', 'hard', 'hard']);
    const byCat = qs.reduce((m, q) => ((m[q.category] = (m[q.category] || 0) + 1), m), {});
    assert.deepEqual(byCat, { Political: 6, Constitution: 1, 'KSR & Govt rules': 2, 'General political': 1 }, JSON.stringify(byCat));
  }
  // a tiny pool still produces a full game (topics may repeat only when unavoidable)
  const tiny = [{ id: 1, difficulty: 'easy', topic: 'a' }, { id: 2, difficulty: 'easy', topic: 'a' }, { id: 3, difficulty: 'hard', topic: 'b' }];
  assert.equal(pickQuestions(tiny, { easy: 2, medium: 0, hard: 1 }).length, 3);
  // quota arithmetic
  const { categoryQuotas } = await import(root + '.test-build/worker.mjs?quota');
  assert.deepEqual(categoryQuotas(MIX, 10).map((x) => x.n), [6, 1, 2, 1]);
  assert.equal(categoryQuotas([{ name: 'A', percent: 50 }, { name: 'B', percent: 50 }], 5).reduce((t, x) => t + x.n, 0), 5);
  assert.equal(categoryQuotas([{ name: 'A', percent: 30 }], 10)[0].n, 3);
  console.log('✓ 300 random games: 6 Political, 1 Constitution, 2 KSR, 1 General political; 4 easy, 4 medium, 2 hard; no repeated topic');
}

// ---- automatic database setup ----
async function callEnv(e, method, path) {
  const res = await worker.fetch(new Request('https://quiz.test' + path, { method }), e, {});
  return { status: res.status, body: await res.json() };
}
// 1. brand-new empty database: tables and starter questions are created on first visit
const fresh = new PGlite();
const envFresh = { ...env, __db: mkDb(fresh) };
const c1 = await callEnv(envFresh, 'GET', '/api/config');
assert.equal(c1.status, 200, JSON.stringify(c1.body));
assert.equal(c1.body.totalQuestions, 10);
const h1 = await callEnv(envFresh, 'GET', '/api/health');
assert.equal(h1.body.ok, true); assert.equal(h1.body.activeQuestions, POOL.length);
assert.equal(h1.body.questionUpgrade, 'done'); assert.equal(h1.body.databaseVersion, h1.body.schemaVersion);
await callEnv(envFresh, 'GET', '/api/health'); // re-running setup must not duplicate questions
assert.equal((await fresh.query('SELECT count(*)::int AS n FROM questions')).rows[0].n, POOL.length);
// 2. database made with the first version (no areas table, old district name) is upgraded
const { execSync } = await import('node:child_process');
const oldSchema = execSync('git show f765cbf:db/schema.sql', { cwd: root }).toString();
const old = new PGlite();
await old.exec(oldSchema);
await old.query(`INSERT INTO players (name, office, district, phone) VALUES ('Old', 'X', 'Thiruvananthapuram', '9999999999')`);
await old.query(`INSERT INTO settings (key, value) VALUES ('game', '{"subtitle": "An organisation", "values": ["x"], "title": "Arivu Quiz"}')`);
await old.query(`INSERT INTO questions (question, options, correct_index, difficulty) VALUES ('Old English question?', '["a","b"]', 0, 'easy')`);
const envOld = { ...env, __db: mkDb(old) };
const c2 = await callEnv(envOld, 'GET', '/api/config');
assert.equal(c2.status, 200, JSON.stringify(c2.body));
assert.equal((await old.query('SELECT count(*)::int AS n FROM players')).rows[0].n, 0, 'players from before v11 are deleted');
assert.equal((await old.query(`SELECT to_regclass('areas') AS t`)).rows[0].t, null, 'areas table removed');
assert.ok(!('subtitle' in c2.body));
assert.deepEqual(Object.keys((await old.query(`SELECT value FROM settings WHERE key = 'game'`)).rows[0].value), ['title'], 'retired settings removed');
await old.query(`INSERT INTO players (name, district) VALUES ('No phone', 'Kollam')`); // phone and office are optional now
// existing questions are cleared once and replaced by the Malayalam pool
assert.equal((await old.query(`SELECT count(*)::int AS n FROM questions WHERE question = 'Old English question?'`)).rows[0].n, 0);
assert.equal((await old.query('SELECT count(*)::int AS n FROM questions')).rows[0].n, POOL.length);
// after the upgrade, questions added by the admin are never removed again
await old.query(`INSERT INTO questions (question, options, correct_index, difficulty) VALUES ('പുതിയ ചോദ്യം?', '["a","b"]', 0, 'easy')`);
await callEnv({ ...envOld, __db: mkDb(old) }, 'GET', '/api/health');
assert.equal((await old.query('SELECT count(*)::int AS n FROM questions')).rows[0].n, POOL.length + 1);
// two Worker instances upgrading at the same moment do not duplicate the pool
const race = new PGlite(); await race.exec(oldSchema);
const rEnv1 = { ...env, __db: mkDb(race) }, rEnv2 = { ...env, __db: mkDb(race) };
await Promise.all([callEnv(rEnv1, 'GET', '/api/config'), callEnv(rEnv2, 'GET', '/api/config')]);
assert.equal((await race.query('SELECT count(*)::int AS n FROM questions')).rows[0].n, POOL.length);
// a v5 database (Malayalam pool with old categories) moves the starter questions to Political, leaves admin questions alone
await race.query(`UPDATE questions SET category = 'NPS'`);
await race.query(`INSERT INTO questions (question, options, correct_index, difficulty, category) VALUES ('അഡ്മിൻ ചോദ്യം?', '["a","b"]', 0, 'easy', 'GK')`);
await race.query(`UPDATE settings SET value = '5'::jsonb WHERE key = 'schema_version'`);
await callEnv({ ...env, __db: mkDb(race) }, 'GET', '/api/health');
// only the original pension questions move to Political; Constitution / KSR / General political keep their own category
assert.equal((await race.query(`SELECT count(*)::int AS n FROM questions WHERE category = 'Political'`)).rows[0].n, POOL.filter((q) => !q.batch).length);
assert.equal((await race.query(`SELECT category FROM questions WHERE question = 'അഡ്മിൻ ചോദ്യം?'`)).rows[0].category, 'GK');
// a v6 database (first questions only) gets the later batches once, no duplicates
{
  const v6 = new PGlite(); await v6.exec(readFileSync(root + 'db/schema.sql', 'utf8'));
  const first = POOL.filter((q) => !q.batch);
  for (const q of first) {
    await v6.query(`INSERT INTO questions (question, options, correct_index, difficulty, category, topic) VALUES ($1, $2::jsonb, $3, $4, 'Political', $5)`,
      [q.question, JSON.stringify(q.options), q.correct, q.difficulty, q.topic]);
  }
  await v6.query(`INSERT INTO settings (key, value) VALUES ('schema_version', '6'::jsonb)`);
  await callEnv({ ...env, __db: mkDb(v6) }, 'GET', '/api/health');
  await callEnv({ ...env, __db: mkDb(v6) }, 'GET', '/api/health');
  assert.equal((await v6.query('SELECT count(*)::int AS n FROM questions')).rows[0].n, POOL.length);
}
// a v9 database (the earlier pool: bonus questions and questions naming an organisation; old districts) is upgraded once
{
  const OLD_POOL = JSON.parse(execSync('git show 91610f6:db/seed-questions.json', { cwd: root, maxBuffer: 1 << 26 }).toString());
  const v9 = new PGlite(); await v9.exec(readFileSync(root + 'db/schema.sql', 'utf8'));
  for (const q of OLD_POOL) {
    await v9.query(`INSERT INTO questions (question, options, correct_index, difficulty, category, topic, campaign) VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7)`,
      [q.question, JSON.stringify(q.options), q.correct, q.difficulty, q.category, q.topic, !!q.campaign]);
  }
  await v9.query(`INSERT INTO players (name, office, district, phone) VALUES ('North', 'X', 'Thiruvananthapuram North', '9000000011'), ('South', 'Y', 'Thiruvananthapuram South', '9000000012')`);
  const gp = (await v9.query(`SELECT id FROM players LIMIT 1`)).rows[0].id;
  await v9.query(`INSERT INTO games (player_id, question_ids, option_orders, config) VALUES ($1, '{1}', '[[0,1]]', '{}')`, [gp]);
  await v9.query(`INSERT INTO settings (key, value) VALUES ('schema_version', '9'::jsonb), ('game', '{"subtitle": "Org", "campaign": {"show": true}, "bonusQuestion": true, "easy": 4}'::jsonb)`);
  const h = await callEnv({ ...env, __db: mkDb(v9) }, 'GET', '/api/health');
  await callEnv({ ...env, __db: mkDb(v9) }, 'GET', '/api/health'); // runs once
  assert.equal(h.body.questionUpgrade, 'done');
  assert.equal(h.body.activeQuestions, POOL.length, 'only the current pool stays active');
  assert.equal((await v9.query('SELECT count(*)::int AS n FROM questions WHERE NOT active')).rows[0].n, OLD_POOL.length - POOL.length, 'retired questions are hidden, not deleted');
  assert.equal((await v9.query('SELECT count(*)::int AS n FROM questions WHERE campaign')).rows[0].n, 0);
  assert.equal((await v9.query('SELECT count(*)::int AS n FROM players')).rows[0].n, 0, 'every earlier player is deleted');
  assert.equal((await v9.query('SELECT count(*)::int AS n FROM games')).rows[0].n, 0, 'with their games');
  assert.deepEqual((await v9.query(`SELECT value FROM settings WHERE key = 'game'`)).rows[0].value, { easy: 4 });
  console.log('✓ upgrade from the earlier pool: 27 questions hidden, earlier players and their games deleted, retired settings removed');
}
// if the question upgrade fails, the quiz keeps running and /api/health reports it
{
  const broken = new PGlite(); await broken.exec(oldSchema);
  const db = mkDb(broken);
  const envBroken = { ...env, __db: { q: db.q, tx: async () => { throw new Error('simulated failure'); } } };
  const c = await callEnv(envBroken, 'GET', '/api/config');
  assert.equal(c.status, 200, 'config still works');
  const h = await callEnv({ ...envBroken }, 'GET', '/api/health');
  assert.equal(h.body.ok, false); assert.match(h.body.questionUpgrade, /simulated failure/);
}
// 3. clear messages for configuration mistakes
const noUrl = { APP_SECRET: env.APP_SECRET, ADMIN_PASSWORD: 'x' };
assert.match((await callEnv(noUrl, 'GET', '/api/config')).body.error, /DATABASE_URL is not set/);
assert.match((await callEnv({ ...noUrl, DATABASE_URL: 'mysql://x' }, 'GET', '/api/health')).body.error, /should start with postgresql/);
console.log('✓ auto setup: empty database, old database upgrade, clear config errors');
console.log('✓ admin: stats, question CRUD, import, players, void/restore, exports, settings');
// Rate limits (in-Worker counter here; Cloudflare's binding when deployed) and requests from other sites
{
  const at = (ip) => ({ 'cf-connecting-ip': ip });
  let r;
  for (let i = 0; i < 121; i++) r = await call('GET', '/api/config', undefined, at('203.0.113.1'));
  assert.equal(r.status, 429, 'reads are limited per address');
  assert.equal(r.headers.get('retry-after'), '60');
  assert.equal((await call('GET', '/api/config', undefined, at('203.0.113.2'))).status, 200, 'other addresses are not affected');
  for (let i = 0; i < 21; i++) r = await call('POST', '/api/register', { name: 'Bot', office: 'DHS', district: 'Kottayam', phone: String(9100000000 + i) }, at('203.0.113.3'));
  assert.equal(r.status, 429, 'player cards are limited per address');
  const bot = ok(await call('POST', '/api/register', { name: 'Bot', office: 'DHS', district: 'Kottayam', phone: '9100000099' }, at('203.0.113.4')), 'bot reg');
  for (let i = 0; i < 11; i++) r = await call('POST', '/api/game/start', { playerKey: bot.playerKey }, at('203.0.113.' + (10 + i)));
  assert.equal(r.status, 429, 'new games are limited per player, whatever the address');
  const other = { name: 'Elsewhere', office: 'DHS', district: 'Kottayam', phone: '9100000098' };
  assert.equal((await call('POST', '/api/register', other, { origin: 'https://evil.example' })).status, 403, 'other sites cannot post');
  assert.equal((await call('POST', '/api/register', other, { origin: 'https://quiz.test' })).status, 200, 'the game itself can');
  const denied = await worker.fetch(new Request('https://quiz.test/api/config'), { ...env, RL_READ: { limit: async () => ({ success: false }) } }, {});
  assert.equal(denied.status, 429, 'uses the Cloudflare binding when present');
  const broken = await worker.fetch(new Request('https://quiz.test/api/config', { headers: at('203.0.113.99') }), { ...env, RL_READ: { limit: async () => { throw new Error('binding down'); } } }, {});
  assert.equal(broken.status, 200, 'a failing Cloudflare binding does not break the game');
  console.log('✓ rate limits per address and per player, Retry-After, other sites blocked, Cloudflare binding used');
}
console.log('\nAll API tests passed.');
