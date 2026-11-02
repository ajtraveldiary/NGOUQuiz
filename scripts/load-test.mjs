// Load + database test (npm run load [players]): many players play full games at the same time through the Worker, on an in-memory D1 stand-in (SQLite).
// Counts database round trips per request type and checks the stored results add up.
import { build } from 'esbuild';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { d1 } from './d1-sqlite.mjs';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
const als = new AsyncLocalStorage();
const root = fileURLToPath(new URL('..', import.meta.url));
await build({ entryPoints: [root + 'src/index.js'], bundle: true, format: 'esm', platform: 'neutral', outfile: root + '.test-build/load.mjs',
  loader: { '.html': 'text', '.sql': 'text' }, logLevel: 'error', mainFields: ['module', 'main'], external: ['node:*'] });
const worker = (await import(pathToFileURL(join(root, '.test-build/load.mjs')).href + '?' + Date.now())).default;
const real = d1(); // tables and starter questions are created by the Worker on the first request
let current = 'setup'; const trips = {}; const times = {};
// every statement or batch sent to the database is one round trip
const trip = () => { const c = als.getStore() || current; trips[c] = (trips[c] || 0) + 1; };
const DB = { ...real,
  prepare: (sql) => { const st = real.prepare(sql); return { ...st, bind: (...a) => { const b = st.bind(...a); return { ...b, all: () => { trip(); return b.all(); } }; } }; },
  batch: (list) => { trip(); return real.batch(list); } };
const env = { APP_SECRET: 'load-secret-0123456789abcdef', ADMIN_PASSWORD: 'x', DB };
async function call(method, path, data, ip) {
  const name = path.replace(/\?.*/, '');
  const t0 = performance.now(); current = name;
  const res = await als.run(name, () => worker.fetch(new Request('https://quiz.test' + path, { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: data && JSON.stringify(data) }), env, {}));
  (times[name] ||= []).push(performance.now() - t0);
  return { status: res.status, body: await res.json() };
}
await call('GET', '/api/config', undefined, '10.0.0.1'); // schema setup
for (const k of Object.keys(trips)) delete trips[k];
const N = Number(process.argv[2] || 150);
const statuses = {};
const t0 = performance.now();
await Promise.all(Array.from({ length: N }, async (_, i) => {
  const ip = '10.1.' + (i >> 8) + '.' + (i & 255);
  const s = (r) => { statuses[r.status] = (statuses[r.status] || 0) + 1; return r; };
  s(await call('GET', '/api/config', undefined, ip)); s(await call('GET', '/api/leaderboard', undefined, ip));
  const reg = s(await call('POST', '/api/register', { name: 'Load ' + i, office: 'Office', district: 'Kottayam', phone: String(7000000000 + i) }, ip)).body;
  const st = s(await call('POST', '/api/game/start', { playerKey: reg.playerKey }, ip)).body;
  for (let k = 0; k < st.total; k++) {
    s(await call('POST', '/api/game/next', { playerKey: reg.playerKey, gameId: st.gameId }, ip));
    s(await call('POST', '/api/game/answer', { playerKey: reg.playerKey, gameId: st.gameId, index: k, choice: k % 4 }, ip));
  }
  s(await call('POST', '/api/game/result', { playerKey: reg.playerKey, gameId: st.gameId }, ip));
}));
const wall = performance.now() - t0;
const per = (n) => ((trips[n] || 0) / times[n].length).toFixed(2);
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * p)].toFixed(1);
console.log(`${N} players, full games in parallel: ${(wall / 1000).toFixed(1)} s, responses ${JSON.stringify(statuses)}`);
console.log('request             calls  db trips/call  median ms  p95 ms');
for (const n of Object.keys(times)) console.log(n.padEnd(20), String(times[n].length).padStart(5), per(n).padStart(14), pct(times[n], 0.5).padStart(10), pct(times[n], 0.95).padStart(7));
const g = real.rows(`SELECT count(*) n, count(*) FILTER (WHERE status='finished') f FROM games`)[0];
const a = real.rows(`SELECT count(*) n FROM answers`)[0].n;
const bad = real.rows(`SELECT count(*) n FROM games g WHERE score <> max(0, (SELECT coalesce(sum(points),0) FROM answers WHERE game_id = g.id)) AND score <> (SELECT coalesce(sum(points),0) FROM answers WHERE game_id = g.id)`)[0].n;
const per_game = real.rows(`SELECT min(c) mn, max(c) mx FROM (SELECT count(*) c FROM answers GROUP BY game_id) x`)[0];
console.log(`database: ${g.n} games (${g.f} finished), ${a} answers (${per_game.mn}–${per_game.mx} per game), games whose score ≠ sum of answer points: ${bad}`);
assert.equal(g.f, N); assert.equal(bad, 0);
