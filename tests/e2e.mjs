// End-to-end test: serves the site, drives it in a phone-sized Chromium, shrinks generated clips and checks
// the downloaded files with ffprobe.
//
//   node tests/e2e.mjs            (needs: ffmpeg + ffprobe on PATH, `playwright` with a Chromium browser)
//
// Headless Chromium builds usually can't encode/decode H.264 or AAC, so fixtures are VP8/VP9 + Opus and the
// page falls back to VP9-in-MP4 here. That still exercises the whole pipeline; the H.264 path needs a real phone.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-e2e-'));
const shots = process.env.SHOTS_DIR;
if (shots) fs.mkdirSync(shots, { recursive: true });

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {}
  const globalRoot = process.env.PLAYWRIGHT_NODE_PATH || '/opt/node22/lib/node_modules/';
  return createRequire(globalRoot)('playwright');
}
const pw = await loadPlaywright();
const chromium = pw.chromium || pw.default.chromium;
const devices = pw.devices || pw.default.devices;

// ---------------------------------------------------------------- helpers

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://localhost:${server.address().port}/`;

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`${cmd} failed:\n${r.stderr.slice(-2000)}`);
  return r.stdout;
}
const ffmpeg = (...a) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
function probe(file) {
  return JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
}
function displaySize(stream) {
  const rot = Math.abs(Number((stream.side_data_list || []).find((s) => 'rotation' in s)?.rotation || 0));
  return rot === 90 || rot === 270 ? [stream.height, stream.width] : [stream.width, stream.height];
}
function topLevelBoxes(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const names = [];
  let pos = 0;
  const head = Buffer.alloc(16);
  while (pos < size) {
    fs.readSync(fd, head, 0, 16, pos);
    let len = head.readUInt32BE(0);
    if (len === 1) len = Number(head.readBigUInt64BE(8));
    names.push(head.toString('latin1', 4, 8));
    if (len < 8) break;
    pos += len;
  }
  fs.closeSync(fd);
  return names;
}

const sine = (d) => ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${d}`];
const video = (size, rate, d) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${d}`];
const vp8 = ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8'];

console.log('generating fixtures in', work);
const fx = {
  landscape: path.join(work, 'landscape.webm'),
  portrait: path.join(work, 'portrait.mp4'),
  noaudio: path.join(work, 'noaudio.webm'),
  small: path.join(work, 'small.webm'),
  long: path.join(work, 'long.webm'),
  big: path.join(work, 'big.webm'),
};
ffmpeg(...video('1280x720', 30, 25), ...sine(25), ...vp8, '-b:v', '6M', '-c:a', 'libopus', '-b:a', '128k', fx.landscape);
ffmpeg(...video('1280x720', 30, 30), ...sine(30), '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '6M', '-c:a', 'libopus', '-strict', '-2', path.join(work, 'p0.mp4'));
ffmpeg('-display_rotation', '90', '-i', path.join(work, 'p0.mp4'), '-c', 'copy', fx.portrait);
ffmpeg(...video('1280x720', 30, 20), ...vp8, '-b:v', '6M', '-an', fx.noaudio);
ffmpeg(...video('320x180', 15, 5), ...sine(5), ...vp8, '-b:v', '500k', '-c:a', 'libopus', '-b:a', '32k', fx.small);
ffmpeg(...video('1280x720', 30, 60), ...sine(60), ...vp8, '-b:v', '8M', '-c:a', 'libopus', '-b:a', '128k', fx.big);
ffmpeg(...video('640x360', 15, 720), ...sine(720), ...vp8, '-b:v', '300k', '-c:a', 'libopus', '-ac', '1', '-b:a', '24k', fx.long);
for (const [k, f] of Object.entries(fx)) console.log(`  ${k}: ${(fs.statSync(f).size / 1e6).toFixed(1)} MB`);

// ---------------------------------------------------------------- harness

const browser = await chromium.launch();
const results = [];

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
  if (opts.init) await page.addInitScript(opts.init);
  await page.goto(url);
  return { ctx, page, errors };
}

