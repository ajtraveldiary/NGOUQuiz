// Run the whole app locally with an in-memory Postgres (no Neon, no Cloudflare account needed).
// Usage: npm run local   → http://localhost:8787  (admin: /union-control-room, password "admin")
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
await build({
  entryPoints: [root + 'src/index.js'], bundle: true, format: 'esm', platform: 'neutral',
  outfile: root + '.test-build/worker.mjs', loader: { '.html': 'text' }, logLevel: 'error', mainFields: ['module', 'main'],
});
const worker = (await import(root + '.test-build/worker.mjs?' + Date.now())).default;
const pg = new PGlite();
await pg.exec(readFileSync(root + 'db/schema.sql', 'utf8'));
await pg.exec(readFileSync(root + 'db/seed.sql', 'utf8'));
const env = {
  APP_SECRET: 'local-dev-secret-change-me-0123456789', ADMIN_PASSWORD: 'admin', ADMIN_PATH: 'union-control-room',
  __db: { q: async (t, p = []) => (await pg.query(t, p)).rows },
};
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
const port = Number(process.env.PORT) || 8787;

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = normalize(join(root, 'public', rel));
  if (file.startsWith(join(root, 'public')) && existsSync(file) && statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    return res.end(readFileSync(file));
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request(url, {
    method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  }), env, {});
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log(`Quiz running at http://localhost:${port}  (admin: /${env.ADMIN_PATH}, password "admin")`));
