# Tesseract.js, for the map text scanner

Loaded only when a GM presses **Scan for place names** on a map (static/mapscan.js). Everything runs in the browser:
the map's picture is read on the GM's own device and nothing is sent anywhere.

| File | From | Licence |
|---|---|---|
| `tesseract.min.js`, `worker.min.js` | [tesseract.js](https://github.com/naptha/tesseract.js) 7.0.0 (npm `tesseract.js`, `dist/`) | Apache 2.0 (`LICENSE-tesseract.js.md`) |
| `tesseract-core-lstm.wasm.js`, `tesseract-core-simd-lstm.wasm.js`, `tesseract-core-relaxedsimd-lstm.wasm.js` | [tesseract.js-core](https://github.com/naptha/tesseract.js-core) 7.0.0, the Tesseract OCR engine built for WebAssembly; the worker picks the one the browser supports | Apache 2.0 (`LICENSE-tesseract.js-core`) |
| `eng.traineddata.gz` | English LSTM model, `4.0.0_best_int` from npm `@tesseract.js-data/eng` 1.0.0, which repackages [tesseract-ocr/tessdata_best](https://github.com/tesseract-ocr/tessdata_best) | Apache 2.0 |
