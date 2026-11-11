import {
  Input, BlobSource, ALL_FORMATS, Output, BufferTarget, Mp4OutputFormat, Conversion,
  ConversionCanceledError, canEncodeAudio, getFirstEncodableVideoCodec,
} from 'mediabunny';
import { planBudget, retryVideoBps, limitBytes } from './budget.js';

const $ = (id) => document.getElementById(id);
const SECTIONS = ['pick', 'setup', 'work', 'result', 'failure'];
const APP_VERSION = 'v4';
const CODEC_LABEL = { avc: 'H.264', hevc: 'H.265', vp9: 'VP9', av1: 'AV1' };

let source = null; // { file, duration, width, height, fps, hasAudio }
let job = null; // { cancelled, conversion }
let wakeLock = null;
let resultUrl = null;
let hiddenDuringJob = false;

// ---------- small helpers ----------

function show(...names) {
  for (const s of SECTIONS) $(s).hidden = !names.includes(s);
  $('startOver').hidden = !names.some((n) => n === 'result' || n === 'failure');
}

const fmtMb = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`;

function fmtTime(sec) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function setMessage(el, text) {
  el.textContent = text;
  el.hidden = !text;
}

function fail(text, offerFiles = false) {
  $('failureMsg').textContent = text;
  $('chooseFiles').hidden = !offerFiles;
  show('failure');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read the picked file in plain slices. Streaming it fails with "network error" on Android Chrome
// for files handed over by the phone's file picker (content:// URIs, Google Photos).
const FILE_READ_OPTIONS = { useStreamReader: false };

function isReadError(err) {
  return /network error|NotReadableError|NotFoundError|TimeoutError|could not be read/i.test(`${err?.name} ${err?.message ?? err}`);
}

function describeError(err) {
  if (err instanceof ConversionCanceledError) return 'Cancelled. Nothing was saved.';
  const text = String(err?.message ?? err);
  if (isReadError(err)) {
    return "The phone wouldn't let the browser read this video. This usually happens with videos that are only in " +
      'Google Photos or another cloud app. Tap "Choose from Files instead" below and pick it from Downloads, ' +
      'Camera or Movies, or open Google Photos, tap \u22ee then Download, and try again. ' +
      `(${err?.name ?? 'error'}: ${text}${copyLog ? `; ${copyLog}` : ''}; ${APP_VERSION})`;
  }
  if (err instanceof RangeError || /memory|allocation|quota/i.test(text)) {
    return 'The phone ran out of memory. Close other apps and tabs, or trim the video to a shorter part, then try again.';
  }
  if (err instanceof NoEncoderError) return "This device can't encode video in any format the browser supports.";
  if (hiddenDuringJob) return 'The screen turned off or you switched apps, which stops the work. Keep this tab open and the screen on, then try again.';
  if (/unsupported|unrecognizable|corrupt|invalid|not a valid/i.test(text)) {
    return "This file couldn't be read or converted. It may be corrupt or in a format this browser doesn't support. Try a different video.";
  }
  return `Something went wrong: ${text}`;
}

// ---------- wake lock ----------

async function holdScreenOn() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* optional; the on-screen hint covers it */ }
}

function releaseScreen() {
  try { wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
}

// The lock is dropped when the tab is hidden; take it again on return.
document.addEventListener('visibilitychange', () => {
  if (!job) return;
  if (document.visibilityState === 'hidden') hiddenDuringJob = true;
  else {
    holdScreenOn();
    if (hiddenDuringJob) $('workLabel').textContent = 'Shrinking... (it may have paused while the screen was off)';
  }
});

// ---------- environment ----------

function environmentProblem() {
  if (!window.isSecureContext) {
    return 'This page must be opened over HTTPS (or localhost). Video encoding is blocked on plain http:// pages.';
  }
  if (!('VideoEncoder' in window) || !('VideoDecoder' in window)) {
    if (/firefox|fxios/i.test(navigator.userAgent) && /android/i.test(navigator.userAgent)) {
      return "Firefox on Android can't do this. Open this page in Chrome.";
    }
    return 'This browser does not support WebCodecs, which is needed to shrink video. If you opened this inside Discord, tap the menu and choose "Open in browser". Otherwise use iOS/iPadOS 16.4 or newer, or a current Chrome.';
  }
  return null;
}

// ---------- making a local copy of the chosen file ----------

// On Android the picked file is a lazy handle to the phone's content provider (photo picker, Google Photos).
// Those reads can fail at random with NotReadableError, and encoding reads the file many times over.
// So the file is read once, in order and with retries, into the page's private storage, and all later
// work reads that copy. Where the browser can't write private storage (older Safari) the original is used.
const COPY_PREFIX = 'picked-video-';
const COPY_NAME = `${COPY_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; // one per tab
const COPY_CHUNK = 4 * 1024 * 1024;
// A read that fails is tried again, switching between reading in slices and reading as a stream, always
// continuing from where it stopped. Long videos may still be downloading (Google Photos) or converting
// (Android) when picked, so it only gives up after a long time with no new data at all.
const READ_TIMEOUT_MS = 20000; // a single read that takes longer than this counts as failed
const STALL_LIMIT_MS = 90000; // give up after this long without any new data
const STALE_COPY_MS = 6 * 60 * 60 * 1000;
let copying = null; // { cancelled, lastGain: last new data, lastActivity: last data of any kind }
let copyLog = ''; // shown with read errors, to tell where reading broke

class CopyCancelled extends Error {}
class StreamEnded extends Error {}

const mb = (bytes) => `${Math.round(bytes / 1e6)} MB`;

function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new DOMException(`no data for ${ms / 1000} seconds`, 'TimeoutError'));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function checkCancelled() {
  if (copying?.cancelled) throw new CopyCancelled();
}

