# Three Inspector

A Chrome extension that finds [three.js](https://threejs.org) scenes on any page — even when three.js is bundled, minified and never exposed as `window.THREE` — and exports their models to **STL** or **3MF**.

## Install

1. Clone this repository.
2. Open `chrome://extensions`, enable **Developer mode** and click **Load unpacked**.
3. Select the repository folder.

## Usage

1. Open a page with a three.js viewer and click the extension icon.
2. If the viewer only renders on demand, orbit or zoom once so it draws a frame.
3. Pick the meshes, set the scale (mm per scene unit — glTF models are usually in meters, so 1000) and export.

Nothing runs on page load. The inspector is injected only into the tab you click it on (`activeTab`), and only for as long as it takes to find the scene. If the model lives in a cross-origin iframe, the panel offers to request access to that origin only.

## How it works

three.js is usually loaded long before you click, so hooking constructors is not an option. Instead the inspector briefly patches a few hot paths that a rendering app goes through every frame or on every interaction:

- **Getter traps on `Object.prototype`** for flags such as `isLOD` and `isSprite`. The renderer reads them on every object it draws, and a plain mesh doesn't own them, so the lookup reaches the trap with the mesh as `this`. The getter returns `undefined`, exactly what the lookup would have returned.
- **`Array.prototype.sort`**, which render lists call on `{ object, geometry, material }` items.
- **`Function.prototype.call` / `apply`**, through which `EventDispatcher` delivers events such as OrbitControls' `change`.

The first `Object3D` found is walked up to its root (normally the `Scene`). The inspector keeps listening for 400 ms to pick up extra scenes, then restores every original. Frames without a `<canvas>` are never patched, and if nothing shows up within two minutes the patches are removed anyway. Press ⟳ in the panel to search again.

## Export

- World-space geometry from `BufferGeometry` (indexed or not, draw ranges, interleaved and normalized/quantized attributes) and legacy `Geometry` (< r125).
- Morph targets, skinned meshes (current pose), instanced meshes, and mirrored transforms (winding is fixed).
- Binary STL (everything merged) or 3MF (one object per mesh with its base color, or a single object).
- Optional Y-up → Z-up conversion for slicers.

Not supported: meshes whose vertex arrays were freed after upload to the GPU (shown as *GPU only*), `BatchedMesh`, vertex displacement done in shaders, and three.js running in a worker with `OffscreenCanvas`.

## Tests

The `test` folder bundles several three.js versions into minified pages that don't expose three.js, loads the extension in Chromium and exports from each page.

```bash
cd test
npm install
npm run build         # also downloads the Khronos sample models (Fox, Duck)
npm run serve &       # serves on 127.0.0.1:8701 and :8702 (cross-origin iframe)
npm test              # or: node run.cjs https://threejs.org/examples/webgl_loader_gltf.html
python3 check.py      # validates the exported files (needs trimesh)
```

Set `CHROMIUM_PATH` if Playwright can't find a Chromium build. The test pages cover:

- r187 with an animation loop, a skinned glTF, and an instanced mesh
- r187 rendering only on OrbitControls changes
- r110 with legacy `Geometry`, rendering only on mouse wheel
- r130 inside a cross-origin iframe, with one buffer freed after upload
- `WebGPURenderer`

## License

[MIT](LICENSE)
