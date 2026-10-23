# Shrink video for Discord

A web page that makes videos small enough to send on Discord without Nitro. Built for phones:

1. Open the link.
2. Tap **Choose videos** (one or several).
3. Wait for the bar to finish (keep the screen on).
4. Tap **Post to the thread**, or **Send with the share sheet** and pick Discord.

Everything is shrunk **on your own device**. Nothing is uploaded unless you tap Post or Send, and there is nothing to install.

- **Size limit:** default **20 MB** (Discord's free limit since August 2026, per news reports; Discord's own help page wasn't reachable when this was written, so double-check it). The dropdown also offers 10 MB, in case 20 MB is rejected for you, and 50 MB for Nitro Basic.
- **Long videos:** if a clip would come out soft, the page offers to **split it into sharp parts** (the default button) or keep it as one softer video, and you can trim first.
- **Concert sound:** the sound keeps 128 kbps where the size allows.
- **Privacy:** location and device info in the original are *not* copied into the shrunk file.
- **Works offline** once opened one time.

## Put it online (one time)

The page is plain static files, so no server is needed. Free options:

- **GitHub Pages:** repo **Settings → Pages → Deploy from a branch → `main` / `(root)`**. Site: `https://<user>.github.io/discord-reduce/`. Needs a public repo (or a paid plan).
- **Cloudflare Pages** (also free): connect the repo, no build command, output folder `/`. Site: `https://<project>.pages.dev`. It also applies the security headers in `_headers`.

It must be served over HTTPS: the video APIs it uses are disabled on plain `http://` and `file://`.

**Same-origin note for GitHub Pages:** every project under `<user>.github.io` shares one browser origin, so another site hosted there could read the saved thread link from your friends' browsers. If you host other sites on that account, use Cloudflare Pages or a custom domain for this one.

## Post straight to your thread (optional)

Without this, friends use the share sheet. With it, they tap one button and the video lands in the thread.

1. In Discord on a computer: **Server Settings → Integrations → Webhooks → New Webhook**, pick the channel the thread is in, **Copy Webhook URL**. (You need the Manage Webhooks permission.)
2. Copy the link to the thread (long-press or right-click the thread → **Copy Link**).
3. Open `setup.html` on your site, paste both, press **Make the link**, then **Send a test message**. If the test shows up in the thread, share the link it made with your friends. Opening it asks them to **Connect** once.

**Treat the link like a password.** Anyone who has it can post into that one thread (and nothing else). It never goes in this repository. It travels in the part of the address after `#`, which browsers don't send to servers. If it leaks, delete the webhook in Discord and make a new link.

Things to know:
- Posts appear from the webhook, under the name each friend types, so anyone with the link could use any name.
- Mentions are switched off for posts (`@everyone` is just text).
- Keep the thread from auto-archiving, or posts may fail.
- The page asks before connecting a link, shows the last digits of the thread, and never replaces an existing connection silently. Anyone can craft a link that points at *their* webhook, so friends should only connect links from you.

## Supported browsers

| Device | Browser |
| --- | --- |
| iPhone / iPad | Safari, iOS 16.4 or newer |
| Android | Chrome |
| Computer | Chrome, Edge, Safari |

If a link opened inside Discord doesn't work, tap the menu and choose "Open in browser".

## How it works

`app.js` uses [Mediabunny](https://github.com/Vanilagy/mediabunny) (WebCodecs) to decode the video, scale it, re-encode it with the device's hardware H.264 encoder and write a fast-start MP4. `budget.js` works out the bitrate, resolution and frame rate that fit the limit (about 7% under it). Before the real run a 4-second sample is encoded to see how the phone's encoder behaves, so the real run is usually right first time; if it still lands over the limit it is redone smaller. Sound that is already AAC is copied unchanged; otherwise it is re-encoded to AAC (a bundled WebAssembly encoder is used on browsers without one). `discord.mjs` posts it.

## Check an iPhone without owning one

Ask a friend to open `diag.html` on their phone and tap **Run the check**, then **Copy report** and paste it to you. It lists what their phone supports and runs a real 3-second encode with timing. They can also pick one video to inspect (codec, HDR, which metadata it carries; values are not shown). The footer of the main page shows the version.

Then, on the real site, ask them to:
1. Shrink one normal clip and one HDR/Dolby Vision clip (iPhone default), check colours look right, and play the result in Discord on phone and desktop.
2. Try **Post to the thread** and **Send with the share sheet**.
3. Tap the link from inside Discord and note whether anything fails there. The **Copy details** button on an error screen gives you something to paste.

## Development

```
npm test                      # unit tests: sizing, webhook, vendored files
node tests/e2e.mjs            # needs ffmpeg/ffprobe and Playwright's Chromium
python3 -m http.server        # then open http://localhost:8000
```

`localhost` counts as a secure context, so the page works there. The end-to-end test drives a phone-sized browser through shrink, split, batch, posting (against a fake Discord), connect prompts, offline use and the phone check, and verifies the output files with `ffprobe`. Headless Chromium cannot encode H.264, so there the page falls back to VP9-in-MP4; the H.264 path and iPhone behaviour need a real phone.

Bump `version.js` on every release (it names the offline cache and shows in the footer).

## Security notes

- No code is loaded from other sites; the libraries are vendored and pinned (`vendor/SHA256SUMS`, checked by a test). The page's Content-Security-Policy limits network requests to itself and Discord.
- Everything typed by users is inserted as text, and posts have mentions switched off.
- The service worker only handles this site's own files, never Discord traffic.

## Third-party code

`vendor/` holds unmodified builds of `mediabunny` and `@mediabunny/aac-encoder` 1.62.1 (MPL-2.0, see `vendor/README.md`; the AAC encoder is a WebAssembly build of FFmpeg's AAC encoder). Sources: <https://github.com/Vanilagy/mediabunny>.
