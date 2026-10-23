import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const C = createRequire(import.meta.url)('../caption.js');

test('builds a full caption', () => {
  const text = C.build({ event: 'Dua Lipa', venue: 'O2 Arena', dateISO: '2026-10-12', durationText: '0:45', part: { index: 1, count: 3 }, note: 'front row' });
  assert.equal(text, '🎤 **Dua Lipa** · O2 Arena\n📅 Oct 12, 2026 · ⏱ 0:45 · part 1/3\nfront row');
});

test('works with nothing filled in', () => {
  assert.equal(C.build({}), '🎬 New clip');
  assert.equal(C.build({ durationText: '1:00' }), '🎬 New clip\n⏱ 1:00');
  assert.equal(C.build({ venue: 'Club' }), '🎬 Club');
});

test('single-part clips do not say part 1/1', () => {
  assert.ok(!C.build({ part: { index: 1, count: 1 } }).includes('part'));
});

test('user text cannot become formatting or mentions', () => {
  const text = C.build({ event: '**bold** _it_ ~~x~~ `c` ||s|| > q', venue: '@everyone <@123> <#456>', note: '@here [link](http://x)' });
  assert.ok(!/(?<!\\)\*\*bold/.test(text));
  assert.ok(!text.includes('@everyone'));
  assert.ok(!text.includes('@here'));
  assert.ok(text.includes('\\<@\u200b123\\>'));
  assert.ok(text.includes('\\[link\\]'));
});

test('line breaks collapse and length is bounded', () => {
  assert.equal(C.clean('a\n\nb\tc'), 'a b c');
  assert.ok(C.build({ event: 'x'.repeat(5000), note: 'y'.repeat(5000) }).length <= C.MAX_LEN);
});

test('dates', () => {
  assert.equal(C.formatDate('2026-02-30'), '');
  assert.equal(C.formatDate('nope'), '');
  assert.equal(C.formatDate('2026-01-05'), 'Jan 5, 2026');
  const now = Date.UTC(2026, 9, 23);
  assert.equal(C.toISODate(new Date(2020, 5, 15, 12), now), '2020-06-15');
  assert.equal(C.toISODate(new Date(1970, 0, 1), now), '');
  assert.equal(C.toISODate(now + 10 * 864e5, now), '');
  assert.equal(C.recordedDate(undefined, new Date(2026, 9, 12, 20).getTime(), now), '2026-10-12');
  assert.equal(C.recordedDate(new Date(2026, 9, 11, 12), new Date(2026, 9, 12, 12).getTime(), now), '2026-10-11');
});