const visible = (page, screen, timeout = 240000) => page.waitForSelector(`#screen-${screen}:not([hidden])`, { timeout });
const shot = (page, name) => shots && page.screenshot({ path: path.join(shots, name + '.png') });

async function save(page, name) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#saveBtn')]);
  const out = path.join(work, name);
  await dl.saveAs(out);
  return out;
}

async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push([name, true]);
    console.log(`PASS ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    results.push([name, false]);
    console.log(`FAIL ${name}\n${e.stack || e}`);
  }
}

function checkShrunk(file, { limitMB, duration, audio, minSide }) {
  const info = probe(file);
  assert.equal(info.format.format_name.includes('mp4'), true, 'is mp4');
  const size = fs.statSync(file).size;
  assert.ok(size <= limitMB * 1e6, `size ${size} over ${limitMB} MB`);
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  assert.ok(v, 'has video');
  assert.ok(['vp9', 'h264'].includes(v.codec_name), 'video codec ' + v.codec_name);
  if (audio) {
    assert.ok(a, 'has audio');
    assert.equal(a.codec_name, 'aac');
  } else assert.ok(!a, 'no audio expected');
  assert.ok(Math.abs(Number(info.format.duration) - duration) < 1, `duration ${info.format.duration} vs ${duration}`);
  const boxes = topLevelBoxes(file);
  assert.ok(boxes.indexOf('moov') < boxes.indexOf('mdat'), 'faststart: ' + boxes.join(','));
  run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']); // decodes cleanly
  return { info, v, size, display: displaySize(v) };
}

// ---------------------------------------------------------------- tests

await test('landscape clip is shrunk under 10 MB', async () => {
  const { ctx, page, errors } = await newPage();
  await shot(page, '1-idle');
  await page.setInputFiles('#file', fx.landscape);
  await visible(page, 'work');
  await page.waitForTimeout(1500);
  await shot(page, '2-working');
  await visible(page, 'done');
  await shot(page, '3-done');
  const out = await save(page, 'out-landscape.mp4');
  const r = checkShrunk(out, { limitMB: 10, duration: 25, audio: true });
  console.log(`   -> ${(r.size / 1e6).toFixed(2)} MB ${r.v.codec_name} ${r.display.join('x')}`);
  assert.ok(r.display[0] > r.display[1], 'landscape');
  assert.deepEqual(errors, []);
  await ctx.close();
});

await test('portrait (rotated) clip keeps its orientation', async () => {
  const { ctx, page, errors } = await newPage();
  await page.setInputFiles('#file', fx.portrait);
  await visible(page, 'done');
  const out = await save(page, 'out-portrait.mp4');
  const r = checkShrunk(out, { limitMB: 10, duration: 30, audio: true });
  console.log(`   -> ${(r.size / 1e6).toFixed(2)} MB ${r.v.codec_name} ${r.display.join('x')}`);
  assert.ok(r.display[1] > r.display[0], `portrait expected, got ${r.display}`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await test('video without sound stays silent', async () => {
  const { ctx, page, errors } = await newPage();
  await page.setInputFiles('#file', fx.noaudio);
  await visible(page, 'done');
  const out = await save(page, 'out-noaudio.mp4');
  checkShrunk(out, { limitMB: 10, duration: 20, audio: false });
  assert.deepEqual(errors, []);
  await ctx.close();
});

await test('already-small clip is offered as is', async () => {
  const { ctx, page } = await newPage();
  await page.setInputFiles('#file', fx.small);
  await visible(page, 'done');
  assert.match(await page.textContent('#doneTitle'), /Already small enough/);
  const out = await save(page, 'out-small.webm');
  assert.equal(fs.statSync(out).size, fs.statSync(fx.small).size);
  await ctx.close();
});

await test('50 MB limit uses the bigger budget', async () => {
  const { ctx, page } = await newPage();
  await page.selectOption('#limit', '50');
  await page.setInputFiles('#file', fx.big);
  await visible(page, 'done');
  const out = await save(page, 'out-big-50.mp4');
  const r = checkShrunk(out, { limitMB: 50, duration: 60, audio: true });
  console.log(`   -> ${(r.size / 1e6).toFixed(2)} MB`);
  assert.ok(r.size > 10e6, 'uses the bigger budget');
  await ctx.close();
});

await test('trim-first shrinks only the chosen part', async () => {
  const { ctx, page, errors } = await newPage();
  await page.check('#trimFirst');
  await page.setInputFiles('#file', fx.landscape);
  await visible(page, 'trim');
  await shot(page, '4-trim');
  await page.$eval('#trimStart', (el) => { el.value = '5'; el.dispatchEvent(new Event('input')); });
  await page.$eval('#trimEnd', (el) => { el.value = '15'; el.dispatchEvent(new Event('input')); });
  assert.match(await page.textContent('#trimSummary'), /0:10 long/);
  await page.click('#trimGo');
  await visible(page, 'done');
  const out = await save(page, 'out-trim.mp4');
  checkShrunk(out, { limitMB: 10, duration: 10, audio: true });
  assert.deepEqual(errors, []);
  await ctx.close();
});

await test('very long clip asks to trim, then works', async () => {
  const { ctx, page } = await newPage();
  await page.setInputFiles('#file', fx.long);
  await visible(page, 'trim', 60000);
  await shot(page, '5-trim-long');
  assert.match(await page.textContent('#trimInfo'), /blurry/);
  assert.match(await page.textContent('#trimSummary'), /keep it under about/);
  await page.$eval('#trimEnd', (el) => { el.value = '60'; el.dispatchEvent(new Event('input')); });
  await page.click('#trimGo');
  await visible(page, 'done');
  const out = await save(page, 'out-long-trimmed.mp4');
  checkShrunk(out, { limitMB: 10, duration: 60, audio: true });
  await ctx.close();
});

await test('an oversize first pass is redone smaller', async () => {
  // Make the first pass ignore the requested bitrate (x5) so the result overshoots; the second pass asks for
  // a lower bitrate, so it is left alone. (The page's own start-up probe uses exactly 2 Mbps, also left alone.)
  const { ctx, page, errors } = await newPage({
    init: () => {
      const orig = VideoEncoder.prototype.configure;
      let first = null;
      VideoEncoder.prototype.configure = function (cfg) {
        if (cfg.bitrate && cfg.bitrate !== 2e6) {
          first ??= cfg.bitrate;
          if (cfg.bitrate === first) cfg = { ...cfg, bitrate: cfg.bitrate * 5 };
        }
        return orig.call(this, cfg);
      };
    },
  });
  await page.setInputFiles('#file', fx.landscape);
  await page.waitForFunction(() => /Almost there/.test(document.getElementById('workStatus').textContent), null, { timeout: 120000 });
  await visible(page, 'done');
  const out = await save(page, 'out-retry.mp4');
  const r = checkShrunk(out, { limitMB: 10, duration: 25, audio: true });
  console.log(`   -> ${(r.size / 1e6).toFixed(2)} MB`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await test('cancel returns to the start screen', async () => {
  const { ctx, page } = await newPage();
  await page.setInputFiles('#file', fx.landscape);
  await visible(page, 'work');
  await page.waitForTimeout(800);
  await page.click('#cancelBtn');
  await visible(page, 'idle', 20000);
  await ctx.close();
});

await test('non-video file gives a friendly error', async () => {
  const { ctx, page } = await newPage();
  const bad = path.join(work, 'notes.txt');
  fs.writeFileSync(bad, 'hello');
  await page.setInputFiles('#file', bad);
  await visible(page, 'error', 20000);
  await shot(page, '6-error');
  assert.match(await page.textContent('#errTitle'), /couldn't read|No video/i);
  await page.click('#errBack');
  await visible(page, 'idle');
  await ctx.close();
});

await test('browser without WebCodecs sees the unsupported screen', async () => {
  const { ctx, page } = await newPage({ init: () => { delete window.VideoEncoder; } });
  await visible(page, 'unsupported', 20000);
  await shot(page, '7-unsupported');
  assert.match(await page.textContent('#unsupportedMsg'), /Safari|Chrome/);
  await ctx.close();
});

await browser.close();
server.close();
const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
