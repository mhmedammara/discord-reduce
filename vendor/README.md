# Vendored libraries

Unmodified builds from npm, so the page never loads code from a third-party server:

| File | Package | Version | License |
| --- | --- | --- | --- |
| `mediabunny.min.mjs` | [`mediabunny`](https://www.npmjs.com/package/mediabunny) (`dist/bundles/mediabunny.min.mjs`) | 1.62.1 | MPL-2.0 (`LICENSE-mediabunny.txt`) |
| `mediabunny-aac-encoder.min.mjs` | [`@mediabunny/aac-encoder`](https://www.npmjs.com/package/@mediabunny/aac-encoder) (`dist/bundles/mediabunny-aac-encoder.min.mjs`) | 1.62.1 | MPL-2.0; WebAssembly build of FFmpeg's AAC encoder |

Source: <https://github.com/Vanilagy/mediabunny>.

`SHA256SUMS` pins the exact bytes (`node --test tests/vendor.test.mjs` checks it). To update a library, install the new version with npm in a scratch folder, copy the two bundle files here, run `sha256sum mediabunny.min.mjs mediabunny-aac-encoder.min.mjs LICENSE-mediabunny.txt > SHA256SUMS`, bump `version.js`, and re-run the tests.
