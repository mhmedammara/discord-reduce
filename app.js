// discord-reduce: shrink a video on-device so it fits Discord's upload limit.
// Decode -> resize -> hardware encode -> MP4, all in the browser via WebCodecs (mediabunny).
import * as MB from 'mediabunny';

const B = window.DRBudget;
const { Input, ALL_FORMATS, BlobSource, Output, BufferTarget, Mp4OutputFormat, Conversion, ConversionCanceledError, Quality } = MB;

// H.264 plays everywhere in Discord. VP9 is only a fallback for browsers that cannot encode H.264.
const VIDEO_CODECS = ['avc', 'vp9'];
const MAX_ATTEMPTS = 3;

const $ = (id) => document.getElementById(id);
const el = {
  file: $('file'),
  limit: $('limit'),
  trimFirst: $('trimFirst'),
  trimVideo: $('trimVideo'),
  trimInfo: $('trimInfo'),
  trimStart: $('trimStart'),
  trimEnd: $('trimEnd'),
  trimStartLabel: $('trimStartLabel'),
  trimEndLabel: $('trimEndLabel'),
  trimSummary: $('trimSummary'),
  trimGo: $('trimGo'),
  trimBack: $('trimBack'),
  workTitle: $('workTitle'),
  workStatus: $('workStatus'),
  bar: $('bar'),
  pct: $('pct'),
  eta: $('eta'),
  cancelBtn: $('cancelBtn'),
  doneTitle: $('doneTitle'),
  doneSizes: $('doneSizes'),
  doneDetail: $('doneDetail'),
  doneVideo: $('doneVideo'),
  doneNote: $('doneNote'),
  shareBtn: $('shareBtn'),
  shareTip: $('shareTip'),
  saveBtn: $('saveBtn'),
  againBtn: $('againBtn'),
  errTitle: $('errTitle'),
  errMsg: $('errMsg'),
  errDetail: $('errDetail'),
  errBack: $('errBack'),
  unsupportedMsg: $('unsupportedMsg'),
};

const MESSAGES = {
  unreadable: ["We couldn't read that video", 'Try picking it again from your camera roll or gallery.'],
  novideo: ['No video found', "That file doesn't seem to have any video in it."],
  codec: [
    "This browser can't open that kind of video",
    'Try Safari on iPhone or Chrome on Android. If the video came from another app, save it to your camera roll first.',
  ],
  cantEncode: ["This browser can't shrink videos", 'On iPhone use Safari (iOS 16.4 or newer). On Android use Chrome.'],
  generic: [
    'Something went wrong',
    'Try again. If it keeps happening, try a shorter clip or close other apps to free up memory.',
  ],
};

