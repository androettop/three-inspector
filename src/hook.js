// Three Inspector — page-context hook (MAIN world).
//
// Injected on demand (when the user clicks the extension icon), so three.js is
// usually already loaded and every constructor has already run. We therefore
// catch live objects from calls that happen while the app renders or reacts to
// input, then remove every patch as soon as we hold the scene:
//
//  1. Getter traps on Object.prototype for flags the renderer reads on every
//     object it projects but that ordinary meshes don't own (isLOD, isSprite…).
//     The getter returns undefined — the same value the lookup would produce —
//     and records `this`.
//  2. Array.prototype.sort: render lists sort items { object, geometry, … }.
//  3. Function.prototype.call/apply: EventDispatcher listeners (OrbitControls
//     "change", etc.) and transpiled bundles pass three objects through here.
//
// Any Object3D found is walked up to its root (normally the Scene). After the
// first hit we keep listening for a short window to catch extra scenes
// (overlays, second renderers) and then restore every original.
(() => {
  const KEY = Symbol.for("threeInspector.hook");
  if (window[KEY]) {
    window[KEY].wake();
    return;
  }

  const MSG = "__threeInspector";
  const COLLECT_MS = 400;
  const GIVE_UP_MS = 120000;
  const token = Math.random().toString(36).slice(2);

  const roots = new Set();
  let state = "idle"; // idle | searching | found | notfound
  let restore = null;
  let collectTimer = 0;
  let giveUpTimer = 0;
  let meshIndex = new Map();
  const nativeCall = Function.prototype.call;
  const nativeApply = Function.prototype.apply;
  const reflectApply = Reflect.apply;

  /* ----------------------------- capture ----------------------------- */

  function isObject3D(o) {
    return !!o && typeof o === "object" && o.isObject3D === true && !!o.matrixWorld;
  }

  function rootOf(o) {
    let r = o;
    for (let i = 0; i < 10000 && r.parent; i++) r = r.parent;
    return r;
  }

  let inCapture = false;
  function offer(o) {
    if (inCapture || state !== "searching") return;
    inCapture = true;
    try {
      if (isObject3D(o)) addRoot(rootOf(o));
      else if (o && typeof o === "object") {
        // render items ({ object }), controls ({ object: camera }), renderers…
        if (isObject3D(o.object)) addRoot(rootOf(o.object));
        if (isObject3D(o.scene)) addRoot(rootOf(o.scene));
      }
    } catch (_) {
    } finally {
      inCapture = false;
    }
  }

  let rejected = new WeakSet();
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

  // The renderer draws scene.background with its own detached box/plane mesh.
  function isBackgroundMesh(o) {
    const m = o.isMesh && !o.parent && o.material;
    return !!m && /^Background(Cube)?Material$/.test(m.name || "");
  }

  function addRoot(root) {
    if (roots.has(root) || rejected.has(root)) return;
    // A lone camera (OrbitControls.object) or an empty group is not a model;
    // keep waiting for the real scene to be rendered.
    // Renderer internals (WebGPURenderer's fullscreen QuadMesh) aren't models.
    if (root.isQuadMesh || isBackgroundMesh(root) || !containsMesh(root)) return void rejected.add(root);
    roots.add(root);
    if (!collectTimer) collectTimer = setTimeout(finishCapture, COLLECT_MS);
  }

  function install() {
    const undo = [];

    // 1. Getter traps.
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

    // 2. Array.prototype.sort (render lists).
    const nativeSort = Array.prototype.sort;
    const sort = function sort(cmp) {
      if (this && this.length) {
        const first = this[0];
        if (first && typeof first === "object" && first.object && first.geometry) offer(first);
      }
      return reflectApply(nativeSort, this, arguments);
    };
    Array.prototype.sort = sort;
    undo.push(() => {
      if (Array.prototype.sort === sort) Array.prototype.sort = nativeSort;
    });

    // 3. Function.prototype.call / apply.
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

    return () => {
      for (const fn of undo) {
        try {
          fn();
        } catch (_) {}
      }
    };
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
    announce();
  }

  // Only patch frames that can actually be drawing WebGL.
  function hasCanvas(node = document) {
    if (node.querySelector("canvas")) return true;
    for (const el of node.querySelectorAll("*")) if (el.shadowRoot && hasCanvas(el.shadowRoot)) return true;
    return false;
  }

  function arm() {
    uninstall();
    roots.clear();
    rejected = new WeakSet();
    if (!hasCanvas()) {
      state = "nocanvas";
      return announce();
    }
    state = "searching";
    restore = install();
    giveUpTimer = setTimeout(() => {
      uninstall();
      state = roots.size ? "found" : "notfound";
      announce();
    }, GIVE_UP_MS);
    // Many on-demand viewers re-render on resize; nudge them once.
    setTimeout(() => {
      if (state === "searching") window.dispatchEvent(new Event("resize"));
    }, 300);
    announce();
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

  function indexReader(geo) {
    const index = geo.index;
    if (!index) return null;
    const array = index.array;
    if (!array) return null;
    return { count: index.count, get: (i) => array[i] };
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
    return (
      e[0] * (e[5] * e[10] - e[9] * e[6]) - e[4] * (e[1] * e[10] - e[9] * e[2]) + e[8] * (e[1] * e[6] - e[5] * e[2])
    );
  }

  // Local-space vertex positions (morph targets + skinning applied).
  function localPositions(mesh) {
    const geo = mesh.geometry;
    if (geo.isGeometry && geo.vertices) {
      // Legacy THREE.Geometry (< r125).
      const out = new Float32Array(geo.vertices.length * 3);
      geo.vertices.forEach((v, i) => {
        out[i * 3] = v.x;
        out[i * 3 + 1] = v.y;
        out[i * 3 + 2] = v.z;
      });
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
        if (!w) continue;
        const r = attrReader(morphs[m]);
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
          mesh.skeleton.update && mesh.skeleton.update();
          const v = new V();
          for (let i = 0; i < n; i++) {
            v.x = out[i * 3];
            v.y = out[i * 3 + 1];
            v.z = out[i * 3 + 2];
            fn.call(mesh, i, v);
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
      geo.faces.forEach((f, i) => {
        out[i * 3] = f.a;
        out[i * 3 + 1] = f.b;
        out[i * 3 + 2] = f.c;
      });
      return out;
    }
    const idx = indexReader(geo);
    const total = idx ? idx.count : vertexCount;
    const dr = geo.drawRange || { start: 0, count: Infinity };
    const start = Math.max(0, dr.start | 0);
    const end = Math.min(total, start + (dr.count === Infinity ? total : dr.count));
    const count = Math.floor((end - start) / 3) * 3;
    const out = new Uint32Array(Math.max(0, count));
    for (let i = 0; i < count; i++) out[i] = idx ? idx.get(start + i) : start + i;
    return out;
  }

  function triangleCount(mesh) {
    const geo = mesh.geometry;
    if (!geo) return 0;
    if (geo.isGeometry) return geo.faces ? geo.faces.length : 0;
    const total = geo.index ? geo.index.count : geo.attributes?.position?.count || 0;
    const dr = geo.drawRange;
    const c = dr && dr.count !== Infinity ? Math.min(dr.count, total) : total;
    const inst = mesh.isInstancedMesh ? mesh.count : 1;
    return Math.floor(c / 3) * inst;
  }

  function instanceMatrices(mesh) {
    const world = mesh.matrixWorld.elements;
    if (!mesh.isInstancedMesh || !mesh.instanceMatrix) return [world];
    const a = mesh.instanceMatrix.array;
    const list = [];
    for (let i = 0; i < mesh.count; i++) list.push(mulMat(world, Array.prototype.slice.call(a, i * 16, i * 16 + 16)));
    return list;
  }

  // World-space triangle soup (Float32Array, 9 floats per triangle).
  function worldTriangles(mesh) {
    mesh.updateWorldMatrix ? mesh.updateWorldMatrix(true, false) : mesh.updateMatrixWorld && mesh.updateMatrixWorld(true);
    const local = localPositions(mesh);
    if (!local) return null;
    const tri = triangleIndices(mesh, local.length / 3);
    const mats = instanceMatrices(mesh);
    const out = new Float32Array(tri.length * 3 * mats.length);
    let o = 0;
    for (const e of mats) {
      const flip = det3(e) < 0;
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

  function worldBox(mesh) {
    const geo = mesh.geometry;
    try {
      if (!geo.boundingBox && geo.computeBoundingBox) geo.computeBoundingBox();
    } catch (_) {}
    const bb = geo.boundingBox;
    if (!bb) return null;
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const p = [0, 0, 0];
    for (const e of instanceMatrices(mesh).slice(0, 2000))
      for (let i = 0; i < 8; i++) {
        mul(e, i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z, p, 0);
        for (let c = 0; c < 3; c++) {
          box[c] = Math.min(box[c], p[c]);
          box[c + 3] = Math.max(box[c + 3], p[c]);
        }
      }
    return box.every(Number.isFinite) ? box : null;
  }

  function isVisible(o) {
    for (let x = o; x; x = x.parent) if (x.visible === false) return false;
    return true;
  }

  function meshColor(mesh) {
    const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const c = m && m.color;
    if (!c || typeof c.r !== "number") return null;
    const h = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
    // three ≥ r152 stores linear colors; approximate sRGB for display.
    const s = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
    return "#" + h(s(c.r)) + h(s(c.g)) + h(s(c.b));
  }

  function hasCpuData(mesh) {
    const geo = mesh.geometry;
    if (geo.isGeometry) return true;
    const p = geo.attributes && geo.attributes.position;
    if (!p) return false;
    const arr = p.isInterleavedBufferAttribute ? p.data && p.data.array : p.array;
    return !!(arr && arr.length);
  }

  function list() {
    meshIndex = new Map();
    let n = 0;
    const out = [];
    for (const root of roots) {
      const meshes = [];
      const visit = (o) => {
        if ((o.isMesh || o.isSkinnedMesh || o.isInstancedMesh) && o.geometry && !o.isBatchedMesh) {
          const id = "m" + n++;
          meshIndex.set(id, o);
          meshes.push({
            id,
            name: o.name || o.geometry.name || (o.material && o.material.name) || o.type || "Mesh",
            type: o.type || "Mesh",
            tris: triangleCount(o),
            visible: isVisible(o),
            box: worldBox(o),
            color: meshColor(o),
            cpu: hasCpuData(o),
          });
        }
        const ch = o.children || [];
        for (let i = 0; i < ch.length; i++) visit(ch[i]);
      };
      visit(root);
      out.push({
        label: root.name || (root.isScene ? "Scene" : root.type || "Object3D"),
        isScene: !!root.isScene,
        meshes,
      });
    }
    return {
      url: location.href,
      title: document.title,
      revision: window.__THREE__ || null,
      roots: out,
    };
  }

  /* ----------------------------- writers ----------------------------- */

  function transformPoint(tris, scale, zUp) {
    // three.js is Y-up; slicers are Z-up: rotate +90° about X → (x, -z, y).
    const out = new Float32Array(tris.length);
    for (let i = 0; i < tris.length; i += 3) {
      const x = tris[i] * scale,
        y = tris[i + 1] * scale,
        z = tris[i + 2] * scale;
      out[i] = x;
      out[i + 1] = zUp ? -z : y;
      out[i + 2] = zUp ? y : z;
    }
    return out;
  }

  function writeSTL(parts) {
    const total = parts.reduce((s, p) => s + p.tris.length / 9, 0);
    const buf = new ArrayBuffer(84 + total * 50);
    const dv = new DataView(buf);
    const header = "Three Inspector STL export";
    for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
    dv.setUint32(80, total, true);
    let o = 84;
    for (const { tris: t } of parts)
      for (let i = 0; i < t.length; i += 9) {
        const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2];
        const vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1;
        dv.setFloat32(o, nx / l, true);
        dv.setFloat32(o + 4, ny / l, true);
        dv.setFloat32(o + 8, nz / l, true);
        o += 12;
        for (let k = 0; k < 9; k++, o += 4) dv.setFloat32(o, t[i + k], true);
        o += 2;
      }
    return buf;
  }

  const xmlEsc = (s) =>
    String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
  const num = (v) => {
    const r = Math.round(v * 1e5) / 1e5;
    return Object.is(r, -0) ? "0" : String(r);
  };

  async function write3MF(parts, separate) {
    const enc = new TextEncoder();
    const chunks = [];
    let buf = "";
    const push = (s) => {
      buf += s;
      if (buf.length > 1 << 20) {
        chunks.push(enc.encode(buf));
        buf = "";
      }
    };
    const groups = separate ? parts : [{ name: parts.length === 1 ? parts[0].name : "Model", color: parts[0].color, tris: null, all: parts }];

    push('<?xml version="1.0" encoding="UTF-8"?>\n');
    push('<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n');
    push(' <metadata name="Application">Three Inspector</metadata>\n <resources>\n  <basematerials id="1">\n');
    groups.forEach((g, i) => push(`   <base name="${xmlEsc(g.name || "mat" + i)}" displaycolor="${(g.color || "#c8c8c8").toUpperCase()}FF"/>\n`));
    push("  </basematerials>\n");
    const ids = [];
    groups.forEach((g, gi) => {
      const id = gi + 2;
      ids.push(id);
      push(`  <object id="${id}" type="model" name="${xmlEsc(g.name || "Object " + gi)}" pid="1" pindex="${gi}">\n   <mesh>\n    <vertices>\n`);
      const map = new Map();
      const tri = [];
      let next = 0;
      for (const p of g.all || [g]) {
        const t = p.tris;
        for (let i = 0; i < t.length; i += 3) {
          const key = num(t[i]) + " " + num(t[i + 1]) + " " + num(t[i + 2]);
          let v = map.get(key);
          if (v === undefined) {
            v = next++;
            map.set(key, v);
            const [x, y, z] = key.split(" ");
            push(`     <vertex x="${x}" y="${y}" z="${z}"/>\n`);
          }
          tri.push(v);
        }
      }
      push("    </vertices>\n    <triangles>\n");
      for (let i = 0; i < tri.length; i += 3) {
        const a = tri[i], b = tri[i + 1], c = tri[i + 2];
        if (a === b || b === c || a === c) continue; // degenerate: invalid in 3MF
        push(`     <triangle v1="${a}" v2="${b}" v3="${c}"/>\n`);
      }
      push("    </triangles>\n   </mesh>\n  </object>\n");
    });
    push(" </resources>\n <build>\n");
    ids.forEach((id) => push(`  <item objectid="${id}"/>\n`));
    push(" </build>\n</model>\n");
    chunks.push(enc.encode(buf));

    const files = [
      {
        name: "[Content_Types].xml",
        data: [
          enc.encode(
            '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
              '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
              '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'
          ),
        ],
      },
      {
        name: "_rels/.rels",
        data: [
          enc.encode(
            '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
              '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'
          ),
        ],
      },
      { name: "3D/3dmodel.model", data: chunks },
    ];
    return zip(files);
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(chunks) {
    let c = 0xffffffff;
    for (const d of chunks) for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function deflate(chunks) {
    if (typeof CompressionStream === "undefined") return null;
    const stream = new Blob(chunks).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function zip(files) {
    const enc = new TextEncoder();
    const out = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const size = f.data.reduce((s, d) => s + d.length, 0);
      const crc = crc32(f.data);
      const packed = await deflate(f.data);
      const method = packed ? 8 : 0;
      const body = packed ? [packed] : f.data;
      const csize = packed ? packed.length : size;
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(8, method, true);
      local.setUint16(12, 0x21, true); // 1980-01-01
      local.setUint32(14, crc, true);
      local.setUint32(18, csize, true);
      local.setUint32(22, size, true);
      local.setUint16(26, name.length, true);
      out.push(new Uint8Array(local.buffer), name, ...body);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(10, method, true);
      cd.setUint16(14, 0x21, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, csize, true);
      cd.setUint32(24, size, true);
      cd.setUint16(28, name.length, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), name);
      offset += 30 + name.length + csize;
    }
    const cdSize = central.reduce((s, d) => s + d.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...out, ...central, new Uint8Array(end.buffer)]).arrayBuffer();
  }

  async function exportModel({ ids, format, scale = 1, zUp = true, separate = true }) {
    const parts = [];
    const skipped = [];
    for (const id of ids) {
      const mesh = meshIndex.get(id);
      if (!mesh) continue;
      let tris = null;
      try {
        tris = worldTriangles(mesh);
      } catch (e) {
        console.warn("[Three Inspector]", e);
      }
      if (!tris || !tris.length) {
        skipped.push(mesh.name || id);
        continue;
      }
      parts.push({ name: mesh.name || mesh.geometry.name || id, color: meshColor(mesh), tris: transformPoint(tris, scale, zUp) });
    }
    if (!parts.length) throw new Error("None of the selected meshes has readable geometry.");
    const buffer = format === "3mf" ? await write3MF(parts, separate) : writeSTL(parts);
    const host = (location.hostname || "model").replace(/^www\./, "");
    return {
      buffer,
      filename: `${host}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.${format}`,
      tris: parts.reduce((s, p) => s + p.tris.length / 9, 0),
      skipped,
    };
  }

  function flash(id) {
    const mesh = meshIndex.get(id);
    if (!mesh) return false;
    const orig = mesh.visible;
    let n = 0;
    const tick = () => {
      mesh.visible = n % 2 ? orig : !orig;
      if (++n < 7) setTimeout(tick, 180);
      else mesh.visible = orig;
    };
    tick();
    return true;
  }

  /* --------------------------- messaging ----------------------------- */

  function summary() {
    let meshes = 0;
    for (const r of roots) r.traverse ? r.traverse((o) => o.isMesh && meshes++) : 0;
    return { token, state, roots: roots.size, meshes, url: location.href, revision: window.__THREE__ || null };
  }

  function announce() {
    try {
      window.top.postMessage({ [MSG]: "state", frame: summary() }, "*");
    } catch (_) {}
  }

  window.addEventListener("message", async (e) => {
    const d = e.data;
    if (!d || d[MSG] !== "cmd" || e.source !== window.top) return;
    if (d.token && d.token !== token) return;
    const reply = (payload, transfer) => e.source.postMessage({ [MSG]: "res", id: d.id, token, ...payload }, "*", transfer || []);
    try {
      switch (d.cmd) {
        case "ping":
          return reply({ result: summary() });
        case "list":
          return reply({ result: list() });
        case "rearm":
          arm();
          return reply({ result: summary() });
        case "flash":
          return reply({ result: flash(d.args.id) });
        case "export": {
          const r = await exportModel(d.args);
          return reply({ result: r }, [r.buffer]);
        }
      }
    } catch (err) {
      reply({ error: String((err && err.message) || err) });
    }
  });

  window[KEY] = {
    wake() {
      if (state !== "found" && state !== "searching") arm();
      else announce();
    },
  };
  Object.defineProperty(window, KEY, { enumerable: false });
  arm();
})();
