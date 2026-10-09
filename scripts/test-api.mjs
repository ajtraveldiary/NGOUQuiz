// End-to-end API test against an in-memory Postgres (PGlite) — no Neon needed.
// Usage: npm i -D esbuild @electric-sql/pglite && node scripts/test-api.mjs
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url).pathname;
await build({
  entryPoints: [root + 'src/index.js'], bundle: true, format: 'esm', platform: 'neutral',
  outfile: root + '.test-build/worker.mjs', loader: { '.html': 'text' }, logLevel: 'error',
  mainFields: ['module', 'main'], external: ['node:*'],
});
const worker = (await import(root + '.test-build/worker.mjs?' + Date.now())).default;

const pg = new PGlite();
await pg.exec(readFileSync(root + 'db/schema.sql', 'utf8'));
await pg.exec(readFileSync(root + 'db/seed.sql', 'utf8'));
const env = {
  APP_SECRET: 'test-secret-0123456789abcdef', ADMIN_PASSWORD: 'pass123', ADMIN_PATH: 'secret-room',
  __db: { q: async (t, p = []) => (await pg.query(t, p)).rows },
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
  const g = (await pg.query('SELECT question_ids, option_orders FROM games WHERE id = $1', [gameId])).rows[0];
  const qq = (await pg.query('SELECT correct_index FROM questions WHERE id = $1', [g.question_ids[i]])).rows[0];
  return g.option_orders[i].indexOf(qq.correct_index);
}
const p1 = await playGame({ name: 'Anu Mohan', office: 'DHS Thiruvananthapuram', district: 'Thiruvananthapuram North', phone: '+91 98765 43210' }, cheatCorrect);
assert.deepEqual(p1.levels, ['easy', 'easy', 'easy', 'easy', 'medium', 'medium', 'medium', 'medium', 'hard', 'hard']);
assert.equal(p1.res.correct, 10);
assert.equal(p1.res.bestStreak, 10);
assert.equal(p1.res.overall.me.rank, 1);
assert.ok(p1.res.personalBest);
// max score: base*2 per question (instant) + streak bonus 25,50,75,100,100…
const expected = 4 * 200 + 4 * 300 + 2 * 400 + (0 + 25 + 50 + 75 + 100 * 6);
assert.equal(p1.res.score, expected, `score ${p1.res.score} vs ${expected}`);
console.log('✓ perfect game score', p1.res.score);

// Player 2: wrong on everything, plus a timeout on Q1
const p2 = await playGame({ name: 'Biju K', office: 'Taluk Hospital', district: 'Kollam', area: 'Kottarakkara', phone: '9123456789' }, async (i, q, key, gameId) => {
  if (i === 0) { await pg.query(`UPDATE games SET served_at = now() - interval '30 seconds' WHERE id = $1`, [gameId]); return 1; }
  const right = await cheatCorrect(i, q, key, gameId);
  return (right + 1) % q.options.length;
});
assert.equal(p2.res.score, 0);
assert.equal(p2.res.overall.me.rank, 2);
assert.equal(p2.res.districtBoard.me.rank, 1);
console.log('✓ zero game, timeout + wrong answers handled');

// Player 3: half right, slow-ish answers (10s each)
const p3 = await playGame({ name: 'Cicily', office: 'PHC Kottayam', district: 'Kottayam', phone: '9000000001' }, async (i, q, key, gameId) => {
  await pg.query(`UPDATE games SET served_at = now() - interval '10.4 seconds' WHERE id = $1`, [gameId]);
  const right = await cheatCorrect(i, q, key, gameId);
  return i % 2 === 0 ? right : (right + 1) % q.options.length;
});
assert.equal(p3.res.correct, 5);
assert.equal(p3.res.overall.me.rank, 2);
assert.equal(p3.res.overall.total, 3);
console.log('✓ half-right game score', p3.res.score, 'rank', p3.res.overall.me.rank);

// Same phone registers again → same player, replay; best score counts once on board
const again = await playGame({ name: 'Biju K', office: 'Taluk Hospital', district: 'Kollam', area: 'Kottarakkara', phone: '09123456789' }, cheatCorrect);
assert.equal(again.res.overall.total, 3);
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
assert.equal(stats.totals.players, 3);
assert.equal(stats.totals.finished, 4);
const qs = ok(await call('GET', '/api/admin/questions', undefined, A), 'questions');
assert.equal(qs.questions.length, 36);
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
const players = ok(await call('GET', '/api/admin/players?q=biju', undefined, A), 'players');
assert.equal(players.total, 1);
const detail = ok(await call('GET', '/api/admin/players/' + players.players[0].id, undefined, A), 'player');
assert.equal(detail.games.length, 2);
assert.equal(detail.answers.length, 20);
ok(await call('POST', `/api/admin/games/${again.st.gameId}/void`, {}, A), 'void');
const lb2 = ok(await call('GET', '/api/leaderboard'), 'board after void');
assert.equal(lb2.top.find((x) => x.name === 'Biju K').score, 0);
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
console.log('✓ admin: stats, question CRUD, import, players, void/restore, exports, settings');
console.log('\nAll API tests passed.');