async function privateDir() {
  try {
    return await navigator.storage.getDirectory();
  } catch {
    return null;
  }
}

async function openCopyWriter() {
  await removing; // never write while an old copy is still being deleted
  try {
    const dir = await privateDir();
    const handle = await dir?.getFileHandle(COPY_NAME, { create: true });
    const writable = await handle?.createWritable?.();
    return writable ? { handle, writable } : null;
  } catch {
    return null;
  }
}

function gained(onProgress, pos, size) {
  if (copying) copying.lastGain = copying.lastActivity = Date.now();
  $('workLabel').textContent = 'Getting the video ready...';
  onProgress(pos / size);
}

// Read [from, size) in slices. Returns the new position; a thrown error carries err.copied.
async function copyBySlices(file, writable, from, onProgress) {
  let pos = from;
  try {
    while (pos < file.size) {
      checkCancelled();
      const end = Math.min(file.size, pos + COPY_CHUNK);
      const buf = await withTimeout(file.slice(pos, end).arrayBuffer(), READ_TIMEOUT_MS);
      checkCancelled();
      await writable.write(buf);
      pos = end;
      gained(onProgress, pos, file.size);
    }
  } catch (err) {
    err.copied = pos;
    throw err;
  }
  return pos;
}

// Read the file in order from the start, skipping what is already written. Some phones only hand over
// long videos as a one-way stream, which this can read when slices can't. If the stream ends before
// the size the phone reported, the video is simply shorter than reported, so StreamEnded is thrown.
async function copyByStream(file, writable, from, onProgress) {
  let seen = 0;
  let pos = from;
  let reader = null;
  try {
    reader = file.stream().getReader();
    for (;;) {
      checkCancelled();
      const { value, done } = await withTimeout(reader.read(), READ_TIMEOUT_MS);
      if (done) break;
      const start = seen;
      seen += value.byteLength;
      if (seen <= pos) {
        $('workLabel').textContent = `Catching up to where reading stopped... ${Math.floor((seen / pos) * 100)}%`;
        if (copying) copying.lastActivity = Date.now(); // busy, but not new data
        continue;
      }
      await writable.write(start >= pos ? value : value.subarray(pos - start));
      pos = seen;
      gained(onProgress, Math.min(pos, file.size), file.size);
    }
  } catch (err) {
    reader?.cancel().catch(() => {});
    err.copied = pos;
    throw err;
  }
  if (pos < file.size) throw Object.assign(new StreamEnded(), { copied: pos });
  return pos;
}

// Waits, showing how long it has been since data last arrived; resolves early on cancel.
async function waitForPhone(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    checkCancelled();
    await sleep(Math.min(500, until - Date.now()));
  }
}

