// Three Inspector — page agent.
//
// Evaluated in the inspected page by the DevTools panel. It installs nothing
// until the panel calls arm(); then it briefly patches a few hot paths that a
// rendering three.js app goes through, grabs the scene, and restores every
// original:
//
//  1. Getter traps on Object.prototype for flags the renderer reads on every
//     object it projects but plain meshes don't own (isLOD, isSprite…). The
//     getter returns undefined — the value the lookup would produce anyway —
//     and records `this`.
//  2. Array.prototype.sort: render lists sort { object, geometry, … } items.
//  3. Function.prototype.call/apply: EventDispatcher listeners (OrbitControls
//     "change", etc.) and transpiled bundles pass three objects through here.
//
// Any Object3D found is walked up to its root (normally the Scene). To learn
// the renderer and camera, a one-shot onBeforeRender is set on the captured
// scene and a few meshes; each removes itself the first time it runs.
//
// Every public method returns plain JSON data: the panel reads results through
// chrome.devtools.inspectedWindow.eval.
(() => {
  const KEY = Symbol.for("threeInspector.agent");
  if (window[KEY]) return window[KEY].version;

  const VERSION = 1;
  const COLLECT_MS = 400;
  const GIVE_UP_MS = 120000;
  const MAX_TREE_NODES = 20000;
  const DEG = 180 / Math.PI;
  const reflectApply = Reflect.apply;
  const nativeCall = Function.prototype.call;
  const nativeApply = Function.prototype.apply;
  const nativeSort = Array.prototype.sort;

  const roots = new Set();
  const views = new Map(); // root -> { renderer, camera }
  let state = "idle"; // idle | nocanvas | searching | found | notfound
  let restore = null;
  let collectTimer = 0;
  let giveUpTimer = 0;
  let rejected = new WeakSet();
  let byId = new Map();
  let revisionSeen = null;

  /* ----------------------------- capture ----------------------------- */

  const isObject3D = (o) => !!o && typeof o === "object" && o.isObject3D === true && !!o.matrixWorld;

  function rootOf(o) {
    let r = o;
    for (let i = 0; i < 10000 && r.parent; i++) r = r.parent;
    return r;
  }

  function containsMesh(o) {
    const stack = [o];
    for (let n = 0; stack.length && n < 200000; n++) {
      const x = stack.pop();
      if (x.isMesh && x.geometry) return true;
      const ch = x.children;
      if (ch) for (let i = 0; i < ch.length; i++) stack.push(ch[i]);
    }
    return false;
  }

  // The renderer draws scene.background with its own detached box/plane mesh,
  // and WebGPURenderer uses a fullscreen QuadMesh: neither is part of the app.
  function isInternal(o) {
    if (o.isQuadMesh) return true;
    const m = o.isMesh && !o.parent && o.material;
    return !!m && /^Background(Cube)?Material$/.test(m.name || "");
  }

  let inCapture = false;
  function offer(o) {
    if (inCapture || state !== "searching") return;
    inCapture = true;
    try {
      if (isObject3D(o)) found(o);
      else if (o && typeof o === "object") {
        // Render items ({ object }), controls ({ object: camera })…
        if (isObject3D(o.object)) found(o.object);
        if (isObject3D(o.scene)) found(o.scene);
      }
    } catch (_) {
    } finally {
      inCapture = false;
    }
  }

  function found(o) {
    const root = rootOf(o);
    if (roots.has(root) || rejected.has(root)) {
      if (roots.has(root) && o.isMesh) watchRender(o, root);
      return;
    }
    if (isInternal(root) || !containsMesh(root)) return void rejected.add(root);
    roots.add(root);
    watchRender(root, root);
    if (o.isMesh) watchRender(o, root);
    if (!collectTimer) collectTimer = setTimeout(finishCapture, COLLECT_MS);
  }

  // One-shot onBeforeRender(renderer, scene, camera) on an object of `root`.
  const watched = new Map(); // object -> { hook, own }
  function watchRender(obj, root) {
    if (views.has(root) || watched.has(obj) || watched.size > 32) return;
    const own = Object.getOwnPropertyDescriptor(obj, "onBeforeRender");
    const prev = obj.onBeforeRender;
    const hook = function (renderer, scene, camera) {
      if (renderer && typeof renderer.render === "function" && !views.has(root))
        views.set(root, { renderer, camera: camera && camera.isCamera ? camera : null });
      unwatch(root);
      if (typeof prev === "function") return reflectApply(prev, this, arguments);
    };
    try {
      obj.onBeforeRender = hook;
      watched.set(obj, { hook, own, root });
    } catch (_) {}
  }

  function unwatch(root) {
    for (const [obj, w] of watched) {
      if (root && w.root !== root) continue;
      watched.delete(obj);
      if (obj.onBeforeRender !== w.hook) continue; // the app replaced it meanwhile
      try {
        if (w.own) Object.defineProperty(obj, "onBeforeRender", w.own);
        else delete obj.onBeforeRender;
      } catch (_) {}
    }
  }

  function install() {
    const undo = [];

    for (const prop of ["isLOD", "isSprite", "isImmediateRenderObject", "isBatchedMesh"]) {
      if (Object.prototype.hasOwnProperty.call(Object.prototype, prop)) continue;
      const desc = {
        configurable: true,
        enumerable: false,
        get() {
          if (this && this.isObject3D === true) offer(this);
          return undefined;
        },
        set(v) {
          // Behave like a plain assignment creating an own property.
          try {
            Object.defineProperty(this, prop, { value: v, writable: true, enumerable: true, configurable: true });
          } catch (_) {}
        },
      };
      Object.defineProperty(Object.prototype, prop, desc);
      undo.push(() => {
        const cur = Object.getOwnPropertyDescriptor(Object.prototype, prop);
        if (cur && cur.get === desc.get) delete Object.prototype[prop];
      });
    }

    const sort = function sort(cmp) {
      const first = this && this.length ? this[0] : null;
      if (first && typeof first === "object" && first.object && first.geometry) offer(first);
      return reflectApply(nativeSort, this, arguments);
    };
    Array.prototype.sort = sort;
    undo.push(() => {
      if (Array.prototype.sort === sort) Array.prototype.sort = nativeSort;
    });

    const call = function call(thisArg, ...args) {
      if (thisArg && typeof thisArg === "object") offer(thisArg);
      if (args.length && args[0] && typeof args[0] === "object") offer(args[0]);
      return reflectApply(nativeCall, this, [thisArg, ...args]);
    };
    const apply = function apply(thisArg, args) {
      if (thisArg && typeof thisArg === "object") offer(thisArg);
      return reflectApply(nativeApply, this, [thisArg, args]);
    };
    Function.prototype.call = call;
    Function.prototype.apply = apply;
    undo.push(() => {
      if (Function.prototype.call === call) Function.prototype.call = nativeCall;
      if (Function.prototype.apply === apply) Function.prototype.apply = nativeApply;
    });

    return () => undo.forEach((fn) => {
      try {
        fn();
      } catch (_) {}
    });
  }

  function uninstall() {
    if (restore) restore();
    restore = null;
    clearTimeout(collectTimer);
    clearTimeout(giveUpTimer);
    collectTimer = giveUpTimer = 0;
  }

  function finishCapture() {
    uninstall();
    state = "found";
  }

  function hasCanvas(node = document) {
    if (node.querySelector("canvas")) return true;
    for (const el of node.querySelectorAll("*")) if (el.shadowRoot && hasCanvas(el.shadowRoot)) return true;
    return false;
  }

  function arm() {
    uninstall();
    unwatch();
    roots.clear();
    views.clear();
    rejected = new WeakSet();
    if (!hasCanvas()) {
      state = "nocanvas";
      return status();
    }
    state = "searching";
    restore = install();
    giveUpTimer = setTimeout(() => {
      uninstall();
      state = roots.size ? "found" : "notfound";
    }, GIVE_UP_MS);
    // Many on-demand viewers re-render on resize; nudge them once.
    setTimeout(() => {
      if (state === "searching") window.dispatchEvent(new Event("resize"));
    }, 300);
    return status();
  }

  // A root captured early may have been added to a scene since (a glTF group
  // loaded before scene.add), and renderer internals (PMREM, background) draw
  // lone meshes: keep only current, meaningful roots.
  function normalizeRoots() {
    for (const r of [...roots]) {
      const top = rootOf(r);
      if (top === r) continue;
      roots.delete(r);
      const v = views.get(r);
      views.delete(r);
      if (isInternal(top)) continue;
      roots.add(top);
      if (v && !views.has(top)) views.set(top, v);
    }
    if ([...roots].some((r) => r.isScene))
      for (const r of [...roots])
        if (!r.isScene && r.isMesh && !(r.children && r.children.length)) {
          roots.delete(r);
          views.delete(r);
        }
  }

  function status() {
    normalizeRoots();
    let objects = 0;
    let signature = 0;
    for (const r of roots)
      traverse(r, (o) => {
        objects++;
        signature = (signature * 31 + (o.id | 0) + (o.visible ? 1 : 0)) | 0;
      });
    revisionSeen = window.__THREE__ || revisionSeen;
    return {
      state,
      url: location.href,
      revision: revisionSeen,
      roots: roots.size,
      objects,
      signature,
      renderers: new Set([...roots].map((r) => views.get(r) && views.get(r).renderer).filter(Boolean)).size,
      patched: !!restore,
    };
  }

  /* ----------------------------- helpers ----------------------------- */

  function traverse(o, fn) {
    const stack = [o];
    while (stack.length) {
      const x = stack.pop();
      fn(x);
      const ch = x.children;
      if (ch) for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i]);
    }
  }

  function idOf(o) {
    return o.uuid || "id" + o.id;
  }

  function lookup(id) {
    let o = byId.get(id);
    if (o) return o;
    for (const r of roots) traverse(r, (x) => byId.set(idOf(x), x));
    return byId.get(id) || null;
  }

  function rootFor(o) {
    const r = rootOf(o);
    return roots.has(r) ? r : null;
  }

  function kindOf(o) {
    if (o.isScene) return "scene";
    if (o.isSkinnedMesh) return "skinned";
    if (o.isInstancedMesh) return "instanced";
    if (o.isMesh) return "mesh";
    if (o.isLight) return "light";
    if (o.isCamera) return "camera";
    if (o.isBone) return "bone";
    if (o.isPoints) return "points";
    if (o.isLine) return "line";
    if (o.isSprite) return "sprite";
    return "object";
  }

  const isExportable = (o) => !!(o.isMesh && o.geometry && !o.isBatchedMesh);

  /* ------------------------------ tree ------------------------------- */

  function tree() {
    normalizeRoots();
    byId = new Map();
    let count = 0;
    let truncated = false;
    const node = (o) => {
      const id = idOf(o);
      byId.set(id, o);
      count++;
      const n = { id, name: o.name || "", type: o.type || "Object3D", kind: kindOf(o), visible: o.visible !== false };
      if (isExportable(o)) n.tris = triangleCount(o);
      const ch = o.children || [];
      if (ch.length) {
        n.children = [];
        for (const c of ch) {
          if (count >= MAX_TREE_NODES) {
            truncated = true;
            break;
          }
          n.children.push(node(c));
        }
      }
      return n;
    };
    const out = [];
    for (const r of roots) {
      const v = views.get(r);
      const n = node(r);
      n.rendered = !!v;
      out.push(n);
    }
    return { roots: out, truncated, count };
  }

  /* --------------------------- properties ---------------------------- */

  const SIDES = ["Front", "Back", "Double"];
  const TEXTURE_SLOTS = [
    "map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap", "alphaMap",
    "bumpMap", "displacementMap", "lightMap", "envMap", "specularMap", "clearcoatMap", "transmissionMap",
  ];
  const thumbs = new WeakMap();

  function colorHex(c) {
    if (!c || typeof c.r !== "number") return null;
    if (c.getHexString) return "#" + c.getHexString();
    const h = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
    return "#" + h(c.r) + h(c.g) + h(c.b);
  }

  function vec(v) {
    return [v.x, v.y, v.z];
  }

  function textureKind(t) {
    for (const k of ["CubeTexture", "CanvasTexture", "VideoTexture", "DataTexture", "CompressedTexture", "DepthTexture", "Data3DTexture", "DataArrayTexture"])
      if (t["is" + k]) return k;
    return "Texture";
  }

  function textureInfo(t) {
    if (!t) return null;
    const img = t.image || (t.source && t.source.data);
    const w = img && (img.naturalWidth || img.videoWidth || img.width);
    const h = img && (img.naturalHeight || img.videoHeight || img.height);
    let thumb = thumbs.get(t);
    if (thumb === undefined) {
      thumb = null;
      try {
        if (img && w && h && (img instanceof HTMLImageElement || img instanceof HTMLCanvasElement || img instanceof ImageBitmap || img instanceof HTMLVideoElement)) {
          const s = Math.min(1, 96 / Math.max(w, h));
          const c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(w * s));
          c.height = Math.max(1, Math.round(h * s));
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          thumb = c.toDataURL("image/png"); // throws on cross-origin (tainted) images
        }
      } catch (_) {
        thumb = null;
      }
      thumbs.set(t, thumb);
    }
    const size = w && h ? ` ${w}×${h}` : "";
    return { text: `${textureKind(t)}${size}${t.name ? " · " + t.name : ""}`, thumb };
  }

  function props(id) {
    const o = lookup(id);
    if (!o) return null;
    const sections = [];
    const f = (path, label, type, value, extra) => ({ path, label, type, value, ...extra });

    const obj = [
      f("name", "name", "string", o.name || ""),
      f(null, "type", "text", o.type || ""),
      f("visible", "visible", "bool", o.visible !== false),
      f("position", "position", "vec3", vec(o.position)),
      f("rotation", "rotation (°)", "vec3", [o.rotation.x * DEG, o.rotation.y * DEG, o.rotation.z * DEG]),
      f("scale", "scale", "vec3", vec(o.scale)),
      f("renderOrder", "renderOrder", "number", o.renderOrder || 0),
      f("castShadow", "castShadow", "bool", !!o.castShadow),
      f("receiveShadow", "receiveShadow", "bool", !!o.receiveShadow),
      f("frustumCulled", "frustumCulled", "bool", o.frustumCulled !== false),
    ];
    try {
      o.updateWorldMatrix ? o.updateWorldMatrix(true, false) : null;
      const e = o.matrixWorld.elements;
      obj.push(f(null, "world position", "text", [e[12], e[13], e[14]].map((v) => +v.toFixed(4)).join(", ")));
    } catch (_) {}
    obj.push(f(null, "children", "text", String((o.children || []).length)));
    sections.push({ title: o.type || "Object3D", fields: obj });

    if (o.isScene) {
      const s = [];
      if (o.background && o.background.isColor) s.push(f("background", "background", "color", colorHex(o.background)));
      else if (o.background && o.background.isTexture) {
        const t = textureInfo(o.background);
        s.push(f(null, "background", "texture", t.text, { thumb: t.thumb }));
      } else s.push(f(null, "background", "text", "none"));
      if ("backgroundIntensity" in o) s.push(f("backgroundIntensity", "backgroundIntensity", "number", o.backgroundIntensity, { step: 0.1 }));
      if ("backgroundBlurriness" in o) s.push(f("backgroundBlurriness", "backgroundBlurriness", "number", o.backgroundBlurriness, { min: 0, max: 1, step: 0.05 }));
      const env = o.environment && o.environment.isTexture ? textureInfo(o.environment) : null;
      s.push(env ? f(null, "environment", "texture", env.text, { thumb: env.thumb }) : f(null, "environment", "text", "none"));
      if (typeof o.environmentIntensity === "number") s.push(f("environmentIntensity", "environmentIntensity", "number", o.environmentIntensity, { min: 0, max: 5, step: 0.05 }));
      if (o.fog) {
        s.push(f("fog.color", "fog color", "color", colorHex(o.fog.color)));
        if ("near" in o.fog) s.push(f("fog.near", "fog near", "number", o.fog.near), f("fog.far", "fog far", "number", o.fog.far));
        if ("density" in o.fog) s.push(f("fog.density", "fog density", "number", o.fog.density, { step: 0.001 }));
      }
      sections.push({ title: "Scene", fields: s });
    }

    if (o.isLight) {
      const s = [f("color", "color", "color", colorHex(o.color)), f("intensity", "intensity", "number", o.intensity, { step: 0.1 })];
      if (o.groundColor) s.push(f("groundColor", "groundColor", "color", colorHex(o.groundColor)));
      if ("distance" in o) s.push(f("distance", "distance", "number", o.distance));
      if ("decay" in o) s.push(f("decay", "decay", "number", o.decay, { step: 0.1 }));
      if ("angle" in o) s.push(f("angle", "angle (°)", "number", o.angle * DEG));
      if ("penumbra" in o) s.push(f("penumbra", "penumbra", "number", o.penumbra, { min: 0, max: 1, step: 0.05 }));
      sections.push({ title: "Light", fields: s });
    }

    if (o.isCamera) {
      const s = [];
      if ("fov" in o) s.push(f("fov", "fov", "number", o.fov));
      s.push(f("near", "near", "number", o.near, { step: 0.01 }), f("far", "far", "number", o.far), f("zoom", "zoom", "number", o.zoom, { step: 0.1 }));
      if ("aspect" in o) s.push(f(null, "aspect", "text", (+o.aspect).toFixed(3)));
      sections.push({ title: "Camera", fields: s });
    }

    if (o.geometry && (o.isMesh || o.isPoints || o.isLine)) {
      const g = o.geometry;
      const s = [f(null, "type", "text", g.type || "")];
      if (g.isGeometry) s.push(f(null, "vertices", "text", String((g.vertices || []).length)), f(null, "faces", "text", String((g.faces || []).length)));
      else {
        const attrs = g.attributes || {};
        s.push(f(null, "vertices", "text", String(attrs.position ? attrs.position.count : 0)));
        if (o.isMesh) s.push(f(null, "triangles", "text", String(triangleCount(o))));
        s.push(f(null, "index", "text", g.index ? `${g.index.count} (${g.index.array && g.index.array.constructor.name})` : "none"));
        s.push(f(null, "attributes", "text", Object.keys(attrs).map((k) => {
          const a = attrs[k];
          const arr = a.isInterleavedBufferAttribute ? a.data && a.data.array : a.array;
          return `${k} ×${a.itemSize}${arr ? " " + arr.constructor.name.replace("Array", "") : " (GPU only)"}${a.normalized ? " norm" : ""}`;
        }).join("\n")));
        if (g.groups && g.groups.length) s.push(f(null, "groups", "text", String(g.groups.length)));
        if (g.morphAttributes && g.morphAttributes.position) s.push(f(null, "morph targets", "text", String(g.morphAttributes.position.length)));
      }
      try {
        if (!g.boundingBox && g.computeBoundingBox) g.computeBoundingBox();
        const b = g.boundingBox;
        if (b) s.push(f(null, "size (local)", "text", [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].map((v) => +v.toFixed(4)).join(" × ")));
      } catch (_) {}
      if (o.isInstancedMesh) s.push(f(null, "instances", "text", String(o.count)));
      if (o.isSkinnedMesh && o.skeleton) s.push(f(null, "bones", "text", String(o.skeleton.bones.length)));
      sections.push({ title: "Geometry", fields: s });
    }

    if (o.morphTargetInfluences && o.morphTargetInfluences.length) {
      const names = Object.entries(o.morphTargetDictionary || {}).reduce((m, [k, v]) => ((m[v] = k), m), {});
      sections.push({
        title: "Morph targets",
        fields: Array.from(o.morphTargetInfluences, (v, i) =>
          f(`morphTargetInfluences.${i}`, names[i] || `#${i}`, "number", v, { min: 0, max: 1, step: 0.01 })
        ),
      });
    }

    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    mats.forEach((m, i) => {
      const p = `material.${i}.`;
      const s = [f(p + "name", "name", "string", m.name || ""), f(null, "type", "text", m.type || "")];
      for (const k of ["color", "emissive", "specular", "sheenColor", "attenuationColor"])
        if (m[k] && m[k].isColor) s.push(f(p + k, k, "color", colorHex(m[k])));
      const nums = [
        ["emissiveIntensity", 0, 10, 0.1], ["opacity", 0, 1, 0.01], ["metalness", 0, 1, 0.01], ["roughness", 0, 1, 0.01],
        ["alphaTest", 0, 1, 0.01], ["envMapIntensity", 0, 10, 0.1], ["clearcoat", 0, 1, 0.01], ["transmission", 0, 1, 0.01],
        ["ior", 1, 2.333, 0.01], ["shininess", 0, 1000, 1], ["size", 0, 100, 0.1], ["linewidth", 0, 10, 0.1],
      ];
      for (const [k, min, max, step] of nums) if (typeof m[k] === "number") s.push(f(p + k, k, "number", m[k], { min, max, step }));
      for (const k of ["transparent", "wireframe", "flatShading", "vertexColors", "depthTest", "depthWrite", "toneMapped", "visible", "fog"])
        if (typeof m[k] === "boolean") s.push(f(p + k, k, "bool", m[k]));
      if (typeof m.side === "number") s.push(f(p + "side", "side", "enum", m.side, { options: SIDES }));
      for (const k of TEXTURE_SLOTS) {
        const t = m[k] && m[k].isTexture ? textureInfo(m[k]) : null;
        if (t) s.push(f(null, k, "texture", t.text, { thumb: t.thumb }));
      }
      sections.push({ title: mats.length > 1 ? `Material ${i}` : "Material", fields: s });
    });

    const root = rootFor(o);
    const v = root && views.get(root);
    if (o === root && v) sections.push(rendererSection(v.renderer));

    if (o.userData && Object.keys(o.userData).length) {
      let text;
      try {
        text = JSON.stringify(o.userData, null, 1);
      } catch (_) {
        text = "(not serializable)";
      }
      sections.push({ title: "userData", fields: [f(null, "", "text", text.length > 2000 ? text.slice(0, 2000) + "…" : text)] });
    }
    return { id, name: o.name || "", type: o.type || "", sections };
  }

  function rendererSection(r) {
    const f = (path, label, type, value, extra) => ({ path, label, type, value, ...extra });
    const s = [f(null, "type", "text", r.isWebGPURenderer ? "WebGPURenderer" : r.isWebGLRenderer ? "WebGLRenderer" : r.constructor && r.constructor.name)];
    try {
      const c = r.domElement;
      if (c) s.push(f(null, "canvas", "text", `${c.width}×${c.height} (pixel ratio ${r.getPixelRatio ? r.getPixelRatio() : "?"})`));
    } catch (_) {}
    if (typeof r.toneMappingExposure === "number") s.push(f("@renderer.toneMappingExposure", "toneMappingExposure", "number", r.toneMappingExposure, { step: 0.05 }));
    if (typeof r.toneMapping === "number")
      s.push(f("@renderer.toneMapping", "toneMapping", "enum", r.toneMapping, { options: ["None", "Linear", "Reinhard", "Cineon", "ACESFilmic", "Custom", "AgX", "Neutral"] }));
    if (r.outputColorSpace) s.push(f(null, "outputColorSpace", "text", r.outputColorSpace));
    if (r.shadowMap) s.push(f("@renderer.shadowMap.enabled", "shadows", "bool", !!r.shadowMap.enabled));
    const info = r.info || {};
    if (info.render) s.push(f(null, "last frame", "text", `${info.render.calls ?? info.render.drawCalls ?? "?"} calls · ${info.render.triangles ?? "?"} triangles`));
    if (info.memory) s.push(f(null, "memory", "text", `${info.memory.geometries ?? "?"} geometries · ${info.memory.textures ?? "?"} textures`));
    if (info.programs) s.push(f(null, "programs", "text", String(info.programs.length)));
    return { title: "Renderer", fields: s };
  }

  function set(id, path, value) {
    const o = lookup(id);
    if (!o || !path) return false;
    const root = rootFor(o);
    let target = o;
    let parts = path.split(".");
    if (parts[0] === "@renderer") {
      const v = root && views.get(root);
      if (!v) return false;
      target = v.renderer;
      parts = parts.slice(1);
    } else if (parts[0] === "material") {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      target = mats[+parts[1]];
      parts = parts.slice(2);
    }
    const key = parts.pop();
    for (const p of parts) target = target && target[p];
    if (!target) return false;
    const cur = target[key];

    if (path === "rotation") cur.set(value[0] / DEG, value[1] / DEG, value[2] / DEG);
    else if (key === "angle" && o.isLight) target[key] = value / DEG;
    else if (cur && cur.isColor) cur.set(value);
    else if (cur && cur.isVector3) cur.set(value[0], value[1], value[2]);
    else if (key === "background" && o.isScene && value) {
      if (cur && cur.isColor) cur.set(value);
    } else target[key] = value;

    if (target.isMaterial && /^(flatShading|side|transparent|vertexColors|alphaTest|fog|wireframe)$/.test(key)) target.needsUpdate = true;
    if (o.isCamera && /^(fov|near|far|zoom)$/.test(key) && o.updateProjectionMatrix) o.updateProjectionMatrix();
    if ((target.shadowMap && key === "enabled") || key === "toneMapping") {
      root && traverse(root, (x) => x.material && [].concat(x.material).forEach((m) => (m.needsUpdate = true)));
    }
    redrawSoon(root);
    return true;
  }

  // Apps that render on demand won't show an edit until their next render;
  // if no frame happened shortly after the change, draw one ourselves.
  function redrawSoon(root) {
    const v = root && views.get(root);
    if (!v || !v.camera) return;
    const frame = () => v.renderer.info && v.renderer.info.render && v.renderer.info.render.frame;
    const before = frame();
    setTimeout(() => {
      const now = frame();
      if (before === undefined || now === before) {
        try {
          v.renderer.render(root, v.camera);
        } catch (_) {}
      }
    }, 120);
  }

  function setVisible(id, visible) {
    return set(id, "visible", !!visible);
  }

  function flash(id) {
    const o = lookup(id);
    if (!o) return false;
    const orig = o.visible;
    const root = rootFor(o);
    let n = 0;
    const tick = () => {
      o.visible = n % 2 ? orig : !orig;
      redrawSoon(root);
      if (++n < 7) setTimeout(tick, 200);
      else o.visible = orig;
    };
    tick();
    return true;
  }

  /* ---------------------------- geometry ----------------------------- */

  function attrReader(attr) {
    if (!attr) return null;
    let array, stride, offset;
    if (attr.isInterleavedBufferAttribute) {
      array = attr.data && attr.data.array;
      stride = attr.data.stride;
      offset = attr.offset;
    } else {
      array = attr.array;
      stride = attr.itemSize;
      offset = 0;
    }
    if (!array || !array.length) return null;
    let k = 1;
    if (attr.normalized) {
      if (array instanceof Int8Array) k = 1 / 127;
      else if (array instanceof Uint8Array || array instanceof Uint8ClampedArray) k = 1 / 255;
      else if (array instanceof Int16Array) k = 1 / 32767;
      else if (array instanceof Uint16Array) k = 1 / 65535;
      else if (array instanceof Int32Array) k = 1 / 2147483647;
      else if (array instanceof Uint32Array) k = 1 / 4294967295;
    }
    const signed = attr.normalized && (array instanceof Int8Array || array instanceof Int16Array || array instanceof Int32Array);
    const size = attr.itemSize;
    return {
      count: attr.count,
      get(i, c) {
        if (c >= size) return 0;
        const v = array[i * stride + offset + c] * k;
        return signed ? Math.max(v, -1) : v;
      },
    };
  }

  function mul(e, x, y, z, out, o) {
    out[o] = e[0] * x + e[4] * y + e[8] * z + e[12];
    out[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    out[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }

  function mulMat(a, b) {
    const r = new Array(16);
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
        r[i * 4 + j] = s;
      }
    return r;
  }

  function det3(e) {
    return e[0] * (e[5] * e[10] - e[9] * e[6]) - e[4] * (e[1] * e[10] - e[9] * e[2]) + e[8] * (e[1] * e[6] - e[5] * e[2]);
  }

  // Local-space vertex positions (morph targets + skinning applied).
  function localPositions(mesh) {
    const geo = mesh.geometry;
    if (geo.isGeometry && geo.vertices) {
      // Legacy THREE.Geometry (< r125).
      const out = new Float32Array(geo.vertices.length * 3);
      geo.vertices.forEach((v, i) => out.set([v.x, v.y, v.z], i * 3));
      return out;
    }
    const pos = attrReader(geo.attributes && geo.attributes.position);
    if (!pos) return null;
    const n = pos.count;
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      out[i * 3] = pos.get(i, 0);
      out[i * 3 + 1] = pos.get(i, 1);
      out[i * 3 + 2] = pos.get(i, 2);
    }

    const morphs = geo.morphAttributes && geo.morphAttributes.position;
    const infl = mesh.morphTargetInfluences;
    if (morphs && morphs.length && infl && infl.length) {
      const base = out.slice();
      for (let m = 0; m < morphs.length; m++) {
        const w = infl[m];
        const r = w ? attrReader(morphs[m]) : null;
        if (!r) continue;
        for (let i = 0; i < n; i++)
          for (let c = 0; c < 3; c++) {
            const t = r.get(i, c);
            out[i * 3 + c] += geo.morphTargetsRelative ? t * w : (t - base[i * 3 + c]) * w;
          }
      }
    }

    if (mesh.isSkinnedMesh && mesh.skeleton) {
      const fn = mesh.applyBoneTransform || mesh.boneTransform;
      const V = mesh.position && mesh.position.constructor;
      if (fn && V) {
        try {
          if (mesh.skeleton.update) mesh.skeleton.update();
          const v = new V();
          for (let i = 0; i < n; i++) {
            v.x = out[i * 3];
            v.y = out[i * 3 + 1];
            v.z = out[i * 3 + 2];
            reflectApply(fn, mesh, [i, v]);
            out[i * 3] = v.x;
            out[i * 3 + 1] = v.y;
            out[i * 3 + 2] = v.z;
          }
        } catch (_) {}
      }
    }
    return out;
  }

  // Triangle index list for a mesh (respects index + drawRange).
  function triangleIndices(mesh, vertexCount) {
    const geo = mesh.geometry;
    if (geo.isGeometry && geo.faces) {
      const out = new Uint32Array(geo.faces.length * 3);
      geo.faces.forEach((f, i) => out.set([f.a, f.b, f.c], i * 3));
      return out;
    }
    const index = geo.index && geo.index.array ? geo.index : null;
    const total = index ? index.count : vertexCount;
    const dr = geo.drawRange || { start: 0, count: Infinity };
    const start = Math.max(0, dr.start | 0);
    const end = Math.min(total, start + (dr.count === Infinity ? total : dr.count));
    const count = Math.max(0, Math.floor((end - start) / 3) * 3);
    const out = new Uint32Array(count);
    for (let i = 0; i < count; i++) out[i] = index ? index.array[start + i] : start + i;
    return out;
  }

  function triangleCount(mesh) {
    const geo = mesh.geometry;
    if (!geo) return 0;
    if (geo.isGeometry) return geo.faces ? geo.faces.length : 0;
    const total = geo.index ? geo.index.count : (geo.attributes && geo.attributes.position && geo.attributes.position.count) || 0;
    const dr = geo.drawRange;
    const c = dr && dr.count !== Infinity ? Math.min(dr.count, total) : total;
    return Math.floor(c / 3) * (mesh.isInstancedMesh ? mesh.count : 1);
  }

  function instanceMatrices(mesh) {
    const world = mesh.matrixWorld.elements;
    if (!mesh.isInstancedMesh || !mesh.instanceMatrix) return [world];
    const a = mesh.instanceMatrix.array;
    const list = [];
    for (let i = 0; i < mesh.count; i++) list.push(mulMat(world, Array.from(a.subarray(i * 16, i * 16 + 16))));
    return list;
  }

  // World-space triangle soup (Float32Array, 9 floats per triangle).
  function worldTriangles(mesh) {
    if (mesh.updateWorldMatrix) mesh.updateWorldMatrix(true, false);
    else if (mesh.updateMatrixWorld) mesh.updateMatrixWorld(true);
    const local = localPositions(mesh);
    if (!local) return null;
    const tri = triangleIndices(mesh, local.length / 3);
    const mats = instanceMatrices(mesh);
    const out = new Float32Array(tri.length * 3 * mats.length);
    let o = 0;
    for (const e of mats) {
      const flip = det3(e) < 0; // mirrored transform: keep outward winding
      for (let t = 0; t < tri.length; t += 3) {
        const a = tri[t] * 3;
        const b = tri[flip ? t + 2 : t + 1] * 3;
        const c = tri[flip ? t + 1 : t + 2] * 3;
        mul(e, local[a], local[a + 1], local[a + 2], out, o);
        mul(e, local[b], local[b + 1], local[b + 2], out, o + 3);
        mul(e, local[c], local[c + 1], local[c + 2], out, o + 6);
        o += 9;
      }
    }
    return out;
  }

  function isVisible(o) {
    for (let x = o; x; x = x.parent) if (x.visible === false) return false;
    return true;
  }

  function meshColor(mesh) {
    const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    return (m && colorHex(m.color)) || null;
  }

  // Geometry of a subtree, prepared once and then read in base64 chunks
  // (inspectedWindow.eval only carries JSON).
  const jobs = new Map();
  let jobSeq = 0;

  function prepare(id, { visibleOnly = true } = {}) {
    const o = lookup(id);
    if (!o) return null;
    const parts = [];
    const skipped = [];
    traverse(o, (x) => {
      if (!isExportable(x) || (visibleOnly && !isVisible(x))) return;
      let tris = null;
      try {
        tris = worldTriangles(x);
      } catch (_) {}
      if (!tris || !tris.length) return void skipped.push(x.name || x.type);
      parts.push({ id: idOf(x), name: x.name || x.geometry.name || x.type, color: meshColor(x), bytes: new Uint8Array(tris.buffer) });
    });
    const job = ++jobSeq;
    jobs.set(job, parts);
    return { job, skipped, parts: parts.map((p) => ({ id: p.id, name: p.name, color: p.color, byteLength: p.bytes.length })) };
  }

  function chunk(job, part, offset, length) {
    const p = jobs.get(job) && jobs.get(job)[part];
    if (!p) return null;
    const bytes = p.bytes.subarray(offset, offset + length);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function release(job) {
    return jobs.delete(job);
  }

  window[KEY] = {
    version: VERSION,
    arm,
    status,
    tree,
    props,
    set,
    setVisible,
    flash,
    prepare,
    chunk,
    release,
  };
  Object.defineProperty(window, KEY, { enumerable: false });
  return VERSION;
})();
