import {
  Input, BlobSource, ALL_FORMATS, Output, BufferTarget, Mp4OutputFormat, Conversion,
  ConversionCanceledError, canEncodeAudio, getFirstEncodableVideoCodec,
} from 'mediabunny';
import { planBudget, retryVideoBps, limitBytes } from './budget.js';

const $ = (id) => document.getElementById(id);
const SECTIONS = ['pick', 'setup', 'work', 'result', 'failure'];
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

function fail(text) {
  $('failureMsg').textContent = text;
  show('failure');
}

function describeError(err) {
  if (err instanceof ConversionCanceledError) return 'Cancelled. Nothing was saved.';
  const text = String(err?.message ?? err);
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

// ---------- reading the chosen file ----------

async function inspect(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
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
  try {
    source = await inspect(file);
  } catch (err) {
    fail(err instanceof CannotDecodeError
      ? "This phone can't decode this video's format. Try a video recorded with the normal camera app."
      : describeError(err));
    return;
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
  const input = new Input({ source: new BlobSource(source.file), formats: ALL_FORMATS });
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
    fail(describeError(err));
  } finally {
    job = null;
    releaseScreen();
  }
}

// ---------- result ----------

function showResult(blob, codec, limitMb) {
  const name = source.file.name.replace(/\.[^.]+$/, '') + '-discord.mp4';
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
  $('file').onchange = (e) => {
    const file = e.target.files[0];
    if (file) onFileChosen(file);
  };
  $('shrink').onclick = runShrink;
  $('cancel').onclick = () => {
    if (!job) return;
    job.cancelled = true;
    $('cancel').disabled = true;
    $('workLabel').textContent = 'Cancelling...';
    job.conversion?.cancel();
  };
  $('startOver').onclick = startOver;
  show('pick');
}

window.__appReady = true;
init();
