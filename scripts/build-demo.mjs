// Builds a single-file playable demo (no server) at dist/demo.html
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const html = r('public/index.html');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script src="/app.js'));
const qs = JSON.parse(r('db/seed-questions.json'));
const out = `<title>Arivu Quiz</title>
<meta name="theme-color" content="#2B0710">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anek+Malayalam:wght@400;500;600;700;800&family=Big+Shoulders+Display:wght@800;900&display=swap" rel="stylesheet">
<style>
${r('public/style.css')}
:root { color-scheme: dark; }
html { background: var(--night); }
.demo-note { position: fixed; left: 0; right: 0; bottom: 0; z-index: 35; text-align: center; font-size: 12px; padding: 4px 12px calc(4px + env(safe-area-inset-bottom, 0px)); background: rgba(43, 7, 16, .9); color: var(--mist-2); }
.screen { padding-bottom: calc(44px + var(--safe-b)); }
</style>
${body.replace('<link rel="icon" href="/favicon.svg" type="image/svg+xml">', '')
  .replace('src="/logo.png"', `src="data:image/png;base64,${readFileSync(new URL('../public/logo.png', import.meta.url)).toString('base64')}"`)
  .replace('src="/arivu-title.webp"', `src="data:image/webp;base64,${readFileSync(new URL('../public/arivu-title.webp', import.meta.url)).toString('base64')}"`)}
<p class="demo-note">Demo with sample leaderboard players. Your scores stay on this device.</p>
<script>const QUESTIONS = ${JSON.stringify(qs)}; const APP_VERSION = ${JSON.stringify(JSON.parse(r('package.json')).version)};</script>
<script>
${r('scripts/demo-api.js')}
</script>
<script>
${r('public/app.js')}
</script>
`;
mkdirSync(new URL('../dist', import.meta.url), { recursive: true });
writeFileSync(new URL('../dist/demo.html', import.meta.url), out);
console.log('Wrote dist/demo.html', (out.length / 1024).toFixed(0) + ' KB');
