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
import { encodeHook } from '../discord.mjs';

const Caption = createRequire(import.meta.url)('../caption.js');
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
  mid: path.join(work, 'mid.webm'),
};
ffmpeg(...video('1280x720', 30, 25), ...sine(25), ...vp8, '-b:v', '6M', '-c:a', 'libopus', '-b:a', '128k', fx.landscape);
ffmpeg(...video('1280x720', 30, 30), ...sine(30), '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '6M', '-c:a', 'libopus', '-strict', '-2', '-metadata', 'title=SECRETTITLE', '-metadata', 'location=+51.5074-0.1278/', path.join(work, 'p0.mp4'));
ffmpeg('-display_rotation', '90', '-i', path.join(work, 'p0.mp4'), '-c', 'copy', fx.portrait);
ffmpeg(...video('1280x720', 30, 20), ...vp8, '-b:v', '6M', '-an', fx.noaudio);
ffmpeg(...video('320x180', 15, 5), ...sine(5), ...vp8, '-b:v', '500k', '-c:a', 'libopus', '-b:a', '32k', fx.small);
ffmpeg(...video('1280x720', 30, 60), ...sine(60), ...vp8, '-b:v', '8M', '-c:a', 'libopus', '-b:a', '128k', fx.big);
ffmpeg(...video('960x540', 30, 100), ...sine(100), ...vp8, '-b:v', '1500k', '-c:a', 'libopus', '-b:a', '128k', fx.mid);
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
  // Remember every heading the work screen showed ("Checking your video…", "Shrinking your video…").
  await page.addInitScript(() => {
    window.__titles = [];
    document.addEventListener('DOMContentLoaded', () => {
      const t = document.getElementById('workTitle');
      if (t) new MutationObserver(() => window.__titles.push(t.textContent)).observe(t, { childList: true, characterData: true, subtree: true });
    });
  });
  if (opts.init) await page.addInitScript(opts.init);
  await page.goto(url + (opts.path || '') + (opts.hash || ''));
  if (!opts.unsupported && !opts.path) await page.selectOption('#limit', '10'); // most tests are written for the 10 MB budget
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

async function saveAll(page, count, prefix) {
  const files = [];
  const pending = [];
  page.on('download', (dl) => pending.push(dl));
  await page.click('#saveBtn');
  const t0 = Date.now();
  while (pending.length < count && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 200));
  assert.equal(pending.length, count, `expected ${count} downloads`);
  for (const [i, dl] of pending.entries()) {
    const out = path.join(work, `${prefix}-${i}.mp4`);
    await dl.saveAs(out);
    files.push({ out, name: dl.suggestedFilename() });
  }
  return files;
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
  // privacy: the source carries a title and a GPS location; neither may reach the shared file
  assert.ok(fs.readFileSync(fx.portrait).includes('SECRETTITLE'), 'fixture has the tag');
  const bytes = fs.readFileSync(out);
  assert.ok(!bytes.includes('SECRETTITLE'), 'title copied');
  assert.ok(!bytes.includes('51.5074'), 'location copied');
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
  assert.match(await page.textContent('#trimInfo'), /soft/);
  assert.equal(await page.isVisible('#trimSplit'), true, 'split offered');
  await page.$eval('#trimEnd', (el) => { el.value = '60'; el.dispatchEvent(new Event('input')); });
  await page.click('#trimGo');
  await visible(page, 'done');
  const out = await save(page, 'out-long-trimmed.mp4');
  checkShrunk(out, { limitMB: 10, duration: 60, audio: true });
  await ctx.close();
});

