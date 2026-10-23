import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The vendored libraries must stay byte-for-byte what was released on npm (see vendor/README.md).
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor');

test('vendored files match vendor/SHA256SUMS', () => {
  const lines = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.ok(lines.length >= 2);
  for (const line of lines) {
    const [sum, name] = line.split(/\s+/);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex');
    assert.equal(actual, sum, `${name} changed`);
  }
});

test('nothing in the pages loads code from another site', () => {
  const root = path.join(dir, '..');
  for (const file of ['index.html', 'setup.html', 'diag.html', 'app.js', 'discord.mjs', 'sw.js']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(!/<script[^>]+src=["']https?:/i.test(text), `${file}: remote script tag`);
    assert.ok(!/import\s*\(?\s*['"]https?:/.test(text), `${file}: remote import`);
    assert.ok(!/<link[^>]+href=["']https?:/i.test(text), `${file}: remote stylesheet`);
  }
});
