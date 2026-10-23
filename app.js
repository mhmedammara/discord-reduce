// discord-reduce: shrink videos on-device so they fit Discord's upload limit, then post or share them.
// Decode -> resize -> hardware encode -> MP4, all in the browser via WebCodecs (mediabunny).
import * as MB from 'mediabunny';
import { loadHook, saveHook, forgetHook, captureHookFromLocation, describeHook, sameHook, postToThread, PostError, POST_MESSAGES } from './discord.mjs';

const B = window.DRBudget;
const { Input, ALL_FORMATS, BlobSource, Output, BufferTarget, Mp4OutputFormat, Conversion, ConversionCanceledError, Quality } = MB;

// H.264 plays everywhere in Discord. VP9 is only a fallback for browsers that cannot encode H.264.
const VIDEO_CODECS = ['avc', 'vp9'];
const MAX_ATTEMPTS = 3;
const PROBE_SECONDS = 4; // length of the sample used to check how the encoder behaves
const PROBE_MIN_CLIP = 12; // shorter clips are just encoded, which is quick enough
const SOFT_BELOW = 480; // asking about trim/split when the picture would drop below this height

const $ = (id) => document.getElementById(id);
const el = Object.fromEntries(
  [
    'file', 'limit', 'concert', 'trimFirst', 'hookStatus', 'hookThread', 'hookForget', 'hookPrompt', 'hookPromptText', 'hookConnect', 'hookIgnore', 'inAppBanner', 'postTo',
    'trimQueue', 'trimVideo', 'trimInfo', 'trimStart', 'trimEnd', 'trimStartLabel', 'trimEndLabel', 'trimSummary',
    'trimGo', 'trimSplit', 'trimBack',
    'workTitle', 'workQueue', 'workStatus', 'bar', 'pct', 'eta', 'cancelBtn',
    'doneTitle', 'doneSizes', 'results', 'doneNote',
    'nameField', 'posterName', 'postBtn', 'postStatus', 'shareBtn', 'saveBtn', 'againBtn',
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
  generic: ['Something went wrong', 'Try again. If it keeps happening, try a shorter clip or close other apps to free up memory.'],
};

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
let wakeLock = null;
let pendingDecision = null; // { resolve, reject } while the trim screen is open
let trimJob = null;
const urls = new Set();

function objectUrl(blob) {
  const u = URL.createObjectURL(blob);
  urls.add(u);
  return u;
}

function resetAll() {
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
  el.file.value = '';
}

const limitMB = () => Number(el.limit.value) || 20;
const concert = () => el.concert.checked;

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
  if (store.get('dr-concert') === '0') el.concert.checked = false;
} catch {}
el.limit.addEventListener('change', () => store.set('dr-limit', el.limit.value));
el.concert.addEventListener('change', () => store.set('dr-concert', el.concert.checked ? '1' : '0'));

// ---------------------------------------------------------------- analysis

async function analyze(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const [video, audioTrack] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
    if (!video) throw new FriendlyError('novideo');
    if (!(await video.canDecode())) throw new FriendlyError('codec');

    const [width, height, duration, stats, hdr] = await Promise.all([
      video.getDisplayWidth(),
      video.getDisplayHeight(),
      input.computeDuration(),
      video.computePacketStats(150),
      video.hasHighDynamicRange().catch(() => false),
    ]);

    let audio = null;
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
    return {
      input,
      file,
      width,
      height,
      duration,
      fps: stats.averagePacketRate,
      audio,
      hdr,
    };
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

async function onFiles(files) {
  if (busy || !files.length) return;
  busy = true;
  cancelled = false;
  resetAll();
  jobs = files.map((file) => ({ file, info: null, outputs: [], error: null }));
  keepAwake();
  setWorking('Reading your video…', 'This only takes a moment.', '');
  show('work');
  try {
    for (let i = 0; i < jobs.length; i++) {
      try {
        await processJob(jobs[i], i, jobs.length);
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        console.error(e);
        jobs[i].error = e;
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
  job.info = await analyze(job.file);
  if (cancelled) throw new Cancelled();
  const info = job.info;

  if (B.fitsAlready(job.file.size, limitMB()) && !el.trimFirst.checked) {
    job.outputs = [{ file: job.file, original: true, bytes: job.file.size, durationText: B.formatDuration(info.duration), plan: null, part: null }];
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
  el.trimSplit.hidden = parts.length < 2;
  el.trimSplit.textContent = `Split into ${parts.length} parts`;
  el.trimGo.textContent = soft && parts.length > 1 ? 'Shrink it as one video' : 'Shrink it';
}

function askTrim(job, reason, queue) {
  trimJob = job;
  const info = job.info;
  const limit = limitMB();
  el.trimQueue.textContent = queue;
  el.trimVideo.src = objectUrl(job.file);
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
  if (probe || (info.audio && !plan.audio)) {
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
        original: false,
        bytes: file.size,
        plan: attemptPlan,
        part,
        durationText: B.formatDuration(length),
        note: [
          plan.audioDropped ? "The sound couldn't be kept for this video." : '',
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
  video.src = objectUrl(out.file);
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
    card.append(name, why);
    el.results.append(card);
  }

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
  let canShare = false;
  try {
    const files = outputs.map((o) => o.out.file);
    canShare = !!(navigator.canShare && navigator.share && files.length && navigator.canShare({ files }));
  } catch {}
  el.shareBtn.hidden = !canShare;
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
        file: out.file,
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

el.shareBtn.addEventListener('click', async () => {
  const files = flat().map((o) => o.out.file);
  if (!files.length) return;
  try {
    await navigator.share({ files });
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    el.doneNote.hidden = false;
    el.doneNote.textContent = "Sharing didn't work. Tap Save to my device, then attach the video in Discord.";
  }
});

el.saveBtn.addEventListener('click', async () => {
  for (const { out } of flat()) {
    const a = document.createElement('a');
    a.href = objectUrl(out.file);
    a.download = out.file.name;
    document.body.append(a);
    a.click();
    a.remove();
    await new Promise((r) => setTimeout(r, 400));
  }
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
  el.version.textContent = 'v' + window.DR_VERSION;
  pendingHook = captureHookFromLocation();
  refreshHookStatus();

  // WKWebView-style in-app browsers on iPhone have no "Safari/" token; they are the ones that misbehave.
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && !/Safari\//.test(ua)) el.inAppBanner.hidden = false;

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

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
