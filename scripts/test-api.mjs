// End-to-end API test against an in-memory D1 stand-in (Node's built-in SQLite) — no Cloudflare account needed.
// Usage: npm install && npm test
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { d1 } from './d1-sqlite.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const workerFile = pathToFileURL(join(root, '.test-build/worker.mjs')).href;
await build({
  entryPoints: [join(root, 'src/index.js')], bundle: true, format: 'esm', platform: 'neutral',
  outfile: join(root, '.test-build/worker.mjs'), loader: { '.html': 'text', '.sql': 'text' }, logLevel: 'error',
  mainFields: ['module', 'main'], external: ['node:*'],
});
const worker = (await import(workerFile + '?' + Date.now())).default;

const POOL = JSON.parse(readFileSync(join(root, 'db/seed-questions.json'), 'utf8'));
const DB = d1(); // tables and starter questions are created by the Worker on the first request
const env = {
  APP_SECRET: 'test-secret-0123456789abcdef', ADMIN_PASSWORD: 'pass123', ADMIN_PATH: 'secret-room',
  DB,
};
// peeking at the database: a game's questions and option orders, a question's right answer, a question served earlier
const gameRow = (id) => {
  const g = DB.rows('SELECT question_ids, option_orders FROM games WHERE id = ?', id)[0];
  return { question_ids: JSON.parse(g.question_ids), option_orders: JSON.parse(g.option_orders) };
};
const rightIndex = (qid) => DB.rows('SELECT correct_index FROM questions WHERE id = ?', qid)[0].correct_index;
const servedAgo = (gameId, seconds) =>
  DB.rows(`UPDATE games SET served_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) WHERE id = ?`, `-${seconds} seconds`, gameId);
const count = (db, sql, ...args) => db.rows(`SELECT count(*) AS n FROM ${sql}`, ...args)[0].n;
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
assert.equal(cfg.bonusQuestion, true);
assert.equal(cfg.campaign.date, '2026-11-21');
assert.equal(cfg.subtitle, 'Kerala NGO Union');
assert.equal(cfg.version, JSON.parse(readFileSync(root + 'package.json', 'utf8')).version);
assert.equal(ok(await call('GET', '/api/version'), 'version').version, cfg.version);
assert.equal((await worker.fetch(new Request('https://quiz.test/api/version'), { ...env, DB: undefined }, {})).status, 200, 'version check needs no database');
{
  const html = readFileSync(root + 'public/index.html', 'utf8');
  for (const re of [/name="app-version" content="([^"]+)"/, /\/app\.js\?v=([^"]+)"/, /\/style\.css\?v=([^"]+)"/]) {
    assert.equal(html.match(re)?.[1], cfg.version, 'run node scripts/stamp-version.mjs: ' + re);
  }
}
assert.equal(cfg.districts.length, 15);
assert.ok(cfg.districts.includes('Thiruvananthapuram North') && cfg.districts.includes('Thiruvananthapuram South'));
assert.ok(!cfg.districts.includes('Thiruvananthapuram'));

// areas: admin adds areas for Kollam; registration in Kollam then requires one
const { token: tok0 } = ok(await call('POST', '/api/admin/login', { password: 'pass123' }), 'early login');
const A0 = { authorization: 'Bearer ' + tok0 };
assert.deepEqual(ok(await call('POST', '/api/admin/areas', { district: 'Kollam', names: ['Kottarakkara', 'Kollam Town', 'Kottarakkara', ' '] }, A0), 'add areas'), { added: 2, skipped: 0 });
assert.deepEqual(ok(await call('POST', '/api/admin/areas', { district: 'Kollam', names: ['Kollam Town', 'Punalur'] }, A0), 'add more'), { added: 1, skipped: 1 });
assert.equal((await call('POST', '/api/admin/areas', { district: 'Nowhere', names: ['x'] }, A0)).status, 400);
const cfgA = ok(await call('GET', '/api/config'), 'config areas');
assert.deepEqual(cfgA.areas.Kollam, ['Kollam Town', 'Kottarakkara', 'Punalur']);
assert.deepEqual(cfgA.areas.Kottayam, []);
assert.equal((await call('POST', '/api/register', { name: 'Biju', office: 'X', district: 'Kollam', phone: '9123456780' })).status, 400);
assert.equal((await call('POST', '/api/register', { name: 'Biju', office: 'X', district: 'Kollam', area: 'Mars', phone: '9123456780' })).status, 400);
console.log('✓ 15 districts, areas required where configured');

