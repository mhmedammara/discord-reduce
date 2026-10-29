# Discord Video Shrinker

A static web page that shrinks ONE video so it fits Discord's upload limit (20 MB free limit by default; 10 or 50 MB also available). It runs entirely in the browser, built for iPhone Safari 16.4+ and Android Chrome. No server, no build step, nothing is uploaded. Location and other metadata are not copied into the result.

## Run locally

    python -m http.server 8000

Open http://localhost:8000. (Any static file server works. Opening index.html via file:// does not work: ES modules and WebCodecs need http(s).)

To test on a phone, you need HTTPS: deploy it (below) or use an HTTPS tunnel. A plain http://192.168.x.x address is NOT a secure context and WebCodecs is blocked there; the page says so.

## Deploy

- GitHub Pages: push this folder, then Settings > Pages > deploy from the main branch, root folder.
- Cloudflare Pages: connect the repo, framework preset "None", build command empty, output directory `/`.

Both serve HTTPS by default. There is no service worker, so there are no stale-cache problems.

## How it works

1. `Input` + `BlobSource` (Mediabunny) reads the file lazily; duration, size, frame rate and audio presence are probed.
2. `budget.js` (pure, unit-tested) turns duration + limit into video bitrate, resolution (short side 1080/720/540/480/360, never upscaled, even dimensions) and fps (max 30). Target is 93% of the limit. Audio is 128 kbps, dropping to 96/64 only when the video would otherwise be unwatchable. If it still cannot be watchable, the page shows the longest duration that works and pre-fills a trim range.
3. Mediabunny `Conversion` decodes and re-encodes with WebCodecs into a fast-start MP4 (H.264 + AAC). If the device cannot encode H.264 it uses the next codec it can (H.265, VP9, AV1) and says so. If the browser has no native AAC encoder, the vendored WASM AAC encoder is loaded.
4. If the result is over the limit it is redone once with a lower bitrate; if still over, the real size is shown as an error.

## Limits

- One video at a time. No hard size or duration cap; the page shows a soft warning above 15 minutes, 1 GB (slow, screen must stay on) and 2 GB (picking may be slow), and for 4K or 4K60 sources. These thresholds are estimates, not documented limits.
- Output limit: 10, 20 (default) or 50 MB, as chosen. Result is aimed at 93% of it.
- Documented: WebCodecs needs iOS/iPadOS 16.4+ or Chrome on Android; Firefox on Android has none. iOS before 26 has no AudioDecoder, so the sound is dropped there (Mediabunny discards undecodable audio tracks).
- Estimated: encode speed (roughly 0.5-2x realtime at 1080p on mid-range phones) and memory use (the result is held in memory, peak about 2x its size). Not tested on real phones.

## Dependencies

Mediabunny and its AAC encoder are vendored in `vendor/` (see `vendor/README.md`, hashes in `vendor/SHA256SUMS`). Chosen over a hand-rolled approach because demuxing arbitrary phone files (MOV/MP4/HEVC, rotation, VFR) and muxing a correct fast-start MP4 is where dependency-free attempts break. An import map in `index.html` resolves the bare module names, so there is no bundler.

## Tests

    npm test

Uses `node --test` only (no dependencies). Covers the budget math and static checks (single-file input, vendor hashes).
