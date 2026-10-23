import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const B = createRequire(import.meta.url)('../budget.js');

const phone1080 = { width: 1920, height: 1080, fps: 30 };

test('targets stay under the limit', () => {
  assert.equal(B.targetBytes(10), 9_300_000);
  assert.ok(B.acceptBytes(10) < 10_000_000);
  assert.ok(B.fitsAlready(9_500_000, 10));
  assert.ok(!B.fitsAlready(9_900_000, 10));
});

test('short clip keeps 1080p', () => {
  const p = B.plan({ duration: 12, limitMB: 10, ...phone1080, audio: null });
  assert.equal(p.height, 1080);
  assert.equal(p.quality === 'great' || p.quality === 'good', true);
});

test('one minute at 10 MB drops to a mid resolution, stays good', () => {
  const p = B.plan({ duration: 60, limitMB: 10, ...phone1080, audio: { codec: 'aac', bitrate: 192000, channels: 2 } });
  assert.ok(p.height <= 540 && p.height >= 360, `height ${p.height}`);
  assert.notEqual(p.quality, 'low');
  assert.equal(p.audio.copy, false);
  assert.equal(p.audio.bitrate, 96000);
  const longer = B.plan({ duration: 120, limitMB: 10, ...phone1080, audio: { codec: 'aac', bitrate: 192000, channels: 2 } });
  assert.equal(longer.audio.bitrate, 64000);
});

test('budget adds up to under the target', () => {
  for (const duration of [5, 30, 60, 120, 300]) {
    const p = B.plan({ duration, limitMB: 10, ...phone1080, audio: { codec: 'aac', bitrate: 96000, channels: 2 } });
    const bits = (p.videoBitrate + (p.audio ? p.audio.bitrate : 0)) * duration;
    assert.ok(bits / 8 <= p.targetBytes, `${duration}s: ${bits / 8} > ${p.targetBytes}`);
  }
});

test('portrait video is tiered by its short side and keeps its shape', () => {
  const p = B.plan({ duration: 30, limitMB: 10, width: 1080, height: 1920, fps: 30, audio: null });
  assert.ok(p.height > p.width);
  assert.equal(p.width % 2, 0);
  assert.equal(p.height % 2, 0);
  assert.ok(Math.abs(p.height / p.width - 1920 / 1080) < 0.02);
});

test('never upscales', () => {
  const p = B.plan({ duration: 5, limitMB: 100, width: 640, height: 360, fps: 24, audio: null });
  assert.equal(p.width, 640);
  assert.equal(p.height, 360);
});

test('60 fps sources are capped to 30', () => {
  const p = B.plan({ duration: 20, limitMB: 10, width: 1920, height: 1080, fps: 60, audio: null });
  assert.equal(p.fps, 30);
  assert.equal(p.frameRate, 30);
});

test('frameRate is left alone when the source is already fine', () => {
  const p = B.plan({ duration: 20, limitMB: 10, width: 1280, height: 720, fps: 29.97, audio: null });
  assert.equal(p.frameRate, undefined);
});

test('very long clips fall back to 15 fps and are flagged low', () => {
  const p = B.plan({ duration: 900, limitMB: 10, ...phone1080, audio: { codec: 'aac', bitrate: 128000, channels: 2 } });
  assert.equal(p.fps, 15);
  assert.equal(p.quality, 'low');
  assert.equal(p.audio.channels, 1);
});

test('small AAC audio is copied, not re-encoded', () => {
  const a = B.planAudio(2e6, { codec: 'aac', bitrate: 96000, channels: 2 });
  assert.equal(a.copy, true);
  const b = B.planAudio(2e6, { codec: 'opus', bitrate: 64000, channels: 2 });
  assert.equal(b.copy, false);
  assert.equal(B.planAudio(2e6, null), null);
});

test('retry shrinks the bitrate in proportion to the overshoot', () => {
  const next = B.retryVideoBitrate(1_000_000, 9_300_000, 11_000_000);
  assert.ok(next < 1_000_000 * (9.3 / 11) && next > 500_000);
  assert.ok(B.retryVideoBitrate(1_000_000, 9_300_000, 9_400_000) < 1_000_000);
});

test('maxGoodSeconds is a few minutes at 10 MB and grows with the limit', () => {
  const t = B.maxGoodSeconds(10);
  assert.ok(t > 120 && t < 600, String(t));
  assert.ok(B.maxGoodSeconds(50) > t * 4);
});

test('formatters', () => {
  assert.equal(B.formatBytes(9_300_000), '9.3 MB');
  assert.equal(B.formatBytes(148_000_000), '148 MB');
  assert.equal(B.formatBytes(1_500_000_000), '1.50 GB');
  assert.equal(B.formatDuration(75), '1:15');
  assert.equal(B.formatDuration(3725), '1:02:05');
});
