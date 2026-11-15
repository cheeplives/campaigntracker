# Owlbear Rodeo SDK, as one plain script

`owlbear-sdk.js` is the Owlbear Rodeo SDK 3.1.0 (npm `@owlbear-rodeo/sdk`, MIT, see `LICENSE`) with its few
dependencies, bundled so the panel can load it with a script tag (this site has no build step). It sets `window.OBR`.
static/owlbear.js loads it only when Owlbear Rodeo is framing panel.html.

To rebuild it (for example when updating the SDK), in an empty folder outside the repository:

```sh
npm init -y && npm i @owlbear-rodeo/sdk@3.1.0 esbuild@0.28
echo 'import OBR from "@owlbear-rodeo/sdk"; window.OBR = OBR;' > entry.js
npx esbuild entry.js --bundle --minify --format=iife --target=es2019 --legal-comments=inline --outfile=owlbear-sdk.js
```