async function makeLocalCopy(file, onProgress) {
  copyLog = `${mb(file.size)} ${file.type || 'unknown type'}`;
  const target = await openCopyWriter();
  if (!target) {
    // No private storage to write to: check the start can be read, then use the original.
    copyLog += ', no private storage';
    await withTimeout(file.slice(0, Math.min(file.size, 65536)).arrayBuffer(), READ_TIMEOUT_MS);
    return file;
  }
  const { handle, writable } = target;
  let pos = 0;
  let tries = 0;
  const failures = [];
  copying.lastGain = copying.lastActivity = Date.now();
  try {
    while (pos < file.size) {
      // Two slice attempts, then one stream attempt, repeated.
      const useStream = tries % 3 === 2 && Boolean(file.stream);
      tries += 1;
      try {
        pos = await (useStream ? copyByStream : copyBySlices)(file, writable, pos, onProgress);
      } catch (err) {
        if (err instanceof StreamEnded) {
          copyLog += `, video ended at ${mb(err.copied)} of the reported ${mb(file.size)}`;
          pos = err.copied;
          break;
        }
        if (err instanceof CopyCancelled || err?.name === 'QuotaExceededError') throw err;
        if (err.copied > pos) pos = err.copied;
        // A slice that never answered won't do better next time: go to the stream straight away.
        if (!useStream && err?.name === 'TimeoutError') tries = Math.ceil((tries + 1) / 3) * 3 - 1;
        const note = `${useStream ? 'stream' : 'slices'} stopped at ${mb(pos)} (${err?.name})`;
        if (failures.at(-1) !== note) failures.push(note);
        if (Date.now() - copying.lastGain > STALL_LIMIT_MS) {
          copyLog += `, ${failures.slice(-4).join(', ')}, gave up after ${STALL_LIMIT_MS / 1000}s with no new data`;
          throw err;
        }
        await waitForPhone(Math.min(1000 * tries, 5000));
      }
    }
    await writable.close();
    const local = await handle.getFile();
    if (!local.size && file.size) throw new DOMException('the copy came out empty', 'NotReadableError');
    return local;
  } catch (err) {
    await writable.abort?.().catch(() => {});
    await removeLocalCopy();
    if (err instanceof CopyCancelled) throw err;
    if (err?.name === 'QuotaExceededError') {
      // Not enough free space for a copy: read the original directly instead.
      copyLog += ', not enough space for a copy';
      return file;
    }
    throw err;
  }
}

let removing = Promise.resolve();

function removeLocalCopy() {
  removing = removing.then(async () => {
    try {
      await (await privateDir())?.removeEntry(COPY_NAME);
    } catch { /* nothing to remove */ }
  });
  return removing;
}

// Copies are per tab, so only clear ones old enough that no tab can still be using them.
async function removeStaleCopies() {
  try {
    const dir = await privateDir();
    if (!dir?.entries) return;
    for await (const [name] of dir.entries()) {
      const made = Number(name.startsWith(COPY_PREFIX) && name.slice(COPY_PREFIX.length).split('-')[0]);
      if ((made && Date.now() - made > STALE_COPY_MS) || name === 'picked-video') {
        await dir.removeEntry(name).catch(() => {});
      }
    }
  } catch { /* best effort */ }
}

window.addEventListener('pagehide', () => { if (!job && !copying) removeLocalCopy(); });

// ---------- reading the chosen file ----------

