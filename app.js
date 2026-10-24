// discord-reduce: shrink videos on-device so they fit Discord's upload limit, then post or share them.
// Decode -> resize -> hardware encode -> MP4, all in the browser via WebCodecs (mediabunny).
import * as MB from 'mediabunny';
import { loadHook, saveHook, forgetHook, captureHookFromLocation, describeHook, sameHook, postToThread, PostError, POST_MESSAGES } from './discord.mjs';

// Must match version.js; bumped together on every release.
const APP_VERSION = '1.1.23';
const B = window.DRBudget;
const { Input, ALL_FORMATS, BlobSource, BufferSource, Output, BufferTarget, Mp4OutputFormat, Conversion, ConversionCanceledError, Quality } = MB;

// H.264 plays everywhere in Discord. VP9 is only a fallback for browsers that cannot encode H.264.
const VIDEO_CODECS = ['avc', 'vp9'];
const MAX_ATTEMPTS = 3;
const PROBE_SECONDS = 4; // length of the sample used to check how the encoder behaves
const PROBE_MIN_CLIP = 12; // shorter clips are just encoded, which is quick enough
const SOFT_BELOW = 480; // asking about trim/split when the picture would drop below this height

const $ = (id) => document.getElementById(id);
const el = Object.fromEntries(
  [
    'file', 'limit', 'pickHint', 'trimFirst', 'hookStatus', 'hookThread', 'hookForget', 'hookPrompt', 'hookPromptText', 'hookConnect', 'hookIgnore', 'inAppBanner', 'postTo',
    'trimQueue', 'trimVideo', 'trimInfo', 'trimStart', 'trimEnd', 'trimStartLabel', 'trimEndLabel', 'trimSummary',
    'trimGo', 'trimSplit', 'trimBack',
    'workTitle', 'workQueue', 'workStatus', 'bar', 'pct', 'eta', 'cancelBtn',
    'doneTitle', 'doneSizes', 'results', 'doneNote', 'repickBtn',
    'nameField', 'posterName', 'postBtn', 'postStatus', 'shareBtn', 'shareStatus', 'saveBtn', 'againBtn',
    'errTitle', 'errMsg', 'errDetail', 'errCopy', 'errBack', 'unsupportedMsg', 'version',
  ].map((id) => [id, $(id)]),
);

const MESSAGES = {
  unreadable: ["We couldn't read that video", 'Try picking it again from your camera roll or gallery.'],
  novideo: ['No video found', "That file doesn't seem to have any video in it."],
  codec: [
    "This browser can't open that kind of video",
    'Try Safari on iPhone or Chrome on Android. If the video came from another app, save it to your camera roll first.',
  ],
  cantEncode: ["This browser can't shrink videos", 'On iPhone use Safari (iOS 16.4 or newer). On Android use Chrome.'],
  toobig: ["Couldn't get it small enough", 'Even after squeezing, this video is still over the limit. Try a shorter clip.'],
  repick: ["Your phone stopped sharing this video with the page", 'Choose it again with the button below.'],
  generic: ['Something went wrong', 'Try again. If it keeps happening, try a shorter clip or close other apps to free up memory.'],
};

/** The phone refused to let the page read a picked file (typical for the later videos of a multi-pick). */
function isUnreadable(e) {
  const c = (e && e.cause) || e;
  return !!c && (c.name === 'NotReadableError' || /could not be read|permission problems|network error/i.test(String(c.message || c)));
}

class FriendlyError extends Error {
  constructor(code, cause) {
    super(code);
    this.code = code;
    this.cause = cause;
  }
}
class Cancelled extends Error {}

const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};

// ---------------------------------------------------------------- state

let jobs = []; // one per picked file: { file, info, outputs: [], error }
let current = null; // running Conversion
let cancelled = false;
let busy = false;
let repick = null; // finished videos kept while the user chooses the skipped ones again
let leftOver = []; // videos picked beyond what one share can carry
let wakeLock = null;
let pendingDecision = null; // { resolve, reject } while the trim screen is open
let trimJob = null;
const urls = new Set();

function objectUrl(blob) {
  const u = URL.createObjectURL(blob);
  urls.add(u);
  return u;
}

function resetAll(keepInput = false) {
  for (const u of urls) URL.revokeObjectURL(u);
  urls.clear();
  el.trimVideo.removeAttribute('src');
  el.trimVideo.load();
  el.results.replaceChildren();
  for (const j of jobs) {
    try {
      if (j.info) j.info.input.dispose();
    } catch {}
  }
  jobs = [];
  pendingDecision = null;
  trimJob = null;
  if (!keepInput) {
    repick = null;
    leftOver = [];
    batchLimitMB = null;
  }
  if (!keepInput) el.file.value = ''; // clearing it early can release the picked file on some phones
}

const chosenLimitMB = () => Number(el.limit.value) || 20;
// While a pick of several videos is being made, each gets a size that lets the whole pick fit in one share.
let batchLimitMB = null;
const limitMB = () => (batchLimitMB ? Math.min(batchLimitMB, chosenLimitMB()) : chosenLimitMB());
const concert = () => true; // these are concert videos: the sound always gets the bigger share

// ---------------------------------------------------------------- screens

