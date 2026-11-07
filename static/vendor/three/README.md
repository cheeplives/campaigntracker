# three.js, trimmed for the dice

`three.dice.min.mjs` is three.js 0.186.1 (npm `three`, MIT, see `LICENSE`) cut down to the classes the 3D dice use
(static/dice-3d.js), so the browser loads about 130 KB (gzipped) instead of the whole library. It is loaded only the
first time 3D dice are thrown.

To rebuild it (for example when updating three.js), in an empty folder outside the repository:

```sh
npm init -y && npm i three@0.186.1 esbuild@0.25
cat > entry.js <<'JS'
export { WebGLRenderer, Scene, PerspectiveCamera, BufferGeometry, Float32BufferAttribute, Mesh, MeshStandardMaterial,
  CanvasTexture, AmbientLight, DirectionalLight, HemisphereLight, Quaternion, Vector3, PlaneGeometry, ShadowMaterial,
  SRGBColorSpace, PCFShadowMap } from 'three';
JS
npx esbuild entry.js --bundle --format=esm --minify --legal-comments=inline --outfile=three.dice.min.mjs
```

Add a class here if static/dice-3d.js starts using one that isn't in the list.
