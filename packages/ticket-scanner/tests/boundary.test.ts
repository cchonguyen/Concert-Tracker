import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// The package stays extractable: no host imports, no Node built-ins.
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') ? [p] : [];
  });
}

test('boundary: src imports only from inside the package and uses no Node modules', () => {
  const src = path.join(import.meta.dirname, '..', 'src');
  for (const file of sources(src)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1];
      assert.ok(!spec.startsWith('node:'), `${file} imports ${spec}`);
      assert.ok(!/^(fs|net|crypto|stream|buffer|path|os)$/.test(spec), `${file} imports ${spec}`);
      if (spec.startsWith('.')) {
        const target = path.resolve(path.dirname(file), spec);
        assert.ok(target.startsWith(src), `${file} reaches outside src: ${spec}`);
      } else {
        assert.fail(`${file} imports a package: ${spec}`);
      }
    }
    assert.ok(!/\b(gemini|supabase|genai)\b/i.test(text.replace(/\/\/.*$/gm, '')), `${file} mentions a host service`);
  }
});
