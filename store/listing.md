# Store listings

The same zip (`scripts/package.sh`) is uploaded to both stores.

# Chrome Web Store

## Store listing

**Name:** Three Inspector

**Summary** (from `manifest.json`, max 132 characters):
Inspect three.js scenes in DevTools: browse the scene graph and tweak objects, materials and lights live.

**Category:** Developer Tools

**Language:** English

**Description:**

```
Three Inspector adds a "Three" panel to Chrome DevTools for inspecting and tweaking three.js scenes while they run.

It works on any page that uses three.js. Open DevTools, pick the Three panel and, if the 3D view only renders on interaction, orbit or zoom it once.

FEATURES

• Scene graph: browse every object, filter by name or type, toggle visibility and make objects blink to find them on the page.
• Live editing: position, rotation and scale; material color, emissive, roughness, metalness, opacity, clearcoat, wireframe, side and more; light color, intensity and range; camera fov, near, far and zoom; morph target weights; scene background, fog and environment intensity; renderer tone mapping, exposure and shadows. Changes show up immediately, even in apps that only render on demand.
• Details: geometry type, attributes, index and triangle counts, texture thumbnails and sizes, userData, renderer draw calls and memory.
• Preview: look at any object or group on its own in a separate viewer, with a wireframe mode.
• Export: save the selection as STL or 3MF.
• Compatibility: three.js r110 and later, WebGLRenderer and WebGPURenderer, and scenes inside iframes. Also available for Firefox.

PRIVACY

No permissions, no data collection and no network requests. Everything runs locally inside DevTools, only on the page you are inspecting and only while the panel is open.

Three Inspector is an independent project and is not affiliated with three.js. Only export models you own or have permission to use.
```

**Graphic assets:**

| Asset | File |
|---|---|
| Store icon (128×128) | `icons/128.png` |
| Screenshots (1280×800) | `store/screenshots/1-scene-graph.png` … `5-scene-renderer.png` |
| Small promo tile (440×280) | `store/promo-small-440x280.png` |
| Marquee promo tile (1400×560) | `store/promo-marquee-1400x560.png` |

Screenshot captions, in order:

1. Browse the scene graph of any three.js page.
2. Tweak materials and see the result immediately.
3. Drive morph targets with sliders.
4. Adjust lights while the scene runs.
5. Change the background, fog, tone mapping and exposure.

**Homepage URL:** https://github.com/androettop/three-inspector (once the repository is public)

**Support URL:** https://github.com/androettop/three-inspector/issues

## Privacy practices

**Single purpose:**
Inspect and edit the three.js scenes of the page being debugged, from a Chrome DevTools panel.

**Permission justification:** the extension requests no permissions.

**Remote code:** No, I am not using remote code. All code, including three.js for the preview, is included in the package.

**Data usage:** the extension does not collect any of the listed data types. Certify the three disclosures (no selling, no unrelated use, no creditworthiness).

**Privacy policy URL:** https://github.com/androettop/three-inspector/blob/main/PRIVACY.md (once the repository is public)

# Firefox Add-ons (AMO)

**Name:** Three Inspector

**Add-on URL:** `three-inspector`

**Summary** (max 250 characters):
Inspect three.js scenes in DevTools: browse the scene graph and tweak objects, materials and lights live.

**Description:** same as the Chrome Web Store, with this compatibility line instead:

```
• Compatibility: three.js r110 and later, WebGLRenderer and WebGPURenderer, and scenes inside same-origin iframes (Firefox doesn't let extensions inspect cross-origin iframes).
```

**Categories:** Web Development

**License:** MIT

**Data collection:** none (declared in `manifest.json` under `browser_specific_settings.gecko.data_collection_permissions`).

**Privacy policy:** not needed, since no data is collected. Optionally paste the text of `PRIVACY.md`.

**Source code:** not needed. The package contains no minified or generated code besides three.js, which reviewers can compare with the official `three` npm release (`vendor/three` is r187, unmodified except for the import path in `OrbitControls.js`).

**Screenshots:** the same five images from `store/screenshots`.

`web-ext lint` reports no errors or warnings for the package.

## Package

```bash
scripts/package.sh    # writes dist/three-inspector-<version>.zip
```

The screenshots are generated with `test/screenshots.cjs` (needs `npm run build` and `npm run serve` in `test/`), and the promo tiles with `python3 store/promo.py`.
