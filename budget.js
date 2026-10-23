/*
 * Sizing maths for discord-reduce: given a video and a size limit, decide the
 * bitrate, resolution and frame rate to encode at. Pure functions only (no DOM,
 * no media APIs) so they can be unit-tested in Node:  node --test tests/
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DRBudget = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Aim this far below the limit: container overhead and encoder drift eat a few percent.
  const SAFETY = 0.93;
  // A finished file is accepted if it is under this fraction of the limit.
  const ACCEPT = 0.99;
  // A source this close to the limit is sent as-is instead of being re-encoded.
  const ALREADY_FITS = 0.97;
  // Hardware encoders rarely hit the requested bitrate exactly; start a little low.
  const FIRST_PASS = 0.95;

  // Output sizes by short side in pixels (so portrait and landscape behave alike).
  const TIERS = [1080, 720, 540, 480, 360, 240];
  const MIN_PREFERRED_TIER = 360; // only go below this after dropping the frame rate
  const LOW_FPS = 15;
  const MAX_FPS = 30;

  // Bits per pixel per frame. Below GOOD the picture turns visibly mushy.
  const BPP_GREAT = 0.1;
  const BPP_GOOD = 0.065;

  const even = (n) => Math.max(2, Math.round(n / 2) * 2);

  function targetBytes(limitMB) {
    return Math.floor(limitMB * 1e6 * SAFETY);
  }
  function acceptBytes(limitMB) {
    return Math.floor(limitMB * 1e6 * ACCEPT);
  }
  function fitsAlready(sizeBytes, limitMB) {
    return sizeBytes <= limitMB * 1e6 * ALREADY_FITS;
  }

  /**
   * Pick the audio settings for a given total bitrate budget (bits/s).
   * srcAudio: null | { codec, bitrate, channels }. Returns null for "no audio".
   * `copy` means the source AAC can be passed through untouched.
   */
  function planAudio(totalBps, srcAudio, noCopy = false, concert = false) {
    if (!srcAudio) return null;
    // Concert mode keeps the sound sharp: music is the point, so it gets a bigger slice of the budget.
    const tier = concert
      ? totalBps >= 1.2e6 ? 128000 : totalBps >= 6e5 ? 96000 : totalBps >= 3e5 ? 64000 : 40000
      : totalBps >= 1.2e6 ? 96000 : totalBps >= 6e5 ? 64000 : 40000;
    const srcChannels = srcAudio.channels || 2;
    const channels = tier <= 40000 ? 1 : Math.min(2, srcChannels);
    const srcBitrate = srcAudio.bitrate || 0;
    if (!noCopy && srcAudio.codec === 'aac' && srcBitrate > 0 && srcBitrate <= tier * 1.3 && channels === Math.min(2, srcChannels)) {
      return { copy: true, bitrate: srcBitrate, channels: srcChannels };
    }
    const wanted = srcBitrate > 0 ? Math.min(tier, srcBitrate) : tier;
    return { copy: false, bitrate: Math.max(32000, wanted), channels };
  }

  /**
   * Choose resolution and frame rate for a video bitrate (bits/s).
   * src: { width, height, fps } where width/height are display dimensions.
   */
  function layoutFor(videoBps, src) {
    const short = Math.min(src.width, src.height);
    const srcFps = src.fps > 0 ? src.fps : 30;
    const capFps = Math.min(Math.round(srcFps), MAX_FPS);

    // Candidate short sides: the native size (if it is at most 1080) and every tier below it.
    const sides = [];
    if (short <= TIERS[0]) sides.push(short);
    for (const t of TIERS) if (t < short) sides.push(t);

    const make = (side, fps) => {
      const k = side >= short ? 1 : side / short;
      const width = side >= short ? even(src.width) : even(src.width * k);
      const height = side >= short ? even(src.height) : even(src.height * k);
      const bpp = videoBps / (width * height * fps);
      return {
        width,
        height,
        fps,
        // Only ask the encoder to resample when we actually lower the rate.
        frameRate: fps < Math.round(srcFps) ? fps : undefined,
        bpp,
        quality: bpp >= BPP_GREAT ? 'great' : bpp >= BPP_GOOD ? 'good' : 'low',
      };
    };

    const preferred = sides.filter((s) => s >= Math.min(MIN_PREFERRED_TIER, short));
    for (const side of preferred) {
      const l = make(side, capFps);
      if (l.bpp >= BPP_GOOD) return l;
    }
    if (capFps > LOW_FPS) {
      for (const side of sides.filter((s) => s <= MIN_PREFERRED_TIER || s === short)) {
        const l = make(side, LOW_FPS);
        if (l.bpp >= BPP_GOOD) return l;
      }
      return make(sides[sides.length - 1], LOW_FPS);
    }
    return make(sides[sides.length - 1], capFps);
  }

  /**
   * Full plan for one video.
   * opts: { duration (s), limitMB, width, height, fps, audio: null | {codec,bitrate,channels},
   *          noCopy?: true when the audio has to be re-encoded anyway (e.g. trimmed from a later start),
   *          concert?: true to give the sound a bigger share }
   */
  function plan(opts) {
    const duration = Math.max(0.1, opts.duration);
    const target = targetBytes(opts.limitMB);
    const totalBps = (target * 8) / duration;
    const audio = planAudio(totalBps, opts.audio, opts.noCopy, opts.concert);
    const audioBps = audio ? audio.bitrate : 0;
    const videoBps = Math.max(20000, Math.floor((totalBps - audioBps) * FIRST_PASS));
    return {
      targetBytes: target,
      acceptBytes: acceptBytes(opts.limitMB),
      audio,
      videoBitrate: videoBps,
      ...layoutFor(videoBps, { width: opts.width, height: opts.height, fps: opts.fps }),
    };
  }

  /** New video bitrate after an attempt came out too big. */
  function retryVideoBitrate(prevVideoBps, targetBytesWanted, actualBytes) {
    const factor = Math.min(0.97, (targetBytesWanted / actualBytes) * 0.94);
    return Math.max(20000, Math.floor(prevVideoBps * factor));
  }

  /** Longest clip (seconds) that still gets a 'good' picture at this limit, even at the smallest size. */
  function maxGoodSeconds(limitMB, hasAudio = true, concert = false) {
    const audioBps = hasAudio ? (concert ? 64000 : 40000) : 0;
    const videoBpsNeeded = BPP_GOOD * 426 * 240 * 30; // 240p at 30 fps
    return Math.floor((targetBytes(limitMB) * 8) / ((videoBpsNeeded + audioBps) / FIRST_PASS));
  }

  /** Seconds per part when a long clip is split: each part gets a good 540p picture. Multiple of 15 s. */
  function splitLength(limitMB, concert = false) {
    const audioBps = concert ? 128000 : 96000;
    const videoBpsNeeded = BPP_GOOD * 960 * 540 * 30; // 540p at 30 fps
    const secs = (targetBytes(limitMB) * 8) / (videoBpsNeeded / FIRST_PASS + audioBps);
    return Math.max(15, Math.floor(secs / 15) * 15);
  }

  /** Split [start, end] into the fewest roughly equal parts no longer than splitLength. */
  function splitParts(start, end, limitMB, concert = false) {
    const total = end - start;
    const n = Math.max(1, Math.ceil(total / splitLength(limitMB, concert) - 1e-9));
    const parts = [];
    for (let i = 0; i < n; i++) {
      parts.push({
        start: Math.round((start + (total * i) / n) * 10) / 10,
        end: i === n - 1 ? end : Math.round((start + (total * (i + 1)) / n) * 10) / 10,
      });
    }
    return parts;
  }

  /**
   * Correct a planned video bitrate after encoding a short sample: measuredBps is what the encoder actually
   * produced. Overshoots are corrected fully; undershoots only partly, because a quiet sample may be easier
   * than the rest of the clip.
   */
  function calibrate(plannedBps, measuredBps) {
    if (!(measuredBps > 0)) return plannedBps;
    const r = Math.min(1.6, Math.max(0.5, measuredBps / plannedBps));
    const next = r > 1 ? (plannedBps / r) * 0.98 : plannedBps * Math.min(1.35, 1 + (1 / r - 1) * 0.6);
    return Math.max(20000, Math.floor(next));
  }

  function formatBytes(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + ' MB';
    return Math.max(1, Math.round(n / 1e3)) + ' KB';
  }

  function formatDuration(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (x) => String(x).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  return {
    SAFETY,
    targetBytes,
    acceptBytes,
    fitsAlready,
    planAudio,
    layoutFor,
    plan,
    retryVideoBitrate,
    maxGoodSeconds,
    splitLength,
    splitParts,
    calibrate,
    formatBytes,
    formatDuration,
  };
});