async function inspect(file) {
  const input = new Input({ source: new BlobSource(file, FILE_READ_OPTIONS), formats: ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error('unsupported: no video track');
    if (!(await video.canDecode())) throw new CannotDecodeError();
    const audio = await input.getPrimaryAudioTrack();
    // Without an audio decoder (iOS before 26) the sound cannot be re-encoded, so it is dropped.
    const audioOk = Boolean(audio) && await audio.canDecode();
    const stats = await video.computePacketStats(120);
    const width = await video.getDisplayWidth();
    const height = await video.getDisplayHeight();
    const duration = await input.computeDuration();
    const fps = Math.round(stats.averagePacketRate) || 30;
    const notes = await sourceNotes(video, width, height, fps, duration, file.size);
    return {
      notes: audio && !audioOk
        ? `${notes} This device can't read this video's sound, so the result will have no audio.`.trim()
        : notes,
      file,
      duration,
      width,
      height,
      fps,
      hasAudio: audioOk,
    };
  } finally {
    input.dispose();
  }
}

async function sourceNotes(video, width, height, fps, duration, size) {
  const notes = [];
  try {
    const transfer = (await video.getColorSpace?.())?.transfer;
    if (transfer === 'hlg' || transfer === 'pq') {
      notes.push('This looks like an HDR video. Colours may look flat after shrinking.');
    }
  } catch { /* colour info is optional */ }
  if (Math.max(width, height) > 1920) {
    notes.push('This is a 4K video. It will be slow; trimming helps.');
  }
  if (width * height * fps > 3840 * 2160 * 30) notes.push('High frame rate at this size makes it slower still.');
  if (duration > 900 || size > 1e9) {
    notes.push('Long or large video: this can take several times the video length and needs the screen on. ' +
      'Trimming to the part you need is much faster.');
  }
  if (size > 2e9) notes.push('Very large file: choosing it may take a while. Consider trimming in Photos first.');
  return notes.join(' ');
}

class CannotDecodeError extends Error {}
class NoEncoderError extends Error {}

async function onFileChosen(file) {
  setMessage($('setupMsg'), '');
  source = null;
  copyLog = '';
  copying = { cancelled: false, lastGain: Date.now(), lastActivity: Date.now() };
  // While no data arrives, say so and count the seconds, so a slow phone doesn't look frozen.
  const ticker = setInterval(() => {
    const quiet = copying ? Math.floor((Date.now() - copying.lastActivity) / 1000) : 0;
    if (quiet >= 3) {
      $('workLabel').textContent = `Waiting for the phone to hand over the video... ${quiet}s ` +
        `(gives up after ${STALL_LIMIT_MS / 1000}s; videos picked from Files usually don't need to wait)`;
    }
  }, 1000);
  $('cancel').disabled = false;
  $('workLabel').textContent = 'Getting the video ready...';
  setProgress(0);
  show('work');
  try {
    const data = await makeLocalCopy(file, setProgress);
    source = await inspect(data);
    source.name = file.name;
  } catch (err) {
    if (err instanceof CopyCancelled) {
      startOver();
      return;
    }
    if (err instanceof CannotDecodeError) {
      fail("This phone can't decode this video's format. Try a video recorded with the normal camera app.");
    } else {
      fail(describeError(err), isReadError(err));
    }
    return;
  } finally {
    clearInterval(ticker);
    copying = null;
  }
  $('fileName').textContent = file.name;
  $('fileInfo').textContent = `${fmtMb(file.size)}, ${fmtTime(source.duration)}, ${source.width}x${source.height}`;
  $('trimStart').value = '0';
  $('trimEnd').value = source.duration.toFixed(1);
  $('trimBox').open = false;
  setMessage($('setupMsg'), source.notes);
  show('setup');
}

// ---------- encoding ----------

async function pickVideoCodec(plan) {
  const codec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], {
    width: plan.width, height: plan.height, bitrate: plan.videoBps,
  });
  if (!codec) throw new NoEncoderError();
  return codec;
}

async function ensureAacEncoder() {
  if (await canEncodeAudio('aac')) return;
  const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
  registerAacEncoder();
}

async function encodeOnce(plan, codec, trim) {
  const input = new Input({ source: new BlobSource(source.file, FILE_READ_OPTIONS), formats: ALL_FORMATS });
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  try {
    const conversion = await Conversion.init({
      input,
      output,
      trim,
      tags: {}, // drop all source metadata, including location
      showWarnings: false,
      video: {
        codec, width: plan.width, height: plan.height, fit: 'contain', frameRate: plan.fps,
        bitrate: plan.videoBps, keyFrameInterval: 2, forceTranscode: true,
      },
      audio: source.hasAudio
        ? { codec: 'aac', bitrate: plan.audioBps, numberOfChannels: 2, forceTranscode: true }
        : { discard: true },
    });
    if (job.cancelled) throw new ConversionCanceledError();
    if (!conversion.isValid) throw new Error('unsupported: this video cannot be converted here');
    job.conversion = conversion;
    conversion.onProgress = setProgress;
    await conversion.execute();
    return new Blob([output.target.buffer], { type: 'video/mp4' });
  } finally {
    input.dispose();
  }
}

function throwIfCancelled() {
  if (job.cancelled) throw new ConversionCanceledError();
}

function setProgress(fraction) {
  const pct = Math.min(100, Math.floor(fraction * 100));
  $('bar').value = pct;
  $('pct').textContent = `${pct}%`;
}

function readTrim() {
  const start = Math.max(0, Number($('trimStart').value) || 0);
  const end = Math.min(source.duration, Number($('trimEnd').value) || source.duration);
  return end - start >= 0.5 ? { start, end } : null;
}

function explainTooLong(plan, limitMb, start) {
  const best = Math.max(1, plan.maxDuration);
  const end = Math.floor((start + best) * 10) / 10 - 0.1;
  $('trimStart').value = String(start);
  $('trimEnd').value = Math.min(source.duration, Math.max(start + 1, end)).toFixed(1);
  $('trimBox').open = true;
  setMessage($('setupMsg'),
    `This part is too long to look decent in ${limitMb} MB. The longest that works is about ${fmtTime(best)}. ` +
    'Trim is set to that length: press Shrink to use it, change the start time, or pick a larger limit.');
}

