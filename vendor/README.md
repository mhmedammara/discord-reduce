# Vendored dependencies

Copied unmodified from the npm registry tarballs (no runtime CDN):

| File | Package | Version | License |
|------|---------|---------|---------|
| mediabunny.min.mjs | mediabunny (`dist/bundles/mediabunny.min.mjs`) | 1.63.0 | MPL-2.0 |
| mediabunny-aac-encoder.min.mjs | @mediabunny/aac-encoder (`dist/bundles/mediabunny-aac-encoder.min.mjs`) | 1.63.0 | MPL-2.0 |

The AAC encoder (libavcodec compiled to WASM, embedded in the file) is only used
when the browser has no native AAC encoder. It imports the bare specifier
`mediabunny`, which `index.html` maps to `vendor/mediabunny.min.mjs` with an import map.

Integrity: `SHA256SUMS` lists the hashes; `npm test` verifies them.
Upstream: https://github.com/Vanilagy/mediabunny
