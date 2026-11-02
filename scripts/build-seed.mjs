// Generates db/seed.sql from db/seed-questions.json
// Usage: node scripts/build-seed.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const qs = JSON.parse(readFileSync(new URL('../db/seed-questions.json', import.meta.url), 'utf8'));
const lit = (s) => s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`;

const rows = qs.map((q) =>
  `(${lit(q.question)}, ${lit(JSON.stringify(q.options))}, ${q.correct}, ${lit(q.difficulty)}, ${lit(q.category)}, ${lit(q.explanation)}, ${lit(q.topic)}, ${q.campaign ? 1 : 0})`
);
// D1 takes statements up to 100 KB, so the rows go in groups of 50
const groups = [];
for (let i = 0; i < rows.length; i += 50) groups.push(rows.slice(i, i + 50));

const sql = `-- Starter question pool (${qs.length} questions). Optional: the Worker loads these automatically into an empty pool.
-- Run after schema.sql:  npx wrangler d1 execute ngouquiz --remote --file=db/seed.sql
${groups.map((g) => `INSERT INTO questions (question, options, correct_index, difficulty, category, explanation, topic, campaign) VALUES
${g.join(',\n')};`).join('\n')}
`;
writeFileSync(new URL('../db/seed.sql', import.meta.url), sql);
console.log(`Wrote db/seed.sql with ${qs.length} questions`);