async function runShrink() {
  const limitMb = Number($('limit').value);
  const trim = readTrim();
  if (!trim) {
    setMessage($('setupMsg'), 'The trim range is too short. End must be later than start.');
    return;
  }
  const plan = planBudget({ ...source, duration: trim.end - trim.start, limitMb });
  if (!plan.ok) {
    explainTooLong(plan, limitMb, trim.start);
    return;
  }

  setMessage($('setupMsg'), '');
  job = { cancelled: false, conversion: null };
  hiddenDuringJob = false;
  $('cancel').disabled = false;
  $('workLabel').textContent = 'Shrinking...';
  setProgress(0);
  show('work');
  await holdScreenOn();

  try {
    await ensureAacEncoder();
    const codec = await pickVideoCodec(plan);
    throwIfCancelled();
    let blob = await encodeOnce(plan, codec, trim);
    if (blob.size > limitBytes(limitMb)) {
      $('workLabel').textContent = 'Slightly too big, redoing at lower quality...';
      setProgress(0);
      throwIfCancelled();
      const lower = { ...plan, videoBps: retryVideoBps(plan.videoBps, blob.size, limitMb) };
      blob = null; // free the first result before the second encode
      blob = await encodeOnce(lower, codec, trim);
    }
    if (blob.size > limitBytes(limitMb)) {
      fail(`Even after a second try the result is ${fmtMb(blob.size)}, over the ${limitMb} MB limit. ` +
        'Trim the video shorter or choose a larger limit.');
      return;
    }
    showResult(blob, codec, limitMb);
  } catch (err) {
    fail(describeError(err), isReadError(err));
  } finally {
    job = null;
    releaseScreen();
  }
}

// ---------- result ----------

function showResult(blob, codec, limitMb) {
  const name = source.name.replace(/\.[^.]+$/, '') + '-discord.mp4';
  resultUrl = URL.createObjectURL(blob);
  $('preview').src = resultUrl;
  $('download').href = resultUrl;
  $('download').download = name;
  $('resultInfo').textContent = `Done: ${fmtMb(blob.size)} (limit ${limitMb} MB)`;
  setMessage($('codecNote'), codec === 'avc' ? '' :
    `This device can't encode H.264, so the video uses ${CODEC_LABEL[codec] ?? codec} instead. ` +
    'It may not preview inside Discord on every device.');

  const shareable = new File([blob], name, { type: 'video/mp4' });
  $('share').hidden = !navigator.canShare?.({ files: [shareable] });
  $('share').onclick = async () => {
    try {
      await navigator.share({ files: [shareable] });
    } catch (err) {
      if (err?.name !== 'AbortError') setMessage($('codecNote'), 'Sharing failed. Use Download instead.');
    }
  };
  show('result');
}

function startOver() {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
  $('preview').removeAttribute('src');
  $('file').value = '';
  source = null;
  removeLocalCopy();
  show('pick');
}

// ---------- wiring ----------

function init() {
  const problem = environmentProblem();
  if (problem) {
    setMessage($('fatal'), problem);
    $('choose').disabled = true;
    return;
  }
  $('choose').onclick = () => $('file').click();
  // The plain file chooser (no video filter) opens Android's Files app instead of the photo picker,
  // which hands over a real file and avoids Google Photos' cloud copies.
  $('chooseFiles').onclick = () => {
    $('file').removeAttribute('accept');
    $('file').value = '';
    $('file').click();
  };
  $('file').onchange = (e) => {
    const file = e.target.files[0];
    $('file').setAttribute('accept', 'video/*');
    if (file) onFileChosen(file);
  };
  $('shrink').onclick = runShrink;
  $('cancel').onclick = () => {
    if (copying) {
      copying.cancelled = true;
      $('cancel').disabled = true;
      $('workLabel').textContent = 'Cancelling...';
      return;
    }
    if (!job) return;
    job.cancelled = true;
    $('cancel').disabled = true;
    $('workLabel').textContent = 'Cancelling...';
    job.conversion?.cancel();
  };
  $('startOver').onclick = startOver;
  removeStaleCopies();
  $('version').textContent = APP_VERSION;
  show('pick');
}

window.__appReady = true;
init();
