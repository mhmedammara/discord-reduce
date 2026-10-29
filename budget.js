// Pure sizing math: no DOM, no I/O. Everything is in bits, bytes, seconds or pixels.

export const LIMITS_MB = [10, 20, 50];
export const SAFETY = 0.93; // aim ~7% under the chosen limit
export const AUDIO_STEPS = [128000, 96000, 64000];

const SHORT_SIDE_TIERS = [1080, 720, 540, 480, 360];
const MIN_BITS_PER_PIXEL = 0.07; // below this H.264 looks like mush
const MAX_FPS = 30;
const LOW_FPS = 24;

export function limitBytes(limitMb) {
  return limitMb * 1_000_000;
}

export function even(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

// Scale so the short side equals `shortSide`, never upscaling, keeping both sides even.
export function fitDimensions(width, height, shortSide) {
  const short = Math.min(width, height);
  const scale = Math.min(1, shortSide / short);
  return { width: even(width * scale), height: even(height * scale) };
}

function resolutionCandidates(width, height, srcFps) {
  const short = Math.min(width, height);
  let tiers = SHORT_SIDE_TIERS.filter((t) => t <= short);
  if (tiers.length === 0) tiers = [short];
  const fpsOptions = [...new Set([Math.min(srcFps, MAX_FPS), Math.min(srcFps, LOW_FPS)])];
  return tiers.flatMap((tier) =>
    fpsOptions.map((fps) => ({ ...fitDimensions(width, height, tier), fps })),
  );
}

function requiredVideoBps(c) {
  return MIN_BITS_PER_PIXEL * c.width * c.height * c.fps;
}

function pickCandidate(candidates, videoBps) {
  return candidates.find((c) => requiredVideoBps(c) <= videoBps) ?? null;
}

/**
 * @param {{duration:number, limitMb:number, width:number, height:number, fps?:number, hasAudio?:boolean}} p
 * Returns { ok:true, videoBps, audioBps, width, height, fps, targetBytes }
 * or { ok:false, maxDuration } when the clip would be unwatchable at this limit.
 */
export function planBudget({ duration, limitMb, width, height, fps = MAX_FPS, hasAudio = true }) {
  const targetBytes = Math.floor(limitBytes(limitMb) * SAFETY);
  const totalBps = (targetBytes * 8) / duration;
  const candidates = resolutionCandidates(width, height, fps);
  const audioSteps = hasAudio ? AUDIO_STEPS : [0];

  for (const audioBps of audioSteps) {
    const videoBps = Math.floor(totalBps - audioBps);
    const pick = pickCandidate(candidates, videoBps);
    if (pick) return { ok: true, videoBps, audioBps, targetBytes, ...pick };
  }

  const lowest = candidates[candidates.length - 1];
  const needBps = requiredVideoBps(lowest) + audioSteps[audioSteps.length - 1];
  return { ok: false, maxDuration: Math.floor((targetBytes * 8) / needBps) };
}

// Used when the first encode lands over the limit: scale bitrate by the observed overshoot.
export function retryVideoBps(videoBps, actualBytes, limitMb) {
  const ratio = (limitBytes(limitMb) * SAFETY) / actualBytes;
  return Math.floor(videoBps * Math.min(ratio, 1) * 0.95);
}
