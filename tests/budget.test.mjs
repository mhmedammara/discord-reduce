import test from 'node:test';
import assert from 'node:assert/strict';
import { planBudget, fitDimensions, retryVideoBps, limitBytes, SAFETY } from '../budget.js';

const base = { limitMb: 10, width: 1920, height: 1080, fps: 30, hasAudio: true };

test('normal case: 30 s 1080p into 10 MB stays under the limit', () => {
  const p = planBudget({ ...base, duration: 30 });
  assert.equal(p.ok, true);
  assert.equal(p.audioBps, 128000);
  assert.equal(p.targetBytes, Math.floor(limitBytes(10) * SAFETY));
  const bytes = ((p.videoBps + p.audioBps) * 30) / 8;
  assert.ok(bytes <= limitBytes(10) * SAFETY + 1);
  assert.ok(p.width <= 1920 && p.height <= 1080);
});

test('very long video is flagged with the longest workable duration', () => {
  const p = planBudget({ ...base, duration: 3600 });
  assert.equal(p.ok, false);
  assert.ok(p.maxDuration > 0 && p.maxDuration < 3600);
  // trimming to exactly that duration must then work
  assert.equal(planBudget({ ...base, duration: p.maxDuration }).ok, true);
});

test('very short video keeps full resolution and never upscales', () => {
  const p = planBudget({ ...base, duration: 3, width: 1280, height: 720 });
  assert.equal(p.ok, true);
  assert.equal(p.width, 1280);
  assert.equal(p.height, 720);
  assert.equal(p.fps, 30);
});

test('tiny limit forces a smaller picture than a large limit', () => {
  const small = planBudget({ ...base, duration: 60, limitMb: 10 });
  const large = planBudget({ ...base, duration: 60, limitMb: 50 });
  assert.ok(small.ok && large.ok);
  assert.ok(small.width * small.height < large.width * large.height);
});

test('audio bitrate drops only when needed', () => {
  const easy = planBudget({ ...base, duration: 20 });
  assert.equal(easy.audioBps, 128000);
  // find a duration where 128k audio fails but a lower step succeeds
  let found = null;
  for (let d = 20; d < 2000 && !found; d += 1) {
    const p = planBudget({ ...base, duration: d });
    if (p.ok && p.audioBps < 128000) found = p;
  }
  assert.ok(found, 'expected a duration that triggers the audio fallback');
});

test('no audio track means no audio bitrate reserved', () => {
  const p = planBudget({ ...base, duration: 30, hasAudio: false });
  assert.equal(p.audioBps, 0);
});

test('odd dimensions are rounded to even numbers', () => {
  const d = fitDimensions(1001, 563, 360);
  assert.equal(d.width % 2, 0);
  assert.equal(d.height % 2, 0);
  const p = planBudget({ ...base, duration: 10, width: 999, height: 501 });
  assert.equal(p.width % 2, 0);
  assert.equal(p.height % 2, 0);
});

test('portrait and landscape both scale by the short side', () => {
  const land = fitDimensions(1920, 1080, 720);
  const port = fitDimensions(1080, 1920, 720);
  assert.deepEqual(land, { width: 1280, height: 720 });
  assert.deepEqual(port, { width: 720, height: 1280 });
  const p = planBudget({ ...base, duration: 40, width: 1080, height: 1920 });
  assert.ok(p.height > p.width);
});

test('frame rate is capped at 30 and never raised above the source', () => {
  assert.equal(planBudget({ ...base, duration: 10, fps: 60 }).fps, 30);
  assert.equal(planBudget({ ...base, duration: 10, fps: 15 }).fps, 15);
});

test('retry lowers bitrate in proportion to the overshoot', () => {
  const next = retryVideoBps(1_000_000, limitBytes(10) * 1.2, 10);
  assert.ok(next < 1_000_000 * 0.8);
  assert.ok(retryVideoBps(1_000_000, 1, 10) < 1_000_000);
});
