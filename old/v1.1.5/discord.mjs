// Posting a finished video straight into one Discord thread through a webhook.
//
// The webhook URL is a secret: it never lives in the repo. The owner makes a link with setup.html that carries
// it in the URL fragment (#hook=...). The page stores it in localStorage and removes it from the address bar.

const HOOK_URL = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const STORE_KEY = 'dr-hook';

// ---------------------------------------------------------------- link format

const b64url = {
  enc: (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))),
};

/** Pull the thread ID out of a thread link (https://discord.com/channels/<guild>/<thread>) or a bare ID. */
export function parseThreadId(text) {
  const t = String(text || '').trim();
  if (/^\d{5,25}$/.test(t)) return t;
  const m = /discord(?:app)?\.com\/channels\/(?:\d+|@me)\/(\d+)(?:\/\d+)?\/?$/.exec(t);
  return m ? m[1] : '';
}

export function isWebhookUrl(url) {
  return HOOK_URL.test(String(url || '').trim());
}

/** { url, threadId } -> opaque string for the link fragment, or null if either part is invalid. */
export function encodeHook({ url, threadId }) {
  const u = String(url || '').trim().split('?')[0];
  const t = parseThreadId(threadId);
  if (!isWebhookUrl(u) || !t) return null;
  return b64url.enc(JSON.stringify({ u, t }));
}

export function decodeHook(text) {
  try {
    const { u, t } = JSON.parse(b64url.dec(String(text || '')));
    return isWebhookUrl(u) && /^\d{5,25}$/.test(t) ? { url: u, threadId: t } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- storage

let memoryHook = null;

export function loadHook() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return decodeHook(raw);
  } catch {}
  return memoryHook;
}

export function saveHook(hook) {
  memoryHook = hook;
  try {
    localStorage.setItem(STORE_KEY, encodeHook(hook));
  } catch {}
}

export function forgetHook() {
  memoryHook = null;
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {}
}

/**
 * If the page was opened from a setup link, return the webhook it carries and clean the address bar.
 * It is NOT saved here: anyone can make such a link, so the page must ask the user before connecting.
 */
export function captureHookFromLocation(loc = location, hist = history) {
  const m = /^#hook=([\w-]+)$/.exec(loc.hash);
  if (!m) return null;
  const hook = decodeHook(m[1]);
  try {
    hist.replaceState(null, '', loc.pathname + loc.search);
  } catch {}
  return hook;
}

/** Short, non-secret label for a thread so people can check they are connecting to the right one. */
export function describeHook(hook) {
  return '…' + String(hook.threadId).slice(-4);
}

export function sameHook(a, b) {
  return !!a && !!b && a.url === b.url && a.threadId === b.threadId;
}

// ---------------------------------------------------------------- posting

export class PostError extends Error {
  constructor(code, status, detail) {
    super(code);
    this.code = code; // 'revoked' | 'toobig' | 'ratelimit' | 'unconfirmed' | 'rejected'
    this.status = status;
    this.detail = detail;
  }
}

/** Discord rejects webhook names that contain certain words; send a safe one or none. */
export function safeUsername(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!n || /discord|clyde|everyone|here|system message/i.test(n)) return '';
  return n;
}

function xhrPost(url, form, onProgress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    if (onProgress && xhr.upload) xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = xhr.ontimeout = xhr.onabort = () => resolve({ status: 0, text: '' });
    xhr.send(form);
  });
}

/**
 * Post one message (optionally with one file) to the thread.
 * Resolves on success; throws PostError otherwise. A status of 0 means we could not read the answer, so the
 * message may or may not have been posted ('unconfirmed'): callers must not blindly retry.
 */
export async function postToThread({ hook, username, content, file, onProgress, post = xhrPost, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const endpoint = `${hook.url}?thread_id=${encodeURIComponent(hook.threadId)}&wait=true`;
  let name = safeUsername(username);

  for (let attempt = 0; attempt < 3; attempt++) {
    // No text is added by default; if Discord refuses the poster's name, it goes into the text instead.
    const text = name || !username ? content : `**${username}**${content ? '\n' + content : ''}`;
    const payload = { allowed_mentions: { parse: [] } };
    if (text) payload.content = text;
    if (name) payload.username = name;
    const form = new FormData();
    if (file) payload.attachments = [{ id: 0, filename: file.name }];
    form.append('payload_json', JSON.stringify(payload));
    if (file) form.append('files[0]', file, file.name);

    const res = await post(endpoint, form, onProgress);
    if (res.status >= 200 && res.status < 300) return;
    if (res.status === 0) throw new PostError('unconfirmed', 0);
    if (res.status === 404 || res.status === 401) throw new PostError('revoked', res.status);
    if (res.status === 413) throw new PostError('toobig', res.status);
    if (res.status === 429) {
      let seconds = 2;
      try {
        seconds = Math.min(30, Math.max(0.5, Number(JSON.parse(res.text).retry_after) || 2));
      } catch {}
      if (attempt === 2) throw new PostError('ratelimit', 429);
      await wait(seconds * 1000);
      continue;
    }
    if (res.status === 400 && name && /username/i.test(res.text)) {
      name = ''; // retry once with the webhook's own name, putting the poster's name in the text
      continue;
    }
    throw new PostError('rejected', res.status, res.text.slice(0, 300));
  }
  throw new PostError('ratelimit', 429);
}

export const POST_MESSAGES = {
  revoked: 'This link has been switched off. Ask whoever runs the server for a new one.',
  toobig: "Discord says the video is too big for this server. Pick a smaller size and try again.",
  ratelimit: 'Discord asked us to slow down. Wait a minute and try again.',
  unconfirmed: "We couldn't confirm it posted. Check the thread before trying again so it doesn't post twice.",
  rejected: 'Discord refused the post. Use "Send with the share sheet" instead.',
};
