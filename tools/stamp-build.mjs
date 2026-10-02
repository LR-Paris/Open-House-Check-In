// Recompute BUILD in sw.js from the cached files. Run after any change: npm run stamp
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function computeBuild(root = ROOT) {
  const sw = readFileSync(join(root, 'sw.js'), 'utf8');
  const files = [...sw.matchAll(/'\.\/([^']+)'/g)].map(m => m[1]).sort();
  const h = createHash('sha256');
  for (const f of files) h.update(f).update('\0').update(readFileSync(join(root, f))).update('\0');
  // the service worker's own code too (minus the BUILD value itself), so a change to it gets a new cache name
  h.update('sw.js\0').update(sw.replace(/const BUILD = '[0-9a-f]*';/, "const BUILD = '';"));
  return h.digest('hex').slice(0, 13);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = join(ROOT, 'sw.js');
  const sw = readFileSync(path, 'utf8');
  const build = computeBuild();
  const next = sw.replace(/const BUILD = '[0-9a-f]+';/, `const BUILD = '${build}';`);
  if (next === sw) console.log(`BUILD already ${build}`);
  else { writeFileSync(path, next); console.log(`BUILD set to ${build}`); }
}