function show(name) {
  for (const s of document.querySelectorAll('[data-screen]')) s.hidden = s.id !== 'screen-' + name;
  const heading = document.querySelector(`#screen-${name} h1, #screen-${name} h2`);
  if (heading) heading.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function describeError(e) {
  const cause = e instanceof FriendlyError ? e.cause || e : e;
  return String((cause && (cause.stack || cause.message)) || cause);
}

function showError(e) {
  console.error(e);
  const code = e instanceof FriendlyError && MESSAGES[e.code] ? e.code : 'generic';
  const [title, msg] = MESSAGES[code];
  el.errTitle.textContent = title;
  el.errMsg.textContent = msg;
  el.errDetail.textContent = `Version ${window.DR_VERSION}\n${navigator.userAgent}\n\n${describeError(e)}`;
  document.getElementById('errDetails').open = true;
  show('error');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

async function flash(button, text) {
  const old = button.textContent;
  button.textContent = text;
  await new Promise((r) => setTimeout(r, 1800));
  button.textContent = old;
}

// ---------------------------------------------------------------- settings

try {
  const saved = store.get('dr-limit');
  if (saved && [...el.limit.options].some((o) => o.value === saved)) el.limit.value = saved;
} catch {}
el.limit.addEventListener('change', () => store.set('dr-limit', el.limit.value));

// ---------------------------------------------------------------- analysis

/** Phones hand over files lazily; touching the start first avoids a failed first read. */
async function warmUp(file) {
  try {
    await file.slice(0, 4096).arrayBuffer();
  } catch {}
}

async function analyze(job) {
  if (job.buffer) return analyzeOnce(job); // the copy in memory cannot fail to read
  await warmUp(job.file);
  try {
    return await analyzeOnce(job);
  } catch (e) {
    if (e instanceof FriendlyError && e.code !== 'unreadable') throw e;
    // One more try: a lazily exported file is often readable a moment later.
    await new Promise((r) => setTimeout(r, 700));
    await warmUp(job.file);
    return analyzeOnce(job);
  }
}

async function analyzeOnce(job) {
  const file = job.file; // name, size and date only; the video data comes from the copy when there is one
  const source = job.buffer ? new BufferSource(job.buffer) : new BlobSource(file, { useStreamReader: false });
  const input = new Input({ source, formats: ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new FriendlyError('novideo');
    if (!(await video.canDecode())) throw new FriendlyError('codec');

    const [width, height, duration, stats, hdr] = await Promise.all([
      video.getDisplayWidth(),
      video.getDisplayHeight(),
      input.computeDuration().catch(() => video.getDurationFromMetadata()),
      video.computePacketStats(150).catch(() => ({ averagePacketRate: 30 })),
      video.hasHighDynamicRange().catch(() => false),
    ]);
    if (!(duration > 0)) throw new Error('Could not work out how long the video is');

    // Trouble reading the sound must not sink the whole video: carry on without it.
    let audio = null;
    let audioLost = false;
    try {
      const audioTrack = await input.getPrimaryAudioTrack();
      if (audioTrack) {
        const [codec, channels, decodable] = await Promise.all([
          audioTrack.getCodec(),
          audioTrack.getNumberOfChannels(),
          audioTrack.canDecode(),
        ]);
        let bitrate = await audioTrack.getAverageBitrate();
        if (!bitrate) bitrate = (await audioTrack.computePacketStats(150)).averageBitrate;
        audio = { codec, channels, bitrate, decodable };
      }
    } catch (e) {
      console.warn('Could not read the sound track', e);
      audio = null;
      audioLost = true;
    }
    return { input, file, width, height, duration, fps: stats.averagePacketRate, audio, audioLost, hdr };
  } catch (e) {
    input.dispose();
    throw e instanceof FriendlyError ? e : new FriendlyError('unreadable', e);
  }
}

function makePlan(info, duration, noCopy) {
  const base = { duration, limitMB: limitMB(), width: info.width, height: info.height, fps: info.fps, concert: concert() };
  const audio = info.audio ? { codec: info.audio.codec, bitrate: info.audio.bitrate, channels: info.audio.channels } : null;
  let plan = B.plan({ ...base, audio, noCopy });
  // Sound we can neither copy nor decode has to go.
  if (plan.audio && !plan.audio.copy && !info.audio.decodable) {
    plan = B.plan({ ...base, audio: null });
    plan.audioDropped = true;
  }
  return plan;
}

const needsDecision = (plan) => plan.quality === 'low' || Math.min(plan.width, plan.height) < SOFT_BELOW;

// ---------------------------------------------------------------- the bottleneck: one share

// Chrome on Android refuses a share of more than 10 files or more than 50 MiB in total (Chromium's
// ShareServiceImpl: MAX_SHARED_FILE_COUNT = 10, MAX_SHARED_FILE_BYTES = 50 MiB). It only checks when the share
// happens, so canShare() says yes to anything. Discord also takes at most 10 files per message.
// That is the limit the page works to: one pick = at most 10 videos, sized so that together they go out in ONE
// share. One or two videos keep the full Discord size; more videos are made a little smaller each.
const SHARE_MAX_FILES = 10;
const ANDROID_CHROME = /Android/.test(navigator.userAgent) && /Chrome\//.test(navigator.userAgent);
const SHARE_MAX_BYTES = ANDROID_CHROME ? 50 * 1048576 : Infinity;
const canShareFiles = () => !!(navigator.share && navigator.canShare);

/** Size per video (MB) so that `count` videos fit in one share, or null when the normal limit already fits. */
function sizeForPick(count) {
  if (count < 2 || loadHook() || !canShareFiles() || !Number.isFinite(SHARE_MAX_BYTES)) return null;
  const perVideo = (SHARE_MAX_BYTES * 0.95) / count / 1e6;
  return perVideo < chosenLimitMB() ? Math.floor(perVideo * 10) / 10 : null;
}

function refreshPickHint() {
  const show = canShareFiles() && !loadHook();
  el.pickHint.hidden = !show;
  if (show) el.pickHint.textContent = `Up to ${SHARE_MAX_FILES} videos at a time. They all go to Discord in one share.`;
}

// ---------------------------------------------------------------- picking files

el.file.addEventListener('change', () => onFiles([...(el.file.files || [])]));

for (const type of ['dragenter', 'dragover']) {
  document.addEventListener(type, (e) => {
    e.preventDefault();
    document.body.classList.add('dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  document.addEventListener(type, (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
  });
}
document.addEventListener('drop', (e) => {
  const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
  if (files.length && !$('screen-idle').hidden) onFiles(files);
});

// Phones only let the page read a picked video for a short while after it was picked (later videos failed with
// "The requested file could not be read ... permission problems"). So every picked video, even a single one,
// is read in full at the instant of the pick, all at once.
// The copy is kept as plain memory owned by the page (an ArrayBuffer), NOT as a File: a File copy lives in the
// browser's blob storage, which moves big items to disk while the phone is busy, and reading it back later
// failed with the very same error even though the copy itself had worked.
const COPY_FILE_MAX = 1.5e9;
const COPY_TOTAL_MAX = Math.min(3e9, (navigator.deviceMemory || 4) * 300e6); // a 4 GB phone: 1.2 GB
function startCopies(files) {
  let room = COPY_TOTAL_MAX;
  return files.map((f) => {
    if (f.size > COPY_FILE_MAX || f.size > room) return null; // only an extreme pick is too big to hold
    room -= f.size;
    const t0 = performance.now();
    return f.arrayBuffer().then(
      (buffer) => ({ buffer, ms: performance.now() - t0 }),
      (error) => ({ error, ms: performance.now() - t0 }),
    );
  });
}

async function attachCopies(copies, offset) {
  setWorking('Getting your videos ready…', 'One moment.', '');
  for (let i = 0; i < copies.length; i++) {
    const job = jobs[offset + i];
    const r = copies[i] && (await copies[i]);
    if (!r) {
      job.diag = 'Not copied when picked (too big to hold).';
    } else if (r.buffer) {
      job.buffer = r.buffer;
      job.diag = `Copied when picked: ${B.formatBytes(r.buffer.byteLength)} in ${(r.ms / 1000).toFixed(1)} s, kept in memory.`;
    } else {
      job.diag = `Copy when picked failed after ${(r.ms / 1000).toFixed(1)} s: ${r.error && r.error.name}: ${r.error && r.error.message}`;
    }
  }
}

/** A File made fresh from data held in memory, right when it is needed (sharing, saving, posting, preview). */
function freshFile(name, type, buffer) {
  return new File([buffer], name, { type: type || 'video/mp4', lastModified: Date.now() });
}
const fileOf = (out) => (out.buffer ? freshFile(out.file.name, out.file.type, out.buffer) : out.file);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Free the file reader of a finished video (its details stay available). */
function releaseJob(job) {
  try {
    if (job.info) job.info.input.dispose();
  } catch {}
}

/** One video, with a second try after a pause if it failed for a reason that is not the video's fault. */
async function runJob(i) {
  const job = jobs[i];
  try {
    await processJob(job, i, jobs.length);
  } catch (e) {
    if (e instanceof Cancelled || (e instanceof FriendlyError && ['novideo', 'codec', 'cantEncode'].includes(e.code))) throw e;
    console.warn('Video failed, trying once more', e);
    releaseJob(job);
    job.outputs = [];
    if (!job.buffer && job.file.size <= COPY_FILE_MAX) {
      try {
        job.buffer = await job.file.arrayBuffer();
      } catch {}
    }
    setWorking('Trying that video again…', 'One moment.', jobs.length > 1 ? `Video ${i + 1} of ${jobs.length}` : '');
    await sleep(2500);
    if (cancelled) throw new Cancelled();
    try {
      await processJob(job, i, jobs.length);
    } catch (e2) {
      // Still refused after a pause: only choosing the video again will give the page access to it.
      if (isUnreadable(e2)) throw new FriendlyError('repick', e2 instanceof FriendlyError ? e2.cause || e2 : e2);
      throw e2;
    }
  }
}

async function onFiles(picked) {
  if (busy || !picked.length) return;
  // First thing, before anything else can take time: keep what one share can carry, and start reading it.
  const files = picked.slice(0, SHARE_MAX_FILES);
  leftOver = picked.slice(SHARE_MAX_FILES);
  batchLimitMB = sizeForPick((repick ? repick.filter((j) => !j.error).length : 0) + files.length);
  const copies = startCopies(files); // the phone's permission to read a picked video is short-lived
  busy = true;
  cancelled = false;
  const kept = repick || [];
  repick = null;
  resetAll(true);
  jobs = [...kept, ...files.map((file) => ({ file, info: null, outputs: [], error: null }))];
  keepAwake();
  setWorking('Reading your video…', 'This only takes a moment.', '');
  show('work');
  try {
    await attachCopies(copies, kept.length);
    for (let i = kept.length; i < jobs.length; i++) {
      try {
        await runJob(i);
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        console.error(e);
        jobs[i].error = e;
      }
      releaseJob(jobs[i]);
      // Give the memory back as soon as a video is finished (unless the copy itself is the result).
      if (jobs[i].buffer && !jobs[i].outputs.some((o) => o.buffer === jobs[i].buffer)) jobs[i].buffer = null;
      if (i < jobs.length - 1) {
        // Give the phone a moment to free what this video used before the next one starts.
        setWorking('Getting ready for the next video…', 'One moment.', `Video ${i + 2} of ${jobs.length}`);
        await sleep(1500);
        if (cancelled) throw new Cancelled();
      }
    }
    if (jobs.every((j) => j.error)) throw jobs[0].error;
    finishAll();
  } catch (e) {
    const wasCancelled = e instanceof Cancelled;
    resetAll();
    if (wasCancelled) show('idle');
    else showError(e);
  } finally {
    busy = false;
    releaseAwake();
  }
}

// ---------------------------------------------------------------- one video

async function processJob(job, index, total) {
  const queue = total > 1 ? `Video ${index + 1} of ${total}` : '';
  setWorking('Reading your video…', 'This only takes a moment.', queue);
  show('work');
  job.info = await analyze(job);
  if (cancelled) throw new Cancelled();
  const info = job.info;

  if (B.fitsAlready(job.file.size, limitMB()) && !el.trimFirst.checked) {
    job.outputs = [{ file: job.buffer ? freshFile(job.file.name, job.file.type, job.buffer) : job.file, buffer: job.buffer || null, original: true, bytes: job.file.size, durationText: B.formatDuration(info.duration), plan: null, part: null }];
    return;
  }

  let reason = null;
  for (;;) {
    const decision = await decide(job, reason, queue);
    const segments = decision.parts || [decision.trim];
    try {
      const outputs = [];
      for (let i = 0; i < segments.length; i++) {
        const part = segments.length > 1 ? { index: i + 1, count: segments.length } : null;
        outputs.push(await encodeSegment(job, segments[i], part, queue));
      }
      job.outputs = outputs;
      return;
    } catch (e) {
      if (e instanceof FriendlyError && e.code === 'toobig') {
        reason = 'big';
        continue;
      }
      throw e;
    }
  }
}

/** Decide trim/split for a video: only asks when the result would be soft, or when the user wants to trim. */
async function decide(job, reason, queue) {
  if (batchLimitMB && !el.trimFirst.checked) {
    // Sized to fit one share: no questions per video (splitting would add videos and break the one share).
    if (reason === 'big') throw new FriendlyError('toobig');
    return { trim: null, parts: null };
  }
  const plan = makePlan(job.info, job.info.duration, false);
  if (!reason && !el.trimFirst.checked && !needsDecision(plan)) return { trim: null, parts: null };
  return askTrim(job, reason || (needsDecision(plan) ? 'long' : null), queue);
}

// ---------------------------------------------------------------- trim / split screen

const MIN_CLIP = 1;
const QUALITY_LABEL = { great: 'sharp', good: 'good', low: 'blurry' };

function trimValues() {
  return { start: Number(el.trimStart.value), end: Number(el.trimEnd.value) };
}

function updateTrim(changed) {
  const info = trimJob.info;
  const gap = Math.min(MIN_CLIP, info.duration);
  let { start, end } = trimValues();
  if (end - start < gap) {
    if (changed === 'start') start = Math.max(0, end - gap);
    else end = Math.min(info.duration, start + gap);
    el.trimStart.value = start;
    el.trimEnd.value = end;
  }
  el.trimStartLabel.textContent = B.formatDuration(start);
  el.trimEndLabel.textContent = B.formatDuration(end);
  if (changed) el.trimVideo.currentTime = changed === 'start' ? start : Math.max(0, end - 0.1);

  const len = end - start;
  const plan = makePlan(info, len, start > 0.05);
  const side = Math.min(plan.width, plan.height);
  const soft = needsDecision(plan);
  let text = `Your clip will be ${B.formatDuration(len)} long, about ${side}p, and look ${QUALITY_LABEL[plan.quality]}.`;
  el.trimSummary.className = 'notice' + (soft ? ' warn' : '');
  const parts = B.splitParts(start, end, limitMB(), concert());
  if (soft && parts.length > 1) text += ` Splitting it into ${parts.length} parts keeps each one sharp.`;
  el.trimSummary.textContent = text;
  el.trimSplit.hidden = parts.length < 2 || !!batchLimitMB;
  el.trimSplit.textContent = `Split into ${parts.length} parts`;
  // When splitting is on offer it is the default (sharper); keeping one video is the quieter choice.
  const splitFirst = parts.length > 1;
  el.trimSplit.classList.toggle('primary', splitFirst);
  el.trimGo.classList.toggle('primary', !splitFirst);
  el.trimGo.textContent = splitFirst ? 'Keep it as one video (less sharp)' : 'Shrink it';
}

function askTrim(job, reason, queue) {
  trimJob = job;
  const info = job.info;
  const limit = limitMB();
  el.trimQueue.textContent = queue;
  el.trimVideo.src = objectUrl(job.buffer ? freshFile(job.file.name, job.file.type, job.buffer) : job.file);
  for (const r of [el.trimStart, el.trimEnd]) {
    r.max = info.duration;
    r.step = info.duration > 30 ? 0.5 : 0.1;
  }
  el.trimStart.value = 0;
  el.trimEnd.value = info.duration;
  const plan = makePlan(info, info.duration, false);
  el.trimInfo.textContent =
    reason === 'long'
      ? `This video is ${B.formatDuration(info.duration)} long, so at ${limit} MB it would come out about ${Math.min(plan.width, plan.height)}p and look soft. You can trim it, split it into sharp parts, or shrink it as it is.`
      : reason === 'big'
        ? `That was still too big for ${limit} MB even after squeezing. Trim some off, or split it into parts.`
        : `${B.formatDuration(info.duration)} · ${B.formatBytes(job.file.size)}. Drag the sliders to keep just the part you want.`;
  updateTrim(null);
  show('trim');
  return new Promise((resolve, reject) => {
    pendingDecision = { resolve, reject };
  });
}

function settleTrim(split) {
  if (!pendingDecision) return;
  const { start, end } = trimValues();
  const info = trimJob.info;
  const changed = start > 0.05 || end < info.duration - 0.05;
  const trim = changed ? { start, end } : null;
  const parts = split ? B.splitParts(start, end, limitMB(), concert()) : null;
  const { resolve } = pendingDecision;
  pendingDecision = null;
  el.trimVideo.removeAttribute('src');
  el.trimVideo.load();
  show('work');
  resolve({ trim, parts });
}

el.trimStart.addEventListener('input', () => updateTrim('start'));
el.trimEnd.addEventListener('input', () => updateTrim('end'));
el.trimGo.addEventListener('click', () => settleTrim(false));
el.trimSplit.addEventListener('click', () => settleTrim(true));
el.trimBack.addEventListener('click', () => {
  if (!pendingDecision) return;
  const { reject } = pendingDecision;
  pendingDecision = null;
  reject(new Cancelled());
});

// ---------------------------------------------------------------- encoding

function setWorking(title, status, queue) {
  el.workTitle.textContent = title;
  el.workStatus.textContent = status;
  el.workQueue.textContent = queue || '';
  setProgress(0);
  el.eta.textContent = '';
}

function setProgress(p) {
  const pct = Math.max(0, Math.min(100, Math.round(p * 100)));
  el.pct.textContent = pct + '%';
  el.bar.firstElementChild.style.width = pct + '%';
  el.bar.setAttribute('aria-valuenow', String(pct));
}

async function keepAwake() {
  try {
    if (navigator.wakeLock && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch {}
}
function releaseAwake() {
  try {
    if (wakeLock) wakeLock.release();
  } catch {}
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && busy) keepAwake();
});
window.addEventListener('beforeunload', (e) => {
  if (busy) {
    e.preventDefault();
    e.returnValue = '';
  }
});

let aacReady = null;
function ensureAacEncoder() {
  aacReady ||= (async () => {
    if (await MB.canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, bitrate: 96000 })) return;
    // Some browsers (iOS before Safari 26) cannot encode AAC themselves; load the bundled encoder.
    const { registerAacEncoder } = await import('./vendor/mediabunny-aac-encoder.min.mjs');
    registerAacEncoder();
  })();
  return aacReady;
}

/** One conversion pass. `probe` encodes just a video sample, without sound. */
async function encodeOnce(info, plan, trim, onProgress, probe = false) {
  const videoCodec = await MB.getFirstEncodableVideoCodec(VIDEO_CODECS, {
    width: plan.width,
    height: plan.height,
    bitrate: plan.videoBitrate,
  });
  if (!videoCodec) throw new FriendlyError('cantEncode');

  let audio; // undefined = let the converter copy the sound untouched
  if (probe || info.audioLost || (info.audio && !plan.audio)) {
    audio = { discard: true };
  } else if (plan.audio && !plan.audio.copy) {
    await ensureAacEncoder();
    audio = { codec: 'aac', numberOfChannels: plan.audio.channels, quality: new Quality({ bitrate: plan.audio.bitrate }) };
  }

  const video = {
    codec: videoCodec,
    width: plan.width,
    height: plan.height,
    fit: 'fill',
    quality: new Quality({ bitrate: plan.videoBitrate, bitrateMode: 'variable' }),
  };
  if (plan.frameRate) video.frameRate = plan.frameRate;

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const conversion = await Conversion.init({
    input: info.input,
    output,
    video,
    audio,
    trim: trim || undefined,
    tags: {}, // do not carry location and device info into the shared file
    showWarnings: false,
  });
  if (!conversion.isValid) {
    const why = conversion.discardedTracks.map((t) => t.reason).join(', ');
    throw new FriendlyError('cantEncode', new Error('Conversion not valid: ' + why));
  }
  conversion.onProgress = onProgress;
  current = conversion;
  try {
    await conversion.execute();
  } catch (e) {
    if (cancelled || e instanceof ConversionCanceledError) throw new Cancelled();
    throw e;
  } finally {
    current = null;
  }
  return { buffer: output.target.buffer, videoCodec };
}

function progressReporter() {
  const started = performance.now();
  return (p) => {
    setProgress(p);
    const elapsed = (performance.now() - started) / 1000;
    el.eta.textContent = p > 0.04 && elapsed > 3 ? `About ${B.formatDuration((elapsed / p) * (1 - p))} left` : '';
  };
}

/** Shrink one segment (the whole video, a trimmed range or one part) to fit the limit. */
async function encodeSegment(job, seg, part, queue) {
  const info = job.info;
  const length = seg ? seg.end - seg.start : info.duration;
  const plan = makePlan(info, length, !!(seg && seg.start > 0.05));
  const label = [queue, part ? `Part ${part.index} of ${part.count}` : ''].filter(Boolean).join(' · ');
  let videoBps = plan.videoBitrate;

  // Encode a short sample first: it shows how this phone's encoder really behaves, so the full pass usually
  // lands on the first try instead of being redone.
  if (length >= PROBE_MIN_CLIP) {
    setWorking('Checking your video…', 'A quick test so the real run is right first time.', label);
    const from = (seg ? seg.start : 0) + (length - PROBE_SECONDS) * 0.45;
    const sample = { start: from, end: from + PROBE_SECONDS };
    const layout = B.layoutFor(videoBps, { width: info.width, height: info.height, fps: info.fps });
    try {
      const probed = await encodeOnce(info, { ...plan, videoBitrate: videoBps, ...layout }, sample, progressReporter(), true);
      videoBps = B.calibrate(videoBps, (probed.buffer.byteLength * 8) / PROBE_SECONDS);
    } catch (e) {
      if (e instanceof Cancelled || (e instanceof FriendlyError && e.code === 'cantEncode')) throw e;
      console.warn('Sample pass failed, continuing without it', e);
    }
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const layout = B.layoutFor(videoBps, { width: info.width, height: info.height, fps: info.fps });
    const attemptPlan = { ...plan, videoBitrate: videoBps, ...layout };
    setWorking(
      'Shrinking your video…',
      attempt === 1 ? `Making it ${Math.min(layout.width, layout.height)}p to fit ${limitMB()} MB.` : 'Almost there. Making it a little smaller…',
      label,
    );
    const out = await encodeOnce(info, attemptPlan, seg, progressReporter());
    if (out.buffer.byteLength <= plan.acceptBytes) {
      setProgress(1);
      const file = new File([out.buffer], outputName(info.file.name, part), { type: 'video/mp4', lastModified: Date.now() });
      return {
        file,
        buffer: out.buffer,
        original: false,
        bytes: file.size,
        plan: attemptPlan,
        part,
        durationText: B.formatDuration(length),
        note: [
          plan.audioDropped || info.audioLost ? "The sound couldn't be kept for this video." : '',
          info.hdr ? 'This was an HDR video, so colors may look a little different.' : '',
          out.videoCodec !== 'avc' ? "This browser can't make the most compatible video type, so some devices may not preview it." : '',
        ]
          .filter(Boolean)
          .join(' '),
      };
    }
    videoBps = B.retryVideoBitrate(videoBps, plan.targetBytes, out.buffer.byteLength);
  }
  throw new FriendlyError('toobig');
}

function outputName(name, part) {
  const base = (name || 'video').replace(/\.[^.]+$/, '').replace(/[^\w.\- ]+/g, '_').slice(0, 60) || 'video';
  return `${base}${part ? `-part${part.index}of${part.count}` : ''}-discord.mp4`;
}

el.cancelBtn.addEventListener('click', async () => {
  cancelled = true;
  if (current) await current.cancel();
});

// ---------------------------------------------------------------- results

const flat = () => jobs.flatMap((job) => job.outputs.map((out) => ({ job, out })));

function addCard(job, out) {
  const card = document.createElement('div');
  card.className = 'card item';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = out.file.name;
  const meta = document.createElement('div');
  meta.className = 'muted small';
  const side = out.plan ? `${Math.min(out.plan.width, out.plan.height)}p · ` : '';
  meta.textContent = out.original ? `${B.formatBytes(out.bytes)} · already small enough` : `${B.formatBytes(out.bytes)} · ${side}${out.durationText}`;
  const video = document.createElement('video');
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = objectUrl(fileOf(out));
  const status = document.createElement('p');
  status.className = 'small status';
  status.hidden = true;
  card.append(video, name, meta, status);
  out.ui = { status };
  el.results.append(card);
}

function setStatus(out, text, kind) {
  out.ui.status.hidden = !text;
  out.ui.status.textContent = text || '';
  out.ui.status.className = 'small status' + (kind ? ' ' + kind : '');
}

function finishAll() {
  const ok = jobs.filter((j) => !j.error);
  const failed = jobs.filter((j) => j.error);
  const outputs = flat();

  el.results.replaceChildren();
  for (const job of ok) for (const out of job.outputs) addCard(job, out);
  for (const job of failed) {
    const card = document.createElement('div');
    card.className = 'card item';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = job.file.name;
    const why = document.createElement('p');
    why.className = 'small status err';
    const code = job.error instanceof FriendlyError && MESSAGES[job.error.code] ? job.error.code : 'generic';
    why.textContent = `${MESSAGES[code][0]}. ${MESSAGES[code][1]}`;
    const details = document.createElement('details');
    details.open = !(job.error instanceof FriendlyError && job.error.code === 'repick'); // keep the button in view
    const summary = document.createElement('summary');
    summary.textContent = 'Technical details';
    const pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;font-size:12px;margin:8px 0';
    pre.textContent = `Version ${window.DR_VERSION}\n${navigator.userAgent}\nFile: ${job.file.name} (${B.formatBytes(job.file.size)}, type "${job.file.type}")\n${job.diag || ''}\n\n${describeError(job.error)}`;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn';
    copy.textContent = 'Copy details';
    copy.addEventListener('click', async () => flash(copy, (await copyText(pre.textContent)) ? 'Copied ✓' : "Couldn't copy"));
    details.append(summary, pre, copy);
    card.append(name, why, details);
    el.results.append(card);
  }

  const skipped = failed.filter((j) => j.error instanceof FriendlyError && j.error.code === 'repick');
  el.repickBtn.hidden = !skipped.length;
  el.repickBtn.textContent = skipped.length === 1 ? 'Choose the skipped video again' : `Choose the ${skipped.length} skipped videos again`;

  const before = ok.reduce((n, j) => n + j.file.size, 0);
  const after = outputs.reduce((n, o) => n + o.out.bytes, 0);
  const allOriginal = outputs.every((o) => o.out.original);
  el.doneTitle.textContent = failed.length ? 'Done, with problems' : allOriginal ? 'Already small enough!' : 'Ready to send!';
  el.doneSizes.textContent = '';
  if (allOriginal) {
    el.doneSizes.textContent = outputs.length > 1 ? `${outputs.length} videos, no shrinking needed` : B.formatBytes(after);
  } else {
    const a = document.createElement('span');
    a.textContent = B.formatBytes(before);
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = ' → ';
    const b = document.createElement('span');
    b.className = 'after';
    b.textContent = B.formatBytes(after);
    el.doneSizes.append(a, arrow, b);
  }
  const notes = [...new Set(outputs.map((o) => o.out.note).filter(Boolean))];
  if (leftOver.length) {
    notes.unshift(
      `One share takes ${SHARE_MAX_FILES} videos, so only the first ${SHARE_MAX_FILES} were done. ` +
        `Not done yet: ${leftOver.map((f) => f.name).join(', ')}. Pick ${leftOver.length === 1 ? 'it' : 'them'} next.`,
    );
  }
  el.doneNote.hidden = !notes.length;
  el.doneNote.textContent = notes.join(' ');

  // Posting and sharing options.
  const hook = loadHook();
  el.postBtn.hidden = !hook;
  el.nameField.hidden = !hook;
  el.postTo.hidden = !hook;
  if (hook) el.postTo.textContent = `Posts to the thread whose ID ends ${describeHook(hook)}.`;
  el.postStatus.hidden = true;
  el.postBtn.disabled = false;
  el.postBtn.textContent = outputs.length > 1 ? 'Post all to the thread' : 'Post to the thread';
  el.posterName.value = store.get('dr-name') || '';
  shareNext = 0;
  el.shareStatus.hidden = true;
  updateShareButton();
  const canShare = !el.shareBtn.hidden;
  el.shareBtn.classList.toggle('primary', canShare && !hook);
  el.saveBtn.classList.toggle('primary', !canShare && !hook);
  el.saveBtn.textContent = canShare ? 'Save to my device' : 'Download';
  show('done');
}

el.postBtn.addEventListener('click', async () => {
  const hook = loadHook();
  const items = flat();
  if (!hook || !items.length) return;
  const name = el.posterName.value.trim();
  el.postStatus.hidden = false;
  el.postStatus.className = 'muted';
  if (!name) {
    el.postStatus.textContent = 'Type your name first so people know who posted it.';
    el.posterName.focus();
    return;
  }
  store.set('dr-name', name);
  el.postBtn.disabled = true;
  try {
    for (const item of items) {
      const { out } = item;
      if (out.posted) continue;
      setStatus(out, 'Posting…');
      el.postStatus.textContent = items.length > 1 ? `Posting ${items.indexOf(item) + 1} of ${items.length}…` : 'Posting…';
      await postToThread({
        hook,
        username: name,
        file: fileOf(out),
        onProgress: (p) => setStatus(out, `Posting… ${Math.round(p * 100)}%`),
      });
      out.posted = true;
      setStatus(out, 'Posted ✓', 'ok');
    }
    el.postStatus.textContent = 'Posted to the thread ✓';
    el.postBtn.textContent = 'Posted ✓';
  } catch (e) {
    const code = e instanceof PostError ? e.code : 'rejected';
    const failedItem = items.find((i) => !i.out.posted);
    if (failedItem) setStatus(failedItem.out, POST_MESSAGES[code], 'err');
    el.postStatus.textContent = POST_MESSAGES[code];
    el.postStatus.className = 'notice bad';
    el.postBtn.disabled = false;
    el.postBtn.textContent = 'Try again';
    console.error(e);
  }
});

// One tap sends the whole pick: it was sized to fit one share (see "the bottleneck" above). Should a phone still
// refuse, the refused size is remembered and the next group is halved, quietly.
let shareNext = 0; // index of the first video not yet sent

function learnedShareLimit() {
  try {
    const v = JSON.parse(store.get('dr-share-limit'));
    return v && v.files > 0 && v.bytes > 0 ? v : null;
  } catch {
    return null;
  }
}

function learnShareLimit(files, bytes) {
  const prev = learnedShareLimit();
  const next = prev ? { files: Math.min(prev.files, files), bytes: Math.min(prev.bytes, bytes) } : { files, bytes };
  store.set('dr-share-limit', JSON.stringify(next));
}

function nextShareBatch() {
  const items = flat();
  const learned = learnedShareLimit();
  const limit = {
    files: Math.min(SHARE_MAX_FILES, learned ? learned.files : Infinity),
    bytes: Math.min(SHARE_MAX_BYTES, learned ? learned.bytes : Infinity),
  };
  const batch = [];
  let bytes = 0;
  for (let i = shareNext; i < items.length; i++) {
    const size = items[i].out.file.size;
    if (batch.length && (batch.length >= limit.files || bytes + size > limit.bytes)) break;
    batch.push(fileOf(items[i].out));
    bytes += size;
  }
  try {
    while (batch.length > 1 && !navigator.canShare({ files: batch })) batch.pop();
    if (!navigator.canShare({ files: batch })) return { items, batch: [] };
  } catch {
    return { items, batch: [] };
  }
  return { items, batch };
}

function updateShareButton() {
  const { items, batch } = nextShareBatch();
  el.shareBtn.disabled = false;
  if (!navigator.share || !navigator.canShare || !items.length) {
    el.shareBtn.hidden = true;
  } else if (shareNext >= items.length) {
    el.shareBtn.hidden = false;
    el.shareBtn.disabled = true;
    el.shareBtn.textContent = 'All sent ✓';
  } else if (!batch.length) {
    el.shareBtn.hidden = true;
  } else {
    el.shareBtn.hidden = false;
    const from = shareNext + 1;
    const to = shareNext + batch.length;
    el.shareBtn.textContent =
      items.length === batch.length
        ? 'Send with the share sheet'
        : from === to
          ? `Send video ${from} of ${items.length}`
          : `Send videos ${from}–${to} of ${items.length}`;
  }
}

el.shareBtn.addEventListener('click', async () => {
  const { batch } = nextShareBatch();
  if (!batch.length) return;
  try {
    await navigator.share({ files: batch });
    shareNext += batch.length;
    updateShareButton();
    const total = flat().length;
    el.shareStatus.hidden = false;
    el.shareStatus.textContent =
      shareNext >= total ? `All ${total} sent.` : `Sent ${shareNext} of ${total}. Tap the button again to send the next ones.`;
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    if (batch.length > 1) {
      // The phone refused this many at once: remember it, offer a smaller group now, and cap the next pick.
      // Halve rather than drop one at a time: one refusal of 9 used to cost a tap for every number down to 4.
      learnShareLimit(Math.max(1, Math.ceil(batch.length / 2)), batch.reduce((n, f) => n + f.size, 0) - 1);
      updateShareButton();
      el.shareStatus.hidden = false;
      el.shareStatus.textContent = 'Your phone wants smaller groups. Tap the button again.';
      return;
    }
    el.doneNote.hidden = false;
    el.doneNote.textContent = "Sharing didn't work. Tap Save to my device, then attach the videos in Discord.";
  }
});

el.saveBtn.addEventListener('click', async () => {
  for (const { out } of flat()) {
    const a = document.createElement('a');
    a.href = objectUrl(fileOf(out));
    a.download = out.file.name;
    document.body.append(a);
    a.click();
    a.remove();
    await new Promise((r) => setTimeout(r, 400));
  }
});

el.repickBtn.addEventListener('click', () => {
  repick = jobs.filter((j) => !j.error); // keep what is done; the new pick is added to it
  el.file.value = '';
  el.file.click();
});

el.againBtn.addEventListener('click', () => {
  resetAll();
  show('idle');
});
el.errBack.addEventListener('click', () => {
  resetAll();
  show('idle');
});
el.errCopy.addEventListener('click', async () => flash(el.errCopy, (await copyText(el.errDetail.textContent)) ? 'Copied ✓' : "Couldn't copy"));

// ---------------------------------------------------------------- thread link

// A setup link is only a request to connect: anyone can make one, so nothing is saved until the user agrees.
let pendingHook = null;

function refreshHookStatus() {
  const saved = loadHook();
  refreshPickHint();
  el.hookStatus.hidden = !saved;
  if (saved) el.hookThread.textContent = 'thread ' + describeHook(saved);
  const asking = pendingHook && !sameHook(pendingHook, saved);
  el.hookPrompt.hidden = !asking;
  if (asking) {
    el.hookPromptText.textContent =
      `This link can post your videos to a Discord thread (its ID ends ${describeHook(pendingHook)}).` +
      (saved ? ' It would replace the thread you are connected to now.' : '') +
      ' Only connect if a friend sent you this link in your server.';
  }
}
el.hookConnect.addEventListener('click', () => {
  if (pendingHook) saveHook(pendingHook);
  pendingHook = null;
  refreshHookStatus();
});
el.hookIgnore.addEventListener('click', () => {
  pendingHook = null;
  refreshHookStatus();
});
el.hookForget.addEventListener('click', () => {
  forgetHook();
  refreshHookStatus();
});

// ---------------------------------------------------------------- boot

async function boot() {
  window.__drBooted = true;
  // The code and the version file must be from the same release. If an old copy of one was served, reload once.
  if (window.DR_VERSION !== APP_VERSION) {
    let tried = null;
    try {
      tried = sessionStorage.getItem('dr-version-reload');
      sessionStorage.setItem('dr-version-reload', String(window.DR_VERSION) + '/' + APP_VERSION);
    } catch {}
    if (tried !== String(window.DR_VERSION) + '/' + APP_VERSION) {
      location.reload();
      return;
    }
  }
  refreshPickHint();
  el.version.textContent = 'v' + APP_VERSION; // the version of the code that is actually running
  pendingHook = captureHookFromLocation();
  refreshHookStatus();

  // WKWebView-style in-app browsers on iPhone have no "Safari/" token; they are the ones that misbehave.
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && !/Safari\//.test(ua)) el.inAppBanner.hidden = false;

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {}); // always look for a new release

  let problem = null;
  if (!window.isSecureContext) problem = 'insecure';
  else if (!('VideoEncoder' in window) || !('VideoDecoder' in window)) problem = 'browser';
  else {
    try {
      const codec = await MB.getFirstEncodableVideoCodec(VIDEO_CODECS, { width: 1280, height: 720, bitrate: 2e6 });
      if (!codec) problem = 'browser';
    } catch {
      problem = 'browser';
    }
  }
  if (problem) {
    el.unsupportedMsg.textContent =
      problem === 'insecure'
        ? 'Open this from its website link instead of a saved file.'
        : 'On iPhone, open this link in Safari (iOS 16.4 or newer). On Android, use Chrome. On a computer, use Chrome, Edge or Safari. If you opened it from inside Discord, tap the menu and choose “Open in browser”.';
    show('unsupported');
  }
}

window.addEventListener('unhandledrejection', (e) => {
  if (e.reason instanceof ConversionCanceledError || e.reason instanceof Cancelled) e.preventDefault();
});

boot();
