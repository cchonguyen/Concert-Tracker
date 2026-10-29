// Fails the build if the sample data is loaded with the app's start-up code.
// It follows the app's entry page (dist/app.html) through the JavaScript it
// loads at start-up, by static import only, and checks none of those files
// contain the sample marker. The sample loads only through a dynamic import in
// sample mode, so it must exist in some other chunk. See ARCHITECTURE.md, Public pages.
import { readdirSync, readFileSync } from 'node:fs';
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
    // Static imports only: "import(" (dynamic, sample mode) is not followed.
      for (const m of body.matchAll(/(?:\bfrom|\bimport)\s*"\.\/([^"]+)"/g)) queue.push(`assets/${m[1]}`);
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
const dynamicChunks = readdirSync(path.join(dist, 'assets')).filter((f) => f.endsWith('.js'));
if (!dynamicChunks.some((file) => readFileSync(path.join(dist, 'assets', file), 'utf8').includes(MARKER))) {
  failures.push('no chunk contains the sample data; the check cannot be trusted');
}

if (failures.length) {
  console.error(`Demo isolation check failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('Demo isolation check passed: the sample data is not loaded at start-up.');