// validation
assert.equal((await call('POST', '/api/register', { name: 'A', office: 'X', district: 'Kollam', phone: '123' })).status, 400);
assert.equal((await call('POST', '/api/register', { name: 'Anu', office: 'DHS', district: 'Nowhere', phone: '9876543210' })).status, 400);

async function playGame(player, strategy) {
  const reg = ok(await call('POST', '/api/register', player), 'register');
  const key = reg.playerKey;
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
  const g = gameRow(gameId);
  return g.option_orders[i].indexOf(rightIndex(g.question_ids[i]));
}
const p1 = await playGame({ name: 'Anu Mohan', office: 'DHS Thiruvananthapuram', district: 'Thiruvananthapuram North', phone: '+91 98765 43210' }, cheatCorrect);
assert.deepEqual(p1.levels.slice(0, 10), ['easy', 'easy', 'easy', 'easy', 'medium', 'medium', 'medium', 'medium', 'hard', 'hard']);
assert.equal(p1.levels.length, 11, '10 regular questions + 1 bonus');
const p1Game = gameRow(p1.st.gameId);
const p1Flags = DB.rows('SELECT id, campaign FROM questions WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(p1Game.question_ids));
const isCampaign = Object.fromEntries(p1Flags.map((r) => [r.id, !!r.campaign]));
assert.deepEqual(p1Game.question_ids.map((id) => isCampaign[id]), [...Array(10).fill(false), true], 'only the last question is about the programme');
assert.equal(p1.res.answers[10].bonus, true);
assert.equal(p1.res.correct, 11);
assert.equal(p1.res.bestStreak, 11);
assert.equal(p1.res.overall.me.rank, 1);
assert.ok(p1.res.personalBest);
// max score: base*2 per question (instant) + streak bonus 25,50,75,100,100…
const PTS = { easy: 100, medium: 150, hard: 200 };
const expected = p1.levels.reduce((t, l, i) => t + 2 * PTS[l] + Math.min(100, 25 * i), 0);
assert.equal(p1.res.score, expected, `score ${p1.res.score} vs ${expected}`);
console.log('✓ perfect game score', p1.res.score);

// Player 2: wrong on everything, plus a timeout on Q1
const p2 = await playGame({ name: 'Biju K', office: 'Taluk Hospital', district: 'Kollam', area: 'Kottarakkara', phone: '9123456789' }, async (i, q, key, gameId) => {
  if (i === 0) { servedAgo(gameId, 30); return 1; }
  const right = await cheatCorrect(i, q, key, gameId);
  return (right + 1) % q.options.length;
});
assert.equal(p2.res.score, 0);
assert.equal(p2.res.overall.me.rank, 2);
assert.equal(p2.res.districtBoard.me.rank, 1);
console.log('✓ zero game, timeout + wrong answers handled');

// Player 3: half right, slow-ish answers (10s each)
const p3 = await playGame({ name: 'Cicily', office: 'PHC Kottayam', district: 'Kottayam', phone: '9000000001' }, async (i, q, key, gameId) => {
  servedAgo(gameId, 10.4);
  const right = await cheatCorrect(i, q, key, gameId);
  return i % 2 === 0 ? right : (right + 1) % q.options.length;
});
assert.equal(p3.res.correct, 6); // 11 questions, every other one right
assert.equal(p3.res.overall.me.rank, 2);
assert.equal(p3.res.overall.total, 3);
console.log('✓ half-right game score', p3.res.score, 'rank', p3.res.overall.me.rank);

// Player 4: right, wrong, skip, wrong... checks negative marks and skips exactly
{
  const reg = ok(await call('POST', '/api/register', { name: 'Deepa', office: 'DHS', district: 'Kottayam', phone: '9000000002' }), 'reg4');
  const st = ok(await call('POST', '/api/game/start', { playerKey: reg.playerKey }), 'start4');
  const peek = async (i) => {
    const g = gameRow(st.gameId);
    return g.option_orders[i].indexOf(rightIndex(g.question_ids[i]));
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
  servedAgo(st.gameId, 6);
  const a2 = ok(await call('POST', '/api/game/answer', { playerKey: reg.playerKey, gameId: st.gameId, index: 2, choice: 'skip' }), 'skip'); // skip: 0, no penalty
  assert.equal(a2.skipped, true); assert.equal(a2.points, 0); assert.equal(a2.score, a1.score); assert.equal(a2.timedOut, false);
  let last;
  for (let i = 3; i < st.total; i++) last = await ans(i, ((await peek(i)) + 1) % 4); // all wrong: score floors at 0
  assert.equal(last.bonus, true); assert.equal(last.wrong, true); assert.equal(last.points, 0); assert.equal(last.fullPenalty, 0);
  const res = ok(await call('POST', '/api/game/result', { playerKey: reg.playerKey, gameId: st.gameId }), 'res4');
  assert.equal(res.score, 0);
  assert.equal(res.wrong, 9); assert.equal(res.skipped, 1); assert.equal(res.correct, 1);
  assert.equal(res.marksLost, a0.points);
  assert.deepEqual(res.answers.slice(0, 3).map((a) => a.state), ['right', 'wrong', 'skipped']);
  assert.equal(count(DB, 'answers WHERE game_id = ? AND skipped', st.gameId), 1);
  assert.equal((await call('POST', '/api/game/answer', { playerKey: reg.playerKey, gameId: st.gameId, index: 10, choice: 'nope' })).status, 409);
  console.log('✓ negative marks, skip without penalty, score never below zero, wrong bonus costs nothing');
  // a correct bonus answer earns points: check with a fresh game answered right only on the bonus
  const st2 = ok(await call('POST', '/api/game/start', { playerKey: reg.playerKey }), 'start4b');
  const peek2 = async (i) => {
    const g = gameRow(st2.gameId);
    return g.option_orders[i].indexOf(rightIndex(g.question_ids[i]));
  };
  let b;
  for (let i = 0; i < st2.total; i++) {
    const nx = ok(await call('POST', '/api/game/next', { playerKey: reg.playerKey, gameId: st2.gameId }), 'next4b');
    assert.equal(!!nx.bonus, i === st2.total - 1);
    servedAgo(st2.gameId, 6);
    b = ok(await call('POST', '/api/game/answer', { playerKey: reg.playerKey, gameId: st2.gameId, index: i, choice: i === st2.total - 1 ? await peek2(i) : 'skip' }), 'ans4b');
  }
  assert.equal(b.bonus, true); assert.equal(b.correct, true); assert.ok(b.points > 0); assert.equal(b.done, true);
}

// Same phone registers again → same player, replay; best score counts once on board
const again = await playGame({ name: 'Biju K', office: 'Taluk Hospital', district: 'Kollam', area: 'Kottarakkara', phone: '09123456789' }, cheatCorrect);
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
assert.equal(lb.top[0].area, 'Kottarakkara');
assert.ok(!('phone' in lb.top[0]), 'phone must not be public');

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
assert.equal(stats.totals.finished, 6);
const qs = ok(await call('GET', '/api/admin/questions', undefined, A), 'questions');
assert.equal(qs.questions.length, POOL.length);
assert.ok(qs.questions.every((q) => /[\u0D00-\u0D7F]/.test(q.question)), 'pool is Malayalam');
{ // skip counts are numbers, in the question list and in the games export
  const skips = count(DB, 'answers WHERE skipped');
  assert.ok(skips > 1);
  assert.ok(qs.questions.every((q) => typeof q.skipped === 'number' && typeof q.active === 'boolean'));
  assert.equal(qs.questions.reduce((t, q) => t + q.skipped, 0), skips);
  const csv = (await call('GET', '/api/admin/export?type=games', undefined, A)).body.split('\r\n').slice(1).map((l) => l.split(','));
  assert.equal(csv.reduce((t, r) => t + Number(r[10]), 0), skips);
}
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
assert.equal(detail.answers.length, 22); // 2 games × 11 questions
const lb1 = ok(await call('GET', '/api/leaderboard'), 'board');
assert.ok(lb1.plays >= stats.totals.finished, 'plays include every game');
assert.ok(!('plays' in lb), 'district board has no play count');
ok(await call('POST', `/api/admin/games/${again.st.gameId}/void`, {}, A), 'void');
const lb2 = ok(await call('GET', '/api/leaderboard'), 'board after void');
assert.equal(lb2.top.find((x) => x.name === 'Biju K').score, 0);
assert.equal(lb2.plays, lb1.plays - 1, 'voided game is not a play');
ok(await call('POST', '/api/register', { name: 'Card Only', office: 'DHS', district: 'Kottayam', phone: '9000000099' }), 'register only');
assert.equal(ok(await call('GET', '/api/leaderboard'), 'board').plays, lb1.plays, 'filling the player card counts as a play');
ok(await call('POST', `/api/admin/games/${again.st.gameId}/restore`, {}, A), 'restore');
const csv = await call('GET', '/api/admin/export?type=leaderboard', undefined, A);
assert.ok(csv.body.includes('Anu Mohan') && csv.body.includes('9876543210'));
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

const ar = ok(await call('GET', '/api/admin/areas', undefined, A), 'areas list');
const kt = ar.areas.find((a) => a.name === 'Kottarakkara');
assert.equal(kt.players, 1);
assert.equal((await call('PUT', '/api/admin/areas/' + kt.id, { name: 'Kollam Town' }, A)).status, 409);
assert.equal(ok(await call('PUT', '/api/admin/areas/' + kt.id, { name: 'Kottarakara' }, A), 'rename').playersUpdated, 1);
assert.equal(ok(await call('GET', '/api/admin/players?district=Kollam&area=Kottarakara', undefined, A), 'by area').total, 1);
assert.ok(ok(await call('GET', '/api/admin/stats', undefined, A), 'stats2').byArea.some((x) => x.area === 'Kottarakara'));
assert.ok((await call('GET', '/api/admin/export?type=players', undefined, A)).body.includes('Kottarakara'));
ok(await call('DELETE', '/api/admin/areas/' + kt.id, undefined, A), 'delete area');
assert.ok(!ok(await call('GET', '/api/config'), 'cfg3').areas.Kollam.includes('Kottarakara'));
console.log('✓ areas: rename updates players, filter, stats, export, delete');
// ---- question picking: never two questions with the same topic in one game ----
{
  const { pickQuestions } = await import(workerFile + '?pick');
  const pool = POOL.map((q, i) => ({ id: i + 1, difficulty: q.difficulty, category: q.category, topic: q.topic, campaign: !!q.campaign }));
  const MIX = [{ name: 'Political', percent: 60 }, { name: 'Constitution', percent: 10 }, { name: 'KSR & Govt rules', percent: 20 }, { name: 'General political', percent: 10 }];
  for (let g = 0; g < 300; g++) {
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const ids = pickQuestions(shuffled, { easy: 4, medium: 4, hard: 2, bonusQuestion: true, categoryMix: MIX });
    assert.equal(ids.length, 11);
    const qs = ids.map((id) => pool[id - 1]);
    assert.equal(new Set(qs.map((q) => q.topic)).size, 11, 'topics repeat in a game');
    assert.deepEqual(qs.slice(0, 10).map((q) => q.difficulty), ['easy', 'easy', 'easy', 'easy', 'medium', 'medium', 'medium', 'medium', 'hard', 'hard']);
    assert.deepEqual(qs.map((q) => q.campaign), [...Array(10).fill(false), true], 'exactly one programme question, as the bonus');
    const byCat = qs.slice(0, 10).reduce((m, q) => ((m[q.category] = (m[q.category] || 0) + 1), m), {});
    assert.deepEqual(byCat, { Political: 6, Constitution: 1, 'KSR & Govt rules': 2, 'General political': 1 }, JSON.stringify(byCat));
    const off = pickQuestions(shuffled, { easy: 4, medium: 4, hard: 2, bonusQuestion: false }).map((id) => pool[id - 1]);
    assert.equal(off.length, 10); assert.ok(off.every((q) => !q.campaign), 'no programme questions when the bonus is off');
  }
  // a tiny pool still produces a full game (topics may repeat only when unavoidable)
  const tiny = [{ id: 1, difficulty: 'easy', topic: 'a' }, { id: 2, difficulty: 'easy', topic: 'a' }, { id: 3, difficulty: 'hard', topic: 'b' }];
  assert.equal(pickQuestions(tiny, { easy: 2, medium: 0, hard: 1 }).length, 3);
  // quota arithmetic
  const { categoryQuotas } = await import(workerFile + '?quota');
  assert.deepEqual(categoryQuotas(MIX, 10).map((x) => x.n), [6, 1, 2, 1]);
  assert.equal(categoryQuotas([{ name: 'A', percent: 50 }, { name: 'B', percent: 50 }], 5).reduce((t, x) => t + x.n, 0), 5);
  assert.equal(categoryQuotas([{ name: 'A', percent: 30 }], 10)[0].n, 3);
  console.log('✓ 300 random games: 6 Political, 1 Constitution, 2 KSR, 1 General political; 4 easy, 4 medium, 2 hard; + 1 programme bonus; no repeated topic');
}

// ---- automatic database setup ----
async function callEnv(e, method, path) {
  const res = await worker.fetch(new Request('https://quiz.test' + path, { method }), e, {});
  return { status: res.status, body: await res.json() };
}
// 1. brand-new empty database: tables and starter questions are created on first visit
const fresh = d1();
const envFresh = { ...env, DB: fresh };
const c1 = await callEnv(envFresh, 'GET', '/api/config');
assert.equal(c1.status, 200, JSON.stringify(c1.body));
assert.equal(c1.body.totalQuestions, 10);
const h1 = await callEnv(envFresh, 'GET', '/api/health');
assert.equal(h1.body.ok, true); assert.equal(h1.body.activeQuestions, POOL.length);
assert.equal(h1.body.questionUpgrade, 'done'); assert.equal(h1.body.databaseVersion, h1.body.schemaVersion);
await callEnv(envFresh, 'GET', '/api/health'); // re-running setup must not duplicate questions
assert.equal(count(fresh, 'questions'), POOL.length);
assert.equal(count(fresh, 'questions WHERE campaign'), POOL.filter((q) => q.campaign).length);
// 2. a database copied from 2.x (version 11: bonus questions hidden, Thiruvananthapuram one district) is put back to 1.9.1
{
  const v11 = d1();
  await v11.exec(readFileSync(root + 'db/schema.sql', 'utf8'));
  for (const q of POOL) {
    v11.rows(`INSERT INTO questions (question, options, correct_index, difficulty, category, topic, campaign, active) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      q.question, JSON.stringify(q.options), q.correct, q.difficulty, q.category ?? null, q.topic ?? null, q.campaign ? 0 : 1);
  }
  v11.rows(`INSERT INTO questions (question, options, correct_index, difficulty, active) VALUES ('അഡ്മിൻ മറച്ച ചോദ്യം?', '["a","b"]', 0, 'easy', 0)`);
  v11.rows(`INSERT INTO players (name, district) VALUES ('2.x player', 'Thiruvananthapuram')`);
  v11.rows(`INSERT INTO settings (key, value) VALUES ('schema_version', '11')`);
  const h = await callEnv({ ...env, DB: v11 }, 'GET', '/api/health');
  assert.equal(h.body.ok, true, JSON.stringify(h.body)); assert.equal(h.body.databaseVersion, 12);
  assert.equal(count(v11, 'questions WHERE active'), POOL.length, 'hidden bonus questions are shown again');
  assert.equal(count(v11, 'questions WHERE campaign'), POOL.filter((q) => q.campaign).length, 'and are bonus questions again');
  assert.equal(count(v11, `questions WHERE question = 'അഡ്മിൻ മറച്ച ചോദ്യം?' AND NOT active`), 1, 'a question the admin hid stays hidden');
  assert.equal(v11.rows('SELECT district FROM players')[0].district, 'Thiruvananthapuram North');
  assert.equal((await callEnv({ ...env, DB: v11 }, 'GET', '/api/config')).body.bonusQuestion, true);
}
// 3. two Worker instances setting up the same new database at the same moment do not duplicate the pool
{
  const file = join(tmpdir(), `quiz-race-${process.pid}.sqlite`);
  const a = d1(file), b = d1(file);
  await Promise.all([callEnv({ ...env, DB: a }, 'GET', '/api/config'), callEnv({ ...env, DB: b }, 'GET', '/api/config')]);
  assert.equal(count(a, 'questions'), POOL.length);
}
// 4. if the question step fails, the quiz keeps running and /api/health reports it
{
  const real = d1();
  const broken = { ...real, batch: async (list) => {
    if (list.some((s) => /schema_version/.test(s.sql))) throw new Error('simulated failure');
    return real.batch(list);
  } };
  const c = await callEnv({ ...env, DB: broken }, 'GET', '/api/config');
  assert.equal(c.status, 200, 'config still works');
  const h = await callEnv({ ...env, DB: broken }, 'GET', '/api/health');
  assert.equal(h.body.ok, false); assert.match(h.body.questionUpgrade, /simulated failure/);
}
// 5. a clear message when the database is not connected
const noDb = { APP_SECRET: env.APP_SECRET, ADMIN_PASSWORD: 'x' };
assert.match((await callEnv(noDb, 'GET', '/api/config')).body.error, /D1 database is not connected/);
assert.match((await callEnv(noDb, 'GET', '/api/health')).body.error, /D1 database is not connected/);
console.log('✓ auto setup: empty database, upgrade of a 2.x copy, two instances at once, clear config errors');
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
// Security: password guessing and /api/health are limited, formulas in exports stay text, admin page needs ADMIN_PATH
{
  const at = (ip) => ({ 'cf-connecting-ip': ip });
  let r;
  for (let i = 0; i < 11; i++) r = await call('POST', '/api/admin/login', { password: 'guess' + i }, at('203.0.113.50'));
  assert.equal(r.status, 429, 'ten password tries a minute per address');
  for (let i = 0; i < 21; i++) r = await call('GET', '/api/health', undefined, at('203.0.113.51'));
  assert.equal(r.status, 429, 'health check is limited');
  ok(await call('POST', '/api/register', { name: 'Formula', office: '=HYPERLINK("http://x")', district: 'Kottayam', phone: '9100000097' }, at('203.0.113.52')), 'formula reg');
  const { token } = ok(await call('POST', '/api/admin/login', { password: 'pass123' }, at('203.0.113.53')), 'login');
  const csv = (await call('GET', '/api/admin/export?type=players', undefined, { authorization: 'Bearer ' + token, ...at('203.0.113.53') })).body;
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`), 'a formula is exported as text');
  assert.ok(!/,=HYPERLINK|,"=HYPERLINK/.test(csv));
  const page = await worker.fetch(new Request('https://quiz.test/secret-room'), env, {});
  const csp = page.headers.get('content-security-policy');
  // as a browser hashes it: the parsed script, line endings turned into \n
  const script = (await page.text()).match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\r\n?/g, '\n');
  const { createHash } = await import('node:crypto');
  assert.ok(csp.includes(`'sha256-${createHash('sha256').update(script).digest('base64')}'`), 'admin page allows only its own script');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal((await worker.fetch(new Request('https://quiz.test/union-control-room'), { ...env, ADMIN_PATH: undefined }, {})).status, 404, 'no ADMIN_PATH, no admin page');
  console.log('✓ security: login and health limits, formulas in exports kept as text, admin page CSP, admin page only with ADMIN_PATH');
}
// Link preview: the page's og:image and og:url get the site's full address, the page keeps its security headers,
// and the picture is a 1200×630 JPEG small enough for WhatsApp (about 300 KB at most)
{
  // stand-in for Cloudflare's HTMLRewriter: sets the content of matching <meta property="…"> tags
  globalThis.HTMLRewriter = class {
    rules = [];
    on(sel, h) { this.rules.push([sel.match(/\[property="([^"]+)"\]/)[1], h]); return this; }
    async transform(res) {
      let html = await res.text();
      for (const [prop, h] of this.rules) {
        let value; h.element({ setAttribute: (_, v) => { value = v; } });
        html = html.replace(new RegExp(`<meta property="${prop}" content="[^"]*">`), `<meta property="${prop}" content="${value}">`);
      }
      return new Response(html, res);
    }
  };
  const html = readFileSync(join(root, 'public/index.html'), 'utf8');
  const assets = { fetch: async () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }) };
  const res = await worker.fetch(new Request('https://quiz.example.org/?utm_source=whatsapp'), { ...env, ASSETS: assets }, {});
  const page = await res.text();
  assert.match(page, /<meta property="og:image" content="https:\/\/quiz\.example\.org\/og-image\.jpg">/);
  assert.match(page, /<meta property="og:url" content="https:\/\/quiz\.example\.org\/">/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.ok(readFileSync(join(root, 'public/_headers'), 'utf8').includes(res.headers.get('content-security-policy')), 'same policy as public/_headers');
  delete globalThis.HTMLRewriter;
  const jpg = readFileSync(join(root, 'public/og-image.jpg'));
  assert.ok(jpg[0] === 0xff && jpg[1] === 0xd8 && jpg.length < 300_000, 'a small JPEG');
  for (let i = 2; i < jpg.length;) { // the picture's size, from the JPEG frame header
    const marker = jpg[i + 1];
    if (marker >= 0xc0 && marker <= 0xc2) { assert.deepEqual([jpg.readUInt16BE(i + 7), jpg.readUInt16BE(i + 5)], [1200, 630]); break; }
    i += 2 + jpg.readUInt16BE(i + 2);
  }
  console.log('✓ link preview: full picture address on any domain, security headers kept, 1200×630 JPEG of', Math.round(jpg.length / 1024), 'KB');
}
console.log('\nAll API tests passed.');
