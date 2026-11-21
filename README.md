# Three Inspector

A DevTools panel for [three.js](https://threejs.org). It finds the scenes on any page — even when three.js is bundled, minified and never exposed as `window.THREE` — and lets you:

- browse the scene graph, filter it and toggle visibility;
- inspect and edit objects live: transforms, materials, lights, cameras, morph targets, fog, renderer exposure and shadows;
- see geometry details, texture thumbnails, `userData` and renderer stats;
- preview any object or subtree in a separate viewer;
- export a selection to **STL** or **3MF**.

## Install

1. Clone this repository.
2. Open `chrome://extensions`, enable **Developer mode** and click **Load unpacked**.
3. Select the repository folder.

The extension asks for no permissions: it only runs inside DevTools, through `chrome.devtools.inspectedWindow`.

## Usage

1. Open DevTools on a page that uses three.js and pick the **Three** panel (it may be under `»`).
2. If the 3D view only renders on demand, orbit or zoom it once so it draws a frame.
3. Select objects in the tree to inspect and edit them. Double-click an object (or press **Blink**) to make it blink in the page.
4. Select a mesh, a group or the whole scene and export it. Scale is in millimeters per scene unit; glTF models are usually in meters, so 1000.

## How it finds three.js

Nothing runs until the panel is opened. three.js is usually loaded long before that, so hooking constructors is not an option. Instead the panel injects a small agent that briefly patches a few hot paths a rendering app goes through every frame or on every interaction:

- **Getter traps on `Object.prototype`** for flags such as `isLOD` and `isSprite`. The renderer reads them on every object it draws, and a plain mesh doesn't own them, so the lookup reaches the trap with the mesh as `this`. The getter returns `undefined`, exactly what the lookup would have returned.
- **`Array.prototype.sort`**, which render lists call on `{ object, geometry, material }` items.
- **`Function.prototype.call` / `apply`**, through which `EventDispatcher` delivers events such as OrbitControls' `change`.

The first `Object3D` found is walked up to its root (normally the `Scene`). The agent keeps listening for 400 ms to pick up extra scenes, then restores every original. To learn the renderer and camera, it sets a one-shot `onBeforeRender` on the scene and a few meshes; each one removes itself the first time it runs. With the renderer known, edits on apps that render on demand are drawn right away.

Frames without a `<canvas>` are never patched, and if nothing shows up within two minutes the patches are removed anyway. **Rescan** starts a new search.

## Export

- World-space geometry from `BufferGeometry` (indexed or not, draw ranges, interleaved and normalized/quantized attributes) and legacy `Geometry` (< r125).
- Morph targets, skinned meshes (current pose), instanced meshes, and mirrored transforms (winding is fixed).
- Binary STL (everything merged) or 3MF (one object per mesh with its base color, or a single object).
- Optional Y-up → Z-up conversion for slicers.

Not supported: meshes whose vertex arrays were freed after upload to the GPU (reported as having no CPU data), `BatchedMesh`, vertex displacement done in shaders, and three.js running in a worker with `OffscreenCanvas`.

Only export models you own or have permission to use.

## Tests

The `test` folder bundles several three.js versions into minified pages that don't expose three.js. The runner starts Chromium with the extension, opens DevTools on each page, drives the **Three** panel through the Chrome DevTools Protocol (edit a property, preview, export STL and 3MF) and checks that every patch was removed.

```bash
cd test
npm install
npm run build         # also downloads the Khronos sample models (Fox, Duck)
npm run serve &       # serves on 127.0.0.1:8701 and :8702 (cross-origin iframe)
npm test              # or: node run.cjs https://threejs.org/examples/webgl_loader_gltf.html
python3 check.py      # validates the exported files (needs trimesh)
```

Set `CHROMIUM_PATH` to use a specific Chromium build and `DOCK=bottom` to dock DevTools at the bottom. The test pages cover:

- r187 with an animation loop, a skinned glTF, and an instanced mesh
- r187 rendering only on OrbitControls changes
- r110 with legacy `Geometry`, rendering only on mouse wheel
- r130 inside a cross-origin iframe, with one buffer freed after upload
- `WebGPURenderer`

## License

[MIT](LICENSE). Includes [three.js](https://github.com/mrdoob/three.js) (MIT) in `vendor/three`.
