// Generates db/seed.sql from db/seed-questions.json
// Usage: node scripts/build-seed.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const qs = JSON.parse(readFileSync(new URL('../db/seed-questions.json', import.meta.url), 'utf8'));
const lit = (s) => s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`;

const rows = qs.map((q) =>
  `(${lit(q.question)}, ${lit(JSON.stringify(q.options))}::jsonb, ${q.correct}, ${lit(q.difficulty)}, ${lit(q.category)}, ${lit(q.explanation)}, ${lit(q.topic)}, ${q.campaign ? 'true' : 'false'})`
);

const sql = `-- Starter question pool (${qs.length} questions). Optional: the Worker loads these automatically into an empty pool.
-- Run after schema.sql:  psql "$DATABASE_URL" -f db/seed.sql
INSERT INTO questions (question, options, correct_index, difficulty, category, explanation, topic, campaign) VALUES
${rows.join(',\n')};
`;
writeFileSync(new URL('../db/seed.sql', import.meta.url), sql);
console.log(`Wrote db/seed.sql with ${qs.length} questions`);
