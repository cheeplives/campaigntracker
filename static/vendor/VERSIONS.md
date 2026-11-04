# Vendored libraries

Every library under `static/vendor/` is a copy of a released build, served from this site so nothing loads from a CDN.
Check each one against its project's releases once a quarter (next: February 2027), and sooner when a security advisory
names it. When you update one, change its line here and its entry in `SOURCES` in `static/engine.js` (the About page).

| Folder | Library | Version | From | Licence | Notes |
|---|---|---|---|---|---|
| `leaflet/` | Leaflet | 1.9.4 | npm `leaflet` `dist/` | BSD-2-Clause | Maps |
| `pdfjs/` | PDF.js | 6.4.299 | npm `pdfjs-dist` `build/` (`pdf.min.mjs`, `pdf.worker.min.mjs`) | Apache-2.0 | Reads user-chosen PDFs in the page, so keep it current: CVE-2024-4367 was fixed in 4.2.67. Loaded with `isEvalSupported: false`; the CSP has no `unsafe-eval`. |
| `quill/` | Quill | 2.0.3 | npm `quill` `dist/` | BSD-3-Clause | Rich-text editor |
| `tesseract/` | tesseract.js | 7.0.0 | see `tesseract/README` | Apache-2.0 | Map text scanner |

Last checked: 4 November 2026.
