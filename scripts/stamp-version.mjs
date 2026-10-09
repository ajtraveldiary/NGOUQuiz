// Writes the version from package.json into public/index.html (asset links + app-version meta).
// Run after every version bump:  node scripts/stamp-version.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const v = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const p = new URL('../public/index.html', import.meta.url);
const html = readFileSync(p, 'utf8')
  .replace(/(<meta name="app-version" content=")[^"]*(")/, `$1${v}$2`)
  .replace(/(\/style\.css\?v=)[^"]*/, `$1${v}`)
  .replace(/(\/app\.js\?v=)[^"]*/, `$1${v}`);
writeFileSync(p, html);
console.log('index.html stamped with', v);