await test('an oversize first pass is redone smaller', async () => {
  // Make the first full pass (status "Making it …p") ignore the requested bitrate (x5) so it overshoots; the
  // sample pass and the redo are left alone. (The page's start-up probe uses exactly 2 Mbps, also left alone.)
  const { ctx, page, errors } = await newPage({
    init: () => {
      const orig = VideoEncoder.prototype.configure;
      VideoEncoder.prototype.configure = function (cfg) {
        const status = (document.getElementById('workStatus') || {}).textContent || '';
        if (cfg.bitrate && cfg.bitrate !== 2e6 && /^Making it/.test(status)) cfg = { ...cfg, bitrate: cfg.bitrate * 5 };
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
  const { ctx, page } = await newPage({ unsupported: true, init: () => { delete window.VideoEncoder; } });
  await visible(page, 'unsupported', 20000);
  await shot(page, '7-unsupported');
  assert.match(await page.textContent('#unsupportedMsg'), /Safari|Chrome/);
  await ctx.close();
});

// ---- new in 1.1: sample pass, split, batch, thread posting, offline, diagnostics --------------------------

const HOOK = { url: 'https://discord.com/api/webhooks/123456789012345678/abc_DEF-ghi123', threadId: '1477264432139731097' };
const hookFragment = '#hook=' + encodeHook(HOOK);

/** Pretend to be Discord: records every webhook post and answers with `status`. */
async function mockDiscord(ctx, status = 200) {
  const posts = [];
  await ctx.route('https://discord.com/api/webhooks/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    if (status === 'abort') return route.abort();
    const form = await new Response(req.postDataBuffer(), { headers: { 'content-type': req.headers()['content-type'] } }).formData();
    posts.push({ url: req.url(), payload: JSON.parse(form.get('payload_json')), file: form.get('files[0]') });
    await route.fulfill({ status, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: status === 200 ? '{"id":"1"}' : '{}' });
  });
  return posts;
}

await test('a short test pass runs first, and normal clips need only one full pass', async () => {
  const { ctx, page, errors } = await newPage();
  await page.setInputFiles('#file', fx.landscape);
  await visible(page, 'done');
  const titles = await page.evaluate(() => window.__titles);
  assert.ok(titles.includes('Checking your video…'), 'sample pass ran: ' + titles);
  assert.ok(!(await page.evaluate(() => /Almost there/.test(document.body.textContent))), 'no redo needed');
  const shown = await page.textContent('#capPreview');
  assert.ok(shown.includes('⏱ 0:25'), shown);
  assert.ok(shown.includes(Caption.formatDate(Caption.toISODate(Date.now()))), 'date comes from the file: ' + shown);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await test('a long clip can be split into sharp parts', async () => {
  const { ctx, page, errors } = await newPage();
  await page.setInputFiles('#file', fx.mid);
  await visible(page, 'trim', 60000);
  assert.match(await page.textContent('#trimSplit'), /Split into 2 parts/);
  await page.click('#trimSplit');
  await visible(page, 'done');
  assert.equal(await page.locator('#results .item').count(), 2);
  const files = await saveAll(page, 2, 'out-split');
  files.sort((a, b) => a.name.localeCompare(b.name));
  assert.match(files[0].name, /part1of2/);
  assert.match(files[1].name, /part2of2/);
  let total = 0;
  for (const f of files) {
    const r = checkShrunk(f.out, { limitMB: 10, duration: 50, audio: true });
    total += Number(r.info.format.duration);
    console.log(`   -> ${f.name} ${(r.size / 1e6).toFixed(2)} MB ${r.display.join('x')}`);
  }
  assert.ok(Math.abs(total - 100) < 1.5, `parts add up to ${total}`);
  assert.match(await page.textContent('#capPreview'), /part 1\/2/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await test('several videos in a row', async () => {
  const { ctx, page, errors } = await newPage();
  await page.setInputFiles('#file', [fx.landscape, fx.noaudio]);
  await page.waitForFunction(() => /Video 2 of 2/.test(document.getElementById('workQueue').textContent), null, { timeout: 120000 });
  await visible(page, 'done');
  assert.equal(await page.locator('#results .item').count(), 2);
  const files = await saveAll(page, 2, 'out-batch');
  checkShrunk(files.find((f) => /landscape/.test(f.name)).out, { limitMB: 10, duration: 25, audio: true });
  checkShrunk(files.find((f) => /noaudio/.test(f.name)).out, { limitMB: 10, duration: 20, audio: false });
  assert.deepEqual(errors, []);
  await ctx.close();
});

await test('posting to the thread sends the file and a safe caption', async () => {
  const { ctx, page, errors } = await newPage({ hash: hookFragment });
  const posts = await mockDiscord(ctx);
  assert.equal(new URL(page.url()).hash, '', 'secret removed from the address bar');
  assert.equal(await page.isVisible('#hookStatus'), false, 'not connected before the user agrees');
  assert.match(await page.textContent('#hookPromptText'), /ends …1097/);
  await page.click('#hookConnect');
  assert.equal(await page.isVisible('#hookStatus'), true);
  await page.setInputFiles('#file', fx.landscape);
  await visible(page, 'done');
  assert.equal(await page.isVisible('#postBtn'), true);
  assert.equal(await page.evaluate(() => document.getElementById('capEdit').open), true, 'editor opens the first time');
  await shot(page, '9-done-with-thread');
  await page.fill('#capEvent', 'Dua *Lipa* @everyone');
  await page.fill('#capVenue', 'O2 Arena');

  await page.click('#postBtn'); // no name yet
  assert.match(await page.textContent('#postStatus'), /name/i);
  assert.equal(posts.length, 0);

  await page.fill('#posterName', 'Sam');
  await page.click('#postBtn');
  await page.waitForFunction(() => /Posted/.test(document.getElementById('postStatus').textContent), null, { timeout: 30000 });
  assert.equal(posts.length, 1);
  const [post] = posts;
  assert.match(post.url, /thread_id=1477264432139731097&wait=true$/);
  assert.equal(post.payload.username, 'Sam');
  assert.deepEqual(post.payload.allowed_mentions, { parse: [] });
  assert.match(post.payload.content, /^🎤 \*\*Dua \\\*Lipa\\\* @​everyone\*\* · O2 Arena\n📅 .* · ⏱ 0:25$/);
  assert.ok(post.file.size > 100_000 && post.file.size <= 10e6, 'file size ' + post.file.size);
  assert.equal(post.file.name, 'landscape-discord.mp4');

  // reload: the thread link is remembered, the name too
  await page.reload();
  assert.equal(await page.isVisible('#hookStatus'), true);
  await page.click('#hookForget');
  assert.equal(await page.isVisible('#hookStatus'), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await test('a switched-off link says so and lets you retry; share/save stay available', async () => {
  const { ctx, page } = await newPage({ hash: hookFragment });
  await page.click('#hookConnect');
  await mockDiscord(ctx, 404);
  await page.setInputFiles('#file', fx.landscape);
  await visible(page, 'done');
  await page.fill('#posterName', 'Sam');
  await page.click('#postBtn');
  await page.waitForFunction(() => /switched off/.test(document.getElementById('postStatus').textContent), null, { timeout: 30000 });
  assert.equal(await page.textContent('#postBtn'), 'Try again');
  assert.equal(await page.isVisible('#saveBtn'), true);
  await ctx.close();
});

await test('an unreadable answer warns about double posting', async () => {
  const { ctx, page } = await newPage({ hash: hookFragment });
  await page.click('#hookConnect');
  await mockDiscord(ctx, 'abort');
  await page.setInputFiles('#file', fx.landscape);
  await visible(page, 'done');
  await page.fill('#posterName', 'Sam');
  await page.click('#postBtn');
  await page.waitForFunction(() => /twice/.test(document.getElementById('postStatus').textContent), null, { timeout: 30000 });
  await ctx.close();
});

await test('a thread link only connects after the user agrees, and never replaces silently', async () => {
  const { ctx, page } = await newPage({ hash: hookFragment });
  await page.click('#hookIgnore');
  assert.equal(await page.isVisible('#hookStatus'), false);
  assert.equal(await page.isVisible('#hookPrompt'), false);
  await page.reload();
  assert.equal(await page.isVisible('#hookStatus'), false, 'ignored link was not kept');
  const other = { url: 'https://discord.com/api/webhooks/999999999999999999/evil_token', threadId: '5550000000000009999' };
  await page.goto('about:blank');
  await page.goto(url + hookFragment);
  await page.click('#hookConnect');
  await page.goto('about:blank');
  await page.goto(url + '#hook=' + encodeHook(other));
  assert.match(await page.textContent('#hookPromptText'), /ends …9999.*replace/);
  assert.match(await page.textContent('#hookThread'), /…1097/, 'still the old thread until the user agrees');
  await page.goto('about:blank');
  await page.goto(url + hookFragment); // the same link again: nothing to ask
  assert.equal(await page.isVisible('#hookPrompt'), false);
  await page.goto('about:blank');
  await page.goto(url + '#hook=not-a-real-link');
  assert.equal(await page.isVisible('#hookPrompt'), false);
  await ctx.close();
});

await test('setup page makes a working link and sends a test message', async () => {
  const { ctx, page, errors } = await newPage({ path: 'setup.html' });
  const posts = await mockDiscord(ctx);
  await page.fill('#url', HOOK.url);
  await page.fill('#thread', 'https://discord.com/channels/1439938864310390901/' + HOOK.threadId);
  await page.click('#make');
  const link = await page.inputValue('#link');
  assert.equal(link, url + '#hook=' + encodeHook(HOOK));
  assert.equal(await page.textContent('#label'), '…1097');
  await page.click('#test');
  await page.waitForFunction(() => /Sent!/.test(document.getElementById('testStatus').textContent), null, { timeout: 15000 });
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /thread_id=1477264432139731097/);
  // bad input is explained
  await page.fill('#url', 'https://example.com/nope');
  await page.click('#make');
  assert.match(await page.textContent('#problem'), /webhook URL/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await test('works offline after the first visit', async () => {
  const { ctx, page, errors } = await newPage();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => (await caches.keys()).length > 0 && (await (await caches.open((await caches.keys())[0])).keys()).length >= 10, null, { timeout: 15000 });
  await ctx.setOffline(true);
  await page.reload();
  await visible(page, 'idle', 15000);
  await page.selectOption('#limit', '10');
  await page.setInputFiles('#file', fx.landscape); // needs the bundled AAC encoder, which must be cached too
  await visible(page, 'done');
  const out = await save(page, 'out-offline.mp4');
  checkShrunk(out, { limitMB: 10, duration: 25, audio: true });
  assert.deepEqual(errors.filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(e)), []);
  await ctx.close();
});

await test('phone check page reports support and runs a real encode', async () => {
  const { ctx, page, errors } = await newPage({ path: 'diag.html' });
  await page.click('#run');
  await page.waitForFunction(() => /\nDone\./.test(document.getElementById('report').textContent), null, { timeout: 60000 });
  const report = await page.textContent('#report');
  for (const needle of ['Browser:', 'VideoEncoder present: yes', 'AAC encode', 'Bundled AAC encoder loads: yes', 'Share files:', 'frames of 720p']) assert.ok(report.includes(needle), `missing "${needle}" in\n${report}`);
  await shot(page, '8-diag');
  await page.setInputFiles('#file', fx.landscape);
  await page.waitForFunction(() => /Metadata:/.test(document.getElementById('report').textContent), null, { timeout: 30000 });
  const full = await page.textContent('#report');
  assert.match(full, /Audio: opus, 1 ch/); // the fixture tone is mono
  assert.match(full, /Color: HDR NO/);
  assert.deepEqual(errors, []);
  await ctx.close();
});


await browser.close();
server.close();
const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
