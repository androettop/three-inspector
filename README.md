# Three Inspector

A DevTools panel for [three.js](https://threejs.org), for Chrome and Firefox: browse the scene graph and tweak objects, materials and lights while the scene runs.

![Editing a material live](store/screenshots/2-materials.png)

## Features

- **Scene graph**: every object in the scene, with a filter, visibility toggles and a blink to find objects on the page.
- **Live editing**: transforms, materials, lights, cameras, morph targets, background, fog, tone mapping, exposure and shadows.
- **Details**: geometry attributes and triangle counts, texture thumbnails, `userData` and renderer stats.
- **Preview**: any object or group on its own, with a wireframe mode.
- **Export**: the selection as STL or 3MF.

Works with three.js r110 and later, with `WebGLRenderer` and `WebGPURenderer`, and with scenes inside iframes (in Firefox, only iframes from the same origin as the page).

<table>
  <tr>
    <td><img src="store/screenshots/3-morph-targets.png" alt="Morph targets"></td>
    <td><img src="store/screenshots/4-lights.png" alt="Lights"></td>
  </tr>
  <tr>
    <td align="center">Morph targets</td>
    <td align="center">Lights</td>
  </tr>
</table>

## Install

**Chrome**: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the repository folder.

**Firefox**: open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and pick `manifest.json`.

## Usage

1. Open DevTools on a page that uses three.js and select the **Three** panel (it may be under `»`).
2. If the 3D view only renders when you interact with it, orbit or zoom once.
3. Click an object in the tree to see and edit its properties. Double-click it to make it blink on the page.

## How it works

Nothing runs until you open the panel. Then a small agent is added to the page and briefly patches a few functions that a rendering three.js app calls every frame (property lookups on `Object.prototype`, `Array.prototype.sort`, `Function.prototype.call`/`apply`). The first three.js object it sees leads to the scene, and every patch is removed right after. **Rescan** searches again.

The extension asks for no permissions, makes no network requests and collects no data. See [PRIVACY.md](PRIVACY.md).

## Development

```bash
cd test
npm install
npm run build          # test pages + sample models
npm run serve &        # 127.0.0.1:8701 and :8702
npm test               # drives the real DevTools panel in Chrome
node firefox.cjs       # same in Firefox (WebGL needs a display: set DISPLAY)
node screenshots.cjs   # regenerates store/screenshots
```

`scripts/package.sh` builds the zip for the Chrome Web Store and Firefox Add-ons. The listing texts are in [store/listing.md](store/listing.md).

## License

[MIT](LICENSE). Includes [three.js](https://github.com/mrdoob/three.js) (MIT) in `vendor/three`.