class FriendlyError extends Error {
  constructor(code, cause) {
    super(code);
    this.code = code;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------- state

let info = null; // analysed source video
let result = null; // { file, original }
let current = null; // running Conversion
let cancelled = false;
let busy = false;
let wakeLock = null;
const urls = new Set();

function objectUrl(blob) {
  const u = URL.createObjectURL(blob);
  urls.add(u);
  return u;
}

function cleanup() {
  for (const u of urls) URL.revokeObjectURL(u);
  urls.clear();
  el.trimVideo.removeAttribute('src');
  el.trimVideo.load();
  el.doneVideo.removeAttribute('src');
  el.doneVideo.load();
  try {
    if (info) info.input.dispose();
  } catch {}
  info = null;
  result = null;
  el.file.value = '';
}

// ---------------------------------------------------------------- screens

function show(name) {
  for (const s of document.querySelectorAll('[data-screen]')) s.hidden = s.id !== 'screen-' + name;
  const heading = document.querySelector(`#screen-${name} h1, #screen-${name} h2`);
  if (heading) heading.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function showError(e) {
  console.error(e);
  const code = e instanceof FriendlyError && MESSAGES[e.code] ? e.code : 'generic';
  const [title, msg] = MESSAGES[code];
  el.errTitle.textContent = title;
  el.errMsg.textContent = msg;
  const cause = e instanceof FriendlyError ? e.cause || e : e;
  el.errDetail.textContent = String((cause && (cause.stack || cause.message)) || cause);
  show('error');
}

// ---------------------------------------------------------------- settings

function getLimit() {
  return Number(el.limit.value) || 10;
}

try {
  const saved = localStorage.getItem('dr-limit');
  if (saved && [...el.limit.options].some((o) => o.value === saved)) el.limit.value = saved;
} catch {}
el.limit.addEventListener('change', () => {
  try {
    localStorage.setItem('dr-limit', el.limit.value);
  } catch {}
});

// ---------------------------------------------------------------- analysis

async function analyze(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const [video, audioTrack] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
    if (!video) throw new FriendlyError('novideo');
    if (!(await video.canDecode())) throw new FriendlyError('codec');

    const [width, height, duration, stats] = await Promise.all([
      video.getDisplayWidth(),
      video.getDisplayHeight(),
      input.computeDuration(),
      video.computePacketStats(150),
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
    return { input, file, width, height, duration, fps: stats.averagePacketRate, audio };
  } catch (e) {
    input.dispose();
    throw e instanceof FriendlyError ? e : new FriendlyError('unreadable', e);
  }
}

function makePlan(duration, noCopy, limitMB = getLimit()) {
  const audio = info.audio ? { codec: info.audio.codec, bitrate: info.audio.bitrate, channels: info.audio.channels } : null;
  let plan = B.plan({ duration, limitMB, width: info.width, height: info.height, fps: info.fps, audio, noCopy });
  // Sound we can neither copy nor decode has to go.
  if (plan.audio && !plan.audio.copy && !info.audio.decodable) {
    plan = B.plan({ duration, limitMB, width: info.width, height: info.height, fps: info.fps, audio: null });
    plan.audioDropped = true;
  }
  return plan;
}

// ---------------------------------------------------------------- picking a file

async function onFile(file) {
  if (busy || !file) return;
  busy = true;
  cancelled = false;
  cleanup();
  setWorking('Reading your video…', 'This only takes a moment.');
  show('work');
  try {
    info = await analyze(file);
    if (cancelled) {
      cleanup();
      show('idle');
      return;
    }
    if (B.fitsAlready(file.size, getLimit()) && !el.trimFirst.checked) {
      finish({ file, original: true, plan: null, bytes: file.size });
      return;
    }
    const plan = makePlan(info.duration, false);
    if (el.trimFirst.checked || plan.quality === 'low') {
      showTrim(plan.quality === 'low' ? 'long' : null);
    } else {
      await startEncode(null);
    }
  } catch (e) {
    cleanup();
    showError(e);
  } finally {
    busy = false;
  }
}

el.file.addEventListener('change', () => onFile(el.file.files && el.file.files[0]));

// Drag and drop for computers.
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
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file && !$('screen-idle').hidden) onFile(file);
});

// ---------------------------------------------------------------- trim screen

const QUALITY_LABEL = { great: 'sharp', good: 'good', low: 'blurry' };
const MIN_CLIP = 1;

function trimValues() {
  return { start: Number(el.trimStart.value), end: Number(el.trimEnd.value) };
}

function updateTrim(changed) {
  const dur = info.duration;
  const gap = Math.min(MIN_CLIP, dur);
  let { start, end } = trimValues();
  if (end - start < gap) {
    if (changed === 'start') start = Math.max(0, end - gap);
    else end = Math.min(dur, start + gap);
    el.trimStart.value = start;
    el.trimEnd.value = end;
  }
  el.trimStartLabel.textContent = B.formatDuration(start);
  el.trimEndLabel.textContent = B.formatDuration(end);
  if (changed) el.trimVideo.currentTime = changed === 'start' ? start : Math.max(0, end - 0.1);

  const len = end - start;
  const plan = makePlan(len, start > 0.05);
  const limit = getLimit();
  let text = `Your clip will be ${B.formatDuration(len)} long, about ${Math.min(plan.width, plan.height)}p, and look ${QUALITY_LABEL[plan.quality]}.`;
  const good = B.maxGoodSeconds(limit, !!plan.audio);
  el.trimSummary.className = 'notice';
  if (plan.quality === 'low') {
    text += ` For a clear picture at ${limit} MB, keep it under about ${B.formatDuration(good)}.`;
    el.trimSummary.classList.add('warn');
  }
  el.trimSummary.textContent = text;
}

function showTrim(reason) {
  const dur = info.duration;
  el.trimVideo.src = objectUrl(info.file);
  for (const r of [el.trimStart, el.trimEnd]) {
    r.max = dur;
    r.step = dur > 30 ? 0.5 : 0.1;
  }
  el.trimStart.value = 0;
  el.trimEnd.value = dur;
  const limit = getLimit();
  el.trimInfo.textContent =
    reason === 'long'
      ? `This video is ${B.formatDuration(dur)} long, so it would turn out blurry at ${limit} MB. Trim it for a sharper result, or shrink it as is.`
      : reason === 'big'
        ? `That was still too big for ${limit} MB even after squeezing. Trim some off and try again.`
        : `${B.formatDuration(dur)} · ${B.formatBytes(info.file.size)}. Drag the sliders to keep just the part you want.`;
  updateTrim(null);
  show('trim');
}

el.trimStart.addEventListener('input', () => updateTrim('start'));
el.trimEnd.addEventListener('input', () => updateTrim('end'));
el.trimBack.addEventListener('click', () => {
  cleanup();
  show('idle');
});
el.trimGo.addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  const { start, end } = trimValues();
  const changed = start > 0.05 || end < info.duration - 0.05;
  try {
    await startEncode(changed ? { start, end } : null);
  } catch (e) {
    cleanup();
    showError(e);
  } finally {
    busy = false;
  }
});

