import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p));

test('file input has no multiple attribute and handlers take one file', () => {
  const html = read('index.html').toString();
  const inputs = html.match(/<input[^>]*type="file"[^>]*>/gi) ?? [];
  assert.equal(inputs.length, 1);
  assert.doesNotMatch(inputs[0], /multiple/i);
  assert.doesNotMatch(read('app.js').toString(), /multiple|\.files\[[1-9]/);
});

test('vendored files match vendor/SHA256SUMS', () => {
  const lines = read('vendor/SHA256SUMS').toString().trim().split(/\r?\n/);
  assert.ok(lines.length >= 2);
  for (const line of lines) {
    const [hash, name] = line.split(/\s+\*?/);
    const actual = createHash('sha256').update(read(join('vendor', name))).digest('hex');
    assert.equal(actual, hash, name);
  }
});
