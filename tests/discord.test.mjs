import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeHook, decodeHook, parseThreadId, isWebhookUrl, safeUsername, postToThread, captureHookFromLocation, describeHook, sameHook, loadHook, saveHook, forgetHook, PostError } from '../discord.mjs';

const URL_OK = 'https://discord.com/api/webhooks/123456789012345678/abc_DEF-ghi123';
const hook = { url: URL_OK, threadId: '1477264432139731097' };

test('thread ids from links or plain numbers', () => {
  assert.equal(parseThreadId('https://discord.com/channels/1439938864310390901/1477264432139731097'), '1477264432139731097');
  assert.equal(parseThreadId('  1477264432139731097 '), '1477264432139731097');
  assert.equal(parseThreadId('https://discord.com/channels/1/2/3'), '2'); // a message link: the middle number is the thread
  assert.equal(parseThreadId('hello'), '');
});

test('webhook url validation', () => {
  assert.ok(isWebhookUrl(URL_OK));
  assert.ok(isWebhookUrl('https://canary.discord.com/api/webhooks/1/x'));
  assert.ok(!isWebhookUrl('http://discord.com/api/webhooks/1/x'));
  assert.ok(!isWebhookUrl('https://evil.example/api/webhooks/1/x'));
  assert.ok(!isWebhookUrl('https://discord.com/channels/1/2'));
});

test('hook round-trips through the link format', () => {
  const s = encodeHook({ url: URL_OK + '?thread_id=9', threadId: 'https://discord.com/channels/1/1477264432139731097' });
  assert.match(s, /^[\w-]+$/);
  assert.deepEqual(decodeHook(s), hook);
  assert.equal(encodeHook({ url: 'nope', threadId: '123456' }), null);
  assert.equal(encodeHook({ url: URL_OK, threadId: 'x' }), null);
  assert.equal(decodeHook('garbage!'), null);
  assert.equal(decodeHook(''), null);
});

test('a hook in the address bar is read and removed, but never saved without asking', () => {
  forgetHook();
  const s = encodeHook(hook);
  const calls = [];
  const found = captureHookFromLocation({ hash: '#hook=' + s, pathname: '/discord-reduce/', search: '' }, { replaceState: (...a) => calls.push(a) });
  assert.deepEqual(found, hook);
  assert.equal(loadHook(), null, 'not stored until the user connects');
  assert.deepEqual(calls[0], [null, '', '/discord-reduce/']);
  assert.equal(captureHookFromLocation({ hash: '', pathname: '/', search: '' }, { replaceState() {} }), null);
  assert.equal(captureHookFromLocation({ hash: '#hook=%%%', pathname: '/', search: '' }, { replaceState() {} }), null);
  saveHook(hook);
  assert.deepEqual(loadHook(), hook);
  forgetHook();
  assert.equal(loadHook(), null);
});

test('threads are labelled by their last digits only', () => {
  assert.equal(describeHook(hook), '…1097');
  assert.ok(!describeHook(hook).includes('abc_DEF'));
  assert.ok(sameHook(hook, { ...hook }));
  assert.ok(!sameHook(hook, { ...hook, threadId: '1' }));
  assert.ok(!sameHook(hook, null));
});

test('usernames Discord would reject are dropped', () => {
  assert.equal(safeUsername('  Sam   Lee '), 'Sam Lee');
  assert.equal(safeUsername('my discord'), '');
  assert.equal(safeUsername(''), '');
});

function fakeServer(statuses) {
  const seen = [];
  return { seen, post: async (url, form) => { seen.push({ url, form }); const s = statuses.shift() ?? 200; return typeof s === 'object' ? s : { status: s, text: '' }; } };
}
const file = new File([new Uint8Array(10)], 'clip-discord.mp4', { type: 'video/mp4' });
const noWait = () => Promise.resolve();

test('posts the file and caption with pings disabled', async () => {
  const srv = fakeServer([200]);
  await postToThread({ hook, username: 'Sam', content: 'hello', file, post: srv.post });
  const { url, form } = srv.seen[0];
  assert.match(url, /\?thread_id=1477264432139731097&wait=true$/);
  const payload = JSON.parse(form.get('payload_json'));
  assert.equal(payload.content, 'hello');
  assert.equal(payload.username, 'Sam');
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.deepEqual(payload.attachments, [{ id: 0, filename: 'clip-discord.mp4' }]);
  assert.equal(form.get('files[0]').name, 'clip-discord.mp4');
});

test('rate limits are waited out, then fail after repeated 429s', async () => {
  const waits = [];
  const srv = fakeServer([{ status: 429, text: '{"retry_after":1.5}' }, 200]);
  await postToThread({ hook, content: 'x', file, post: srv.post, wait: async (ms) => waits.push(ms) });
  assert.deepEqual(waits, [1500]);
  const bad = fakeServer([429, 429, 429]);
  await assert.rejects(postToThread({ hook, content: 'x', file, post: bad.post, wait: noWait }), (e) => e instanceof PostError && e.code === 'ratelimit');
});

test('error codes', async () => {
  for (const [status, code] of [[404, 'revoked'], [401, 'revoked'], [413, 'toobig'], [0, 'unconfirmed'], [500, 'rejected']]) {
    const srv = fakeServer([status]);
    await assert.rejects(postToThread({ hook, content: 'x', file, post: srv.post, wait: noWait }), (e) => e.code === code, String(status));
  }
});

test('a rejected username is retried with the name in the text', async () => {
  const srv = fakeServer([{ status: 400, text: '{"username":["bad"]}' }, 200]);
  await postToThread({ hook, username: 'Sam', content: 'hello', file, post: srv.post });
  const second = JSON.parse(srv.seen[1].form.get('payload_json'));
  assert.equal(second.username, undefined);
  assert.equal(second.content, '**Sam**\nhello');
});

test('no text is added when none is given', async () => {
  const srv = fakeServer([200]);
  await postToThread({ hook, username: 'Sam', file, post: srv.post });
  const payload = JSON.parse(srv.seen[0].form.get('payload_json'));
  assert.equal('content' in payload, false);
  assert.equal(payload.username, 'Sam');
  const retry = fakeServer([{ status: 400, text: '{"username":["bad"]}' }, 200]);
  await postToThread({ hook, username: 'Sam', file, post: retry.post });
  assert.equal(JSON.parse(retry.seen[1].form.get('payload_json')).content, '**Sam**');
});