// ---------------------------------------------------------------- encoding

function setWorking(title, status) {
  el.workTitle.textContent = title;
  el.workStatus.textContent = status;
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
  if (!document.hidden && current) keepAwake();
});
window.addEventListener('beforeunload', (e) => {
  if (current) {
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

async function encodeOnce(plan, trim, onProgress) {
  const videoCodec = await MB.getFirstEncodableVideoCodec(VIDEO_CODECS, {
    width: plan.width,
    height: plan.height,
    bitrate: plan.videoBitrate,
  });
  if (!videoCodec) throw new FriendlyError('cantEncode');

  let audio; // undefined = let the converter copy the sound untouched
  if (info.audio && !plan.audio) {
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
  } finally {
    current = null;
  }
  return { buffer: output.target.buffer, videoCodec };
}

async function startEncode(trim) {
  const length = trim ? trim.end - trim.start : info.duration;
  const limit = getLimit();
  const plan = makePlan(length, !!(trim && trim.start > 0.05));
  let videoBps = plan.videoBitrate;
  cancelled = false;

  show('work');
  keepAwake();
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const layout = B.layoutFor(videoBps, { width: info.width, height: info.height, fps: info.fps });
      const attemptPlan = { ...plan, videoBitrate: videoBps, ...layout };
      setWorking(
        'Shrinking your video…',
        attempt === 1
          ? `Making it ${Math.min(layout.width, layout.height)}p to fit ${limit} MB.`
          : 'Almost there. Making it a little smaller…',
      );
      const started = performance.now();
      let out;
      try {
        out = await encodeOnce(attemptPlan, trim, (p) => {
          setProgress(p);
          const elapsed = (performance.now() - started) / 1000;
          el.eta.textContent = p > 0.04 && elapsed > 3 ? `About ${B.formatDuration((elapsed / p) * (1 - p))} left` : '';
        });
      } catch (e) {
        if (cancelled || e instanceof ConversionCanceledError) {
          cleanup();
          show('idle');
          return;
        }
        throw e;
      }
      if (out.buffer.byteLength <= plan.acceptBytes) {
        setProgress(1);
        const name = outputName(info.file.name);
        const file = new File([out.buffer], name, { type: 'video/mp4', lastModified: Date.now() });
        finish({
          file,
          original: false,
          plan: attemptPlan,
          bytes: file.size,
          note: [
            plan.audioDropped ? "The sound couldn't be kept for this video." : '',
            out.videoCodec !== 'avc' ? "This browser can't make the most compatible video type, so some devices may not preview it." : '',
          ]
            .filter(Boolean)
            .join(' '),
        });
        return;
      }
      videoBps = B.retryVideoBitrate(videoBps, plan.targetBytes, out.buffer.byteLength);
    }
    showTrim('big');
  } finally {
    releaseAwake();
  }
}

function outputName(name) {
  const base = (name || 'video').replace(/\.[^.]+$/, '').replace(/[^\w.\- ]+/g, '_').slice(0, 60) || 'video';
  return `${base}-discord.mp4`;
}

el.cancelBtn.addEventListener('click', async () => {
  cancelled = true;
  if (current) await current.cancel();
});

// ---------------------------------------------------------------- result

function finish({ file, original, plan, bytes, note }) {
  result = { file, original };
  const before = info ? info.file.size : bytes;
  if (original) {
    el.doneTitle.textContent = 'Already small enough!';
    el.doneSizes.textContent = B.formatBytes(bytes);
    el.doneDetail.textContent = `This video is already under ${getLimit()} MB, so there's nothing to shrink.`;
  } else {
    el.doneTitle.textContent = 'Ready to send!';
    el.doneSizes.innerHTML = '';
    const a = document.createElement('span');
    a.textContent = B.formatBytes(before);
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = ' → ';
    const b = document.createElement('span');
    b.className = 'after';
    b.textContent = B.formatBytes(bytes);
    el.doneSizes.append(a, arrow, b);
    el.doneDetail.textContent = `${Math.min(plan.width, plan.height)}p · ${B.formatDuration(info.duration)}`;
  }
  el.doneNote.hidden = !note;
  el.doneNote.textContent = note || '';
  el.doneVideo.src = objectUrl(file);

  let canShare = false;
  try {
    canShare = !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] }));
  } catch {}
  el.shareBtn.hidden = !canShare;
  el.shareTip.hidden = !canShare;
  el.saveBtn.classList.toggle('primary', !canShare);
  el.saveBtn.textContent = canShare ? 'Save to my device' : 'Download';
  show('done');
}

el.shareBtn.addEventListener('click', async () => {
  if (!result) return;
  try {
    await navigator.share({ files: [result.file] });
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    el.doneNote.hidden = false;
    el.doneNote.textContent = "Sharing didn't work. Tap Save to my device, then attach the video in Discord.";
  }
});

el.saveBtn.addEventListener('click', () => {
  if (!result) return;
  const a = document.createElement('a');
  a.href = objectUrl(result.file);
  a.download = result.file.name;
  document.body.append(a);
  a.click();
  a.remove();
});

el.againBtn.addEventListener('click', () => {
  cleanup();
  show('idle');
});
el.errBack.addEventListener('click', () => {
  cleanup();
  show('idle');
});

// ---------------------------------------------------------------- boot

async function boot() {
  window.__drBooted = true;
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
        : "On iPhone, open this link in Safari (iOS 16.4 or newer). On Android, use Chrome. On a computer, use Chrome, Edge or Safari. If you opened it from inside Discord, tap the menu and choose “Open in browser”.";
    show('unsupported');
  }
}

window.addEventListener('unhandledrejection', (e) => {
  if (e.reason instanceof ConversionCanceledError) return e.preventDefault();
});

boot();
