// Fails the build if the demo's sample data is in the app's files. It follows
// the app's entry page (dist/app.html) through every JavaScript file it loads,
// directly or by import, and checks none of them contains the sample marker.
// It also checks the demo's own files do contain it, so a renamed marker cannot
// pass by accident. See ARCHITECTURE.md, Public pages.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const MARKER = 'Harbor Sound Festival';
const dist = path.resolve(import.meta.dirname, '..', 'dist');

function closure(htmlFile) {
  const html = readFileSync(path.join(dist, htmlFile), 'utf8');
  const seen = new Set();
  const queue = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const body = readFileSync(path.join(dist, file), 'utf8');
    for (const m of body.matchAll(/(?:from|import)\s*\(?\s*"\.\/([^"]+)"/g)) queue.push(`assets/${m[1]}`);
  }
  return [...seen];
}

const failures = [];
for (const file of closure('app.html')) {
  if (readFileSync(path.join(dist, file), 'utf8').includes(MARKER)) failures.push(`app file ${file} contains sample data`);
}
for (const file of closure('index.html')) {
  if (readFileSync(path.join(dist, file), 'utf8').includes(MARKER)) failures.push(`marketing file ${file} contains sample data`);
}
if (!closure('demo.html').some((file) => readFileSync(path.join(dist, file), 'utf8').includes(MARKER))) {
  failures.push('the demo does not contain its sample data; the check cannot be trusted');
}

if (failures.length) {
  console.error(`Demo isolation check failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('Demo isolation check passed: sample data is only in the demo.');
