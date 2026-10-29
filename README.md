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

## Dependencies

Mediabunny and its AAC encoder are vendored in `vendor/` (see `vendor/README.md`, hashes in `vendor/SHA256SUMS`). Chosen over a hand-rolled approach because demuxing arbitrary phone files (MOV/MP4/HEVC, rotation, VFR) and muxing a correct fast-start MP4 is where dependency-free attempts break. An import map in `index.html` resolves the bare module names, so there is no bundler.

## Tests

    npm test

Uses `node --test` only (no dependencies). Covers the budget math and static checks (single-file input, vendor hashes).
