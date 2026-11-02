// One-time copy of the quiz data from Neon Postgres into a SQL file for Cloudflare D1.
// The file replaces everything in the D1 database: tables are created if missing, then emptied, then filled.
//
// PowerShell:  $env:DATABASE_URL = "postgresql://…"; node scripts/export-neon.mjs
// bash:        DATABASE_URL="postgresql://…" node scripts/export-neon.mjs
// then:        npx wrangler d1 execute ngouquiz --remote --file=db/neon-export.sql
//
// db/neon-export.sql holds players' names and phone numbers: it is in .gitignore, delete it once imported.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Tables in the order they must be filled (games need their player, answers their game and question)
const TABLES = ['settings', 'players', 'questions', 'areas', 'games', 'answers'];

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return quote(v.toISOString());
  if (typeof v === 'object') return quote(JSON.stringify(v)); // JSONB values and int[] lists
  return quote(v);
}

// The columns each D1 table has, read from db/schema.sql
function d1Columns(schema) {
  const cols = {};
  for (const [, table, body] of schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) {
    cols[table] = body.split('\n').map((l) => l.trim().match(/^([a-z_]+)\s+[A-Z]/)?.[1]).filter(Boolean);
  }
  return cols;
}

// rows: { table: [row objects as the Postgres driver returns them] } → SQL text for D1
export function toSql(rows, schema) {
  const cols = d1Columns(schema);
  const out = [schema.trim(), '', ...[...TABLES].reverse().map((t) => `DELETE FROM ${t};`), ''];
  for (const t of TABLES) {
    const list = rows[t] || [];
    if (!list.length) continue;
    const use = cols[t].filter((c) => c in list[0]); // a column the Neon copy lacks (e.g. players.area in 2.x) stays empty
    let chunk = [], size = 0;
    const flush = () => {
      if (chunk.length) out.push(`INSERT INTO ${t} (${use.join(', ')}) VALUES\n${chunk.join(',\n')};`);
      chunk = []; size = 0;
    };
    for (const r of list) {
      const line = `(${use.map((c) => sqlValue(r[c])).join(', ')})`;
      const bytes = Buffer.byteLength(line); // Malayalam text is 3 bytes a letter
      if (size + bytes > 60_000) flush(); // D1 takes statements up to 100 KB
      chunk.push(line); size += bytes;
    }
    flush();
  }
  return out.join('\n') + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = String(process.env.DATABASE_URL || '').trim().replace(/^['"]|['"]$/g, '');
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    console.error('Set DATABASE_URL to the Neon connection string (postgresql://…) first. See the top of this file.');
    process.exit(1);
  }
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(url);
  const rows = {};
  for (const t of TABLES) {
    try {
      rows[t] = await sql.query(`SELECT * FROM ${t}` + (t === 'answers' ? ' ORDER BY answered_at' : t === 'settings' ? '' : t === 'games' ? ' ORDER BY started_at' : ' ORDER BY id'));
    } catch (e) {
      if (/does not exist/i.test(String(e?.message))) { rows[t] = []; continue; } // e.g. no areas table in 2.x
      throw e;
    }
    console.log(`${t}: ${rows[t].length} rows`);
  }
  const file = root + 'db/neon-export.sql';
  writeFileSync(file, toSql(rows, readFileSync(root + 'db/schema.sql', 'utf8')));
  const version = rows.settings.find((r) => r.key === 'schema_version')?.value;
  console.log(`\nWrote db/neon-export.sql (database version ${version}). Next:\n  npx wrangler d1 execute ngouquiz --remote --file=db/neon-export.sql`);
}
