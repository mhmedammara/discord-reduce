# Shrink video for Discord

A web page that makes any video small enough to send on Discord without Nitro. Built for phones:

1. Open the link.
2. Tap **Choose a video**.
3. Wait for the bar to finish (keep the screen on).
4. Tap **Send to Discord**, pick Discord and the chat.

Everything happens **on your own device**. The video is never uploaded anywhere, and there is nothing to install.

Default limit is **20 MB** (Discord's free limit since August 2026, per news reports; Discord's own help page wasn't reachable when this was written, so double-check it). A dropdown offers 10 MB in case 20 MB is rejected for you, and 50 MB for Nitro Basic. Very long videos get blurry at 10 MB, so the page offers to trim them first. Discord now measures the size of the file before the phone app compresses it, so an original that looks small enough can still be rejected.

## Put it online (one time)

The page is plain static files. The simplest free host is GitHub Pages:

1. Merge this branch into `main` (or keep using the branch).
2. Repo **Settings → Pages → Build and deployment → Deploy from a branch**, pick the branch and `/ (root)`.
3. After a minute the site is at `https://<your-user>.github.io/discord-reduce/`. Post that link in your Discord server and pin it.

Free GitHub Pages needs a public repository. Cloudflare Pages or Netlify (drag the folder in) work too. It must be served over HTTPS: the video APIs the page uses are disabled on plain `http://` and on `file://`.

Friends can use "Add to Home Screen" in their browser menu to get an app icon.

## Supported browsers

| Device | Browser |
| --- | --- |
| iPhone / iPad | Safari, iOS 16.4 or newer |
| Android | Chrome |
| Computer | Chrome, Edge, Safari |

If a link opened inside Discord doesn't work, tap the menu and choose "Open in browser".

## How it works

`app.js` uses [Mediabunny](https://github.com/Vanilagy/mediabunny) (WebCodecs) to decode the video, scale it, re-encode it with the device's hardware H.264 encoder and write a fast-start MP4. `budget.js` works out the bitrate, resolution and frame rate that fit the limit (about 7% under it, for safety). If the first pass lands over the limit, it is redone once or twice at a lower bitrate. Sound that is already AAC is copied unchanged; otherwise it is re-encoded to AAC (the bundled WASM encoder is only loaded on browsers that lack a native one). Location and device tags are not copied into the result.

The result is handed to the system share sheet (`navigator.share`) so Discord appears directly; **Save** downloads it instead.

## Test it on a real phone

The automated tests run in desktop Chromium without H.264, so please check these once on devices after deploying:

1. iPhone: pick a video from Photos (ideally one shot in HDR) and a long one (>1 min). Check colours look normal in the result and **Send to Discord** lists Discord.
2. Android: same, from the Gallery.
3. Send the result in a Discord chat and play it on both phone and desktop.
4. Try with Discord's in-app browser (tap the link from inside Discord) and note if anything fails.
5. Lock the screen mid-shrink: it should pause and carry on when you come back.

## Development

```
node --test tests/budget.test.mjs   # sizing maths
node tests/e2e.mjs                  # needs ffmpeg/ffprobe and Playwright's Chromium
python3 -m http.server              # then open http://localhost:8000
```

`localhost` counts as a secure context, so the page works there. The end-to-end test shrinks generated clips in a phone-sized browser and checks the downloaded files with `ffprobe` (size, duration, orientation, audio, fast-start). Since headless Chromium cannot encode H.264, the page falls back to VP9-in-MP4 there.

## Third-party code

`vendor/` holds unmodified builds of `mediabunny` and `@mediabunny/aac-encoder` 1.62.1 (MPL-2.0, see `vendor/LICENSE-mediabunny.txt`; the AAC encoder is a WebAssembly build of FFmpeg's AAC encoder). Sources: <https://github.com/Vanilagy/mediabunny>.
