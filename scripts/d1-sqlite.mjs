// A stand-in for Cloudflare D1 on Node's built-in SQLite (Node 22.5+), for the tests and the local server.
// Covers what the Worker uses: prepare().bind().all() / .run() / .first(), and batch() as one transaction.
import { DatabaseSync } from 'node:sqlite';

export function d1(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON'); // as on D1
  const run = ({ sql, args }) => ({ results: db.prepare(sql).all(...args), success: true });
  const statement = (sql, args = []) => ({
    sql, args,
    bind: (...a) => statement(sql, a),
    all: async () => run({ sql, args }),
    run: async () => run({ sql, args }),
    first: async () => run({ sql, args }).results[0] ?? null,
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (list) => {
      db.exec('BEGIN');
      try {
        const out = list.map(run);
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    exec: async (sql) => { db.exec(sql); },
    // for tests: run SQL directly and get the rows
    rows: (sql, ...args) => db.prepare(sql).all(...args),
  };
}
