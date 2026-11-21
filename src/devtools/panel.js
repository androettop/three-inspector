import * as bridge from "./bridge.js";
import { Viewer } from "./viewer.js";
import { transform, writeSTL, write3MF } from "./export.js";

const $ = (id) => document.getElementById(id);
const POLL_MS = 800;
const PREVIEW_LIMIT = 3_000_000; // triangles loaded without asking
const CHUNK = 4 << 20;
const ICONS = { scene: "▣", mesh: "◆", skinned: "✦", instanced: "⁂", light: "☀", camera: "◉", bone: "┼", points: "∴", line: "╱", sprite: "▢", object: "○" };

const frames = new Map(); // key ("" = top frame) -> { url, status, tree, signature }
let frameKey = "";
let selected = null; // object id
let expanded = new Set();
let visible = false;
let started = false;
let pollTimer = 0;
let lastProps = "";
let loaded = null; // { frame, id, visibleOnly, parts }
let loadSeq = 0;

document.body.classList.toggle("dark", bridge.theme === "dark");
const viewer = new Viewer($("viewer"));
viewer.setTheme(bridge.theme === "dark");

/* ------------------------------ frames ------------------------------- */

const frameURL = (key) => key;
const current = () => frames.get(frameKey);

let blockedFrames = 0;

async function scanFrames() {
  let list = [];
  try {
    list = await bridge.frames();
  } catch (_) {
    if (bridge.broken()) location.reload();
    return;
  }
  blockedFrames = list.blocked || 0;
  for (const { key, url } of list) {
    if (frames.has(key)) continue;
    frames.set(key, { url, status: null, tree: null, signature: null, misses: 0 });
    try {
      await bridge.inject(key);
      const s = await bridge.call(key, "status");
      if (!s || s.state === "idle" || s.state === "notfound" || s.state === "nocanvas") await bridge.call(key, "arm");
    } catch (_) {
      frames.delete(key);
    }
  }
}

// One polling loop at a time; it always reschedules itself, even after an
// error, while the panel is visible.
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  clearTimeout(pollTimer);
  try {
    if (visible) await pollOnce();
  } catch (err) {
    console.warn("Three Inspector:", err);
  } finally {
    polling = false;
    clearTimeout(pollTimer);
    if (visible) pollTimer = setTimeout(poll, POLL_MS);
  }
}

async function pollOnce() {
  for (const [key, f] of frames) {
    try {
      f.status = await bridge.call(frameURL(key), "status");
    } catch (_) {
      f.status = null;
    }
    // No agent there any more (the document was replaced, or the agent was
    // injected into the outgoing one during a navigation): inject again.
    if (!f.status && ++f.misses >= 2) {
      frames.delete(key);
      scanFrames();
      continue;
    }
    if (f.status) f.misses = 0;
    if (f.status && f.status.state === "found" && f.status.signature !== f.signature) {
      f.signature = f.status.signature;
      f.tree = await bridge.call(frameURL(key), "tree").catch(() => null);
      if (f.tree && !f.expandedOnce) {
        f.expandedOnce = true;
        for (const r of f.tree.roots) expanded.add(r.id);
      }
      if (key === frameKey) renderTree();
    }
  }
  pickFrame();
  renderStatus();
  if (selected) await refreshProps();
}

let frameOptions = "";

// Prefer a frame that actually has a scene.
function pickFrame() {
  const withScene = [...frames].filter(([, f]) => f.tree && f.tree.roots.length).map(([k]) => k);
  if (!withScene.includes(frameKey) && withScene.length) {
    frameKey = withScene[0];
    select(null);
    renderTree();
  }
  const sel = $("frame");
  sel.hidden = withScene.length < 2;
  const html = withScene.map((k) => `<option value="${esc(k)}" ${k === frameKey ? "selected" : ""}>${esc(k ? shortURL(frames.get(k).url) : "top frame")}</option>`).join("");
  if (frameOptions !== html) setHTML(sel, (frameOptions = html));
}

function renderStatus() {
  const states = [...frames.values()].map((f) => f.status && f.status.state);
  const f = current();
  const s = f && f.status;
  let text, cls;
  if (s && s.state === "found") {
    cls = "found";
    text = `${s.roots} scene${s.roots === 1 ? "" : "s"} · ${s.objects} objects`;
  } else if (states.includes("searching")) {
    cls = "searching";
    text = "Waiting for a frame… If the view doesn't animate, orbit or zoom it once.";
  } else if (!frames.size || states.every((x) => !x)) {
    cls = "";
    text = "Starting…";
  } else if (states.every((x) => x === "nocanvas") && blockedFrames) {
    cls = "";
    text = `This page has ${blockedFrames} cross-origin iframe${blockedFrames > 1 ? "s" : ""}, which Firefox doesn't let extensions inspect. Open the iframe's address in its own tab instead.`;
  } else if (states.every((x) => x === "nocanvas")) {
    cls = "";
    text = "No <canvas> on this page.";
  } else {
    cls = "";
    text = "No three.js scene found. Press Rescan and interact with the 3D view.";
  }
  $("dot").className = "dot " + cls;
  $("status").textContent = text;
  $("meta").textContent = s && s.state === "found"
    ? [s.revision && "three r" + s.revision, s.renderers ? `${s.renderers} renderer${s.renderers > 1 ? "s" : ""}` : "renderer not seen yet"].filter(Boolean).join(" · ")
    : "";
}

async function rescan() {
  for (const [key, f] of frames) {
    f.tree = null;
    f.signature = null;
    f.expandedOnce = false;
    await bridge.call(frameURL(key), "arm").catch(() => {});
  }
  select(null);
  renderTree();
  await scanFrames();
  poll();
}

function reset() {
  frames.clear();
  frameKey = "";
  expanded = new Set();
  select(null);
  renderTree();
  renderStatus();
}

/* ------------------------------- tree -------------------------------- */

function renderTree() {
  const f = current();
  const box = $("tree");
  if (!f || !f.tree) {
    box.replaceChildren();
    return;
  }
  const q = $("filter").value.trim().toLowerCase();
  const matches = (n) => !q || (n.name + " " + n.type).toLowerCase().includes(q);
  const keep = new Map(); // id -> has a matching descendant (or self)
  const mark = (n) => {
    let any = matches(n);
    for (const c of n.children || []) any = mark(c) || any;
    keep.set(n.id, any);
    return any;
  };
  f.tree.roots.forEach(mark);

  const out = [];
  const walk = (n, depth) => {
    if (q && !keep.get(n.id)) return;
    const kids = n.children || [];
    const open = q ? true : expanded.has(n.id);
    out.push(
      `<div class="node${n.id === selected ? " selected" : ""}${n.visible ? "" : " hidden"}" data-id="${esc(n.id)}" style="padding-left:${depth * 12 + 4}px">` +
        `<span class="caret" data-toggle>${kids.length ? (open ? "▾" : "▸") : ""}</span>` +
        `<span class="icon k-${n.kind}">${ICONS[n.kind] || "○"}</span>` +
        `<span class="name">${esc(n.name || "")}${n.name ? " " : ""}<span class="type">${esc(n.type)}</span></span>` +
        (n.tris ? `<span class="tris">${fmt(n.tris)}</span>` : `<span class="tris"></span>`) +
        `<span class="eye" data-eye title="Toggle visibility">${n.visible ? "👁" : "◌"}</span></div>`
    );
    if (open) kids.forEach((c) => walk(c, depth + 1));
  };
  f.tree.roots.forEach((r) => walk(r, 0));
  if (f.tree.truncated) out.push(`<div class="pad muted">Showing the first ${f.tree.count} objects.</div>`);
  setHTML(box, out.join(""));
}

$("tree").addEventListener("click", async (e) => {
  const row = e.target.closest(".node");
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.closest("[data-toggle]")) {
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    return renderTree();
  }
  if (e.target.closest("[data-eye]")) {
    const n = findNode(id);
    if (n) {
      await bridge.call(frameURL(frameKey), "setVisible", id, !n.visible);
      n.visible = !n.visible;
      renderTree();
      if (id === selected) refreshProps(true);
    }
    return;
  }
  select(id);
});
$("tree").addEventListener("dblclick", (e) => {
  const row = e.target.closest(".node");
  if (row) bridge.call(frameURL(frameKey), "flash", row.dataset.id);
});
$("filter").addEventListener("input", renderTree);
$("frame").addEventListener("change", (e) => {
  frameKey = e.target.value;
  select(null);
  renderTree();
  renderStatus();
});

function findNode(id, list = current()?.tree?.roots || []) {
  for (const n of list) {
    if (n.id === id) return n;
    const c = findNode(id, n.children || []);
    if (c) return c;
  }
  return null;
}

function select(id) {
  selected = id;
  lastProps = "";
  renderTree();
  if (!id) {
    setHTML($("props"), `<p class="muted pad">Select an object in the tree.</p>`);
    viewer.clear();
    showPreviewMsg("");
    loaded = null;
    updateExportInfo();
// The page is created when the panel is first opened, so start right away.
dispatchEvent(new Event("panel-shown"));
document.addEventListener("visibilitychange", () => dispatchEvent(new Event(document.hidden ? "panel-hidden" : "panel-shown")));
    return;
  }
  refreshProps(true);
  loadPreview();
}

/* ---------------------------- properties ----------------------------- */

async function refreshProps(force) {
  if (!selected) return;
  const props$ = $("props");
  if (!force && props$.contains(document.activeElement) && document.activeElement.tagName !== "BUTTON") return;
  let p;
  try {
    p = await bridge.call(frameURL(frameKey), "props", selected);
  } catch (_) {
    return;
  }
  const json = JSON.stringify(p);
  if (json === lastProps) return;
  lastProps = json;
  if (!p) {
    setHTML(props$, `<p class="muted pad">This object is no longer in the scene.</p>`);
    return;
  }
  const html = [`<h2>${esc(p.name || p.type)}<button id="flash" title="Blink the object in the page">Blink</button></h2>`];
  for (const s of p.sections) {
    html.push(`<h3>${esc(s.title)}</h3>`);
    for (const f of s.fields) html.push(fieldHTML(f));
  }
  setHTML(props$, html.join(""));
}

function fieldHTML(f) {
  const ro = !f.path;
  const p = ro ? "" : `data-path="${esc(f.path)}" data-type="${f.type}"`;
  const num = (v) => (typeof v === "number" ? +v.toFixed(5) : v);
  let val;
  switch (ro && f.type !== "texture" ? "text" : f.type) {
    case "string":
      val = `<input type="text" ${p} value="${esc(f.value)}">`;
      break;
    case "bool":
      val = `<input type="checkbox" ${p} ${f.value ? "checked" : ""}>`;
      break;
    case "number":
      val = f.min !== undefined && f.max !== undefined
        ? `<input type="range" ${p} min="${f.min}" max="${f.max}" step="${f.step || "any"}" value="${f.value}"><input class="num" type="number" ${p} step="${f.step || "any"}" value="${num(f.value)}">`
        : `<input type="number" ${p} step="${f.step || "any"}" value="${num(f.value)}">`;
      break;
    case "vec3":
      val = f.value.map((v, i) => `<input class="num" type="number" ${p} data-i="${i}" step="any" value="${num(v)}">`).join("");
      break;
    case "color":
      val = `<input type="color" ${p} value="${esc(f.value || "#000000")}"><span class="muted">${esc(f.value || "")}</span>`;
      break;
    case "enum":
      val = `<select ${p}>${f.options.map((o, i) => `<option value="${i}" ${i === f.value ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
      break;
    case "texture":
      val = (f.thumb ? `<img src="${esc(f.thumb)}" alt="">` : "") + `<span class="text">${esc(f.value)}</span>`;
      break;
    default:
      val = `<span class="text">${esc(f.value)}</span>`;
  }
  return `<div class="field"><span title="${esc(f.label)}">${esc(f.label)}</span><div class="val">${val}</div></div>`;
}

function readField(el) {
  const type = el.dataset.type;
  if (type === "bool") return el.checked;
  if (type === "number") return parseFloat(el.value);
  if (type === "enum") return parseInt(el.value, 10);
  if (type === "vec3") return [...el.parentElement.querySelectorAll("input")].map((i) => parseFloat(i.value) || 0);
  return el.value;
}

async function applyField(el) {
  const value = readField(el);
  if (typeof value === "number" && !Number.isFinite(value)) return;
  // Keep a range slider and its number box in sync.
  for (const twin of el.parentElement.querySelectorAll(`[data-path="${CSS.escape(el.dataset.path)}"]`))
    if (twin !== el && el.dataset.type === "number") twin.value = value;
  await bridge.call(frameURL(frameKey), "set", selected, el.dataset.path, value).catch(() => {});
  refreshPreviewSoon();
  if (el.dataset.path === "visible" || el.dataset.path === "name") {
    const n = findNode(selected);
    if (n) n[el.dataset.path] = value;
    renderTree();
  }
}

$("props").addEventListener("input", (e) => {
  const el = e.target.closest("[data-path]");
  if (el && el.type !== "text") applyField(el);
});
$("props").addEventListener("change", (e) => {
  const el = e.target.closest("[data-path]");
  if (el) applyField(el).then(() => refreshProps(true));
});
$("props").addEventListener("click", (e) => {
  if (e.target.id === "flash") bridge.call(frameURL(frameKey), "flash", selected);
});

/* ------------------------- preview and export ------------------------ */

async function fetchGeometry(id, visibleOnly) {
  const key = frameURL(frameKey);
  const meta = await bridge.call(key, "prepare", id, { visibleOnly });
  if (!meta) throw new Error("Object not found");
  try {
    const parts = [];
    for (let i = 0; i < meta.parts.length; i++) {
      const m = meta.parts[i];
      const bytes = new Uint8Array(m.byteLength);
      for (let off = 0; off < m.byteLength; off += CHUNK) {
        const b64 = await bridge.call(key, "chunk", meta.job, i, off, CHUNK);
        const bin = atob(b64);
        for (let j = 0; j < bin.length; j++) bytes[off + j] = bin.charCodeAt(j);
      }
      parts.push({ name: m.name, color: m.color, tris: new Float32Array(bytes.buffer) });
    }
    return { parts, skipped: meta.skipped };
  } finally {
    bridge.call(key, "release", meta.job).catch(() => {});
  }
}

async function loadPreview(force, keepCamera) {
  const id = selected;
  const visibleOnly = $("visibleOnly").checked;
  const n = findNode(id);
  const total = n ? subtreeTris(n) : 0;
  const seq = ++loadSeq;
  if (!total) {
    viewer.clear();
    loaded = null;
    $("previewInfo").textContent = "";
    showPreviewMsg("No meshes under this object.");
    return updateExportInfo();
// The page is created when the panel is first opened, so start right away.
dispatchEvent(new Event("panel-shown"));
document.addEventListener("visibilitychange", () => dispatchEvent(new Event(document.hidden ? "panel-hidden" : "panel-shown")));
  }
  if (total > PREVIEW_LIMIT && !force) {
    viewer.clear();
    loaded = null;
    $("previewInfo").textContent = "";
    showPreviewMsg(`${fmt(total)} triangles.<br><button id="forcePreview">Load preview</button>`);
    return updateExportInfo();
// The page is created when the panel is first opened, so start right away.
dispatchEvent(new Event("panel-shown"));
document.addEventListener("visibilitychange", () => dispatchEvent(new Event(document.hidden ? "panel-hidden" : "panel-shown")));
  }
  if (!keepCamera) {
    showPreviewMsg("Loading…");
    $("previewInfo").textContent = "";
  }
  try {
    const data = await fetchGeometry(id, visibleOnly);
    if (seq !== loadSeq) return;
    loaded = { frame: frameKey, id, visibleOnly, ...data };
    viewer.show(data.parts, keepCamera);
    const tris = data.parts.reduce((s, p) => s + p.tris.length / 9, 0);
    $("previewInfo").textContent = `${data.parts.length} mesh${data.parts.length === 1 ? "" : "es"} · ${fmt(tris)} triangles` +
      (data.skipped.length ? ` · no CPU data: ${data.skipped.length}` : "");
    showPreviewMsg(data.parts.length ? "" : "Nothing visible to preview.");
  } catch (err) {
    if (seq === loadSeq) showPreviewMsg(esc(err.message));
  }
  updateExportInfo();
// The page is created when the panel is first opened, so start right away.
dispatchEvent(new Event("panel-shown"));
document.addEventListener("visibilitychange", () => dispatchEvent(new Event(document.hidden ? "panel-hidden" : "panel-shown")));
}

// Edits can change what the preview shows (colors, morph targets, transforms
// inside a group): reload small previews shortly after the last edit.
let previewTimer = 0;
function refreshPreviewSoon() {
  clearTimeout(previewTimer);
  const n = findNode(selected);
  if (!n || subtreeTris(n) > 300_000) return;
  previewTimer = setTimeout(() => loadPreview(false, true), 350);
}

function subtreeTris(n) {
  return (n.tris || 0) + (n.children || []).reduce((s, c) => s + subtreeTris(c), 0);
}

function showPreviewMsg(html) {
  $("previewMsg").hidden = !html;
  setHTML($("previewMsg"), html);
}

$("previewMsg").addEventListener("click", (e) => {
  if (e.target.id === "forcePreview") loadPreview(true);
});
$("wireframe").addEventListener("change", (e) => viewer.setWireframe(e.target.checked));
$("visibleOnly").addEventListener("change", () => selected && loadPreview());
$("reload").addEventListener("click", () => selected && loadPreview(true));

function bounds(parts) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const p of parts)
    for (let i = 0; i < p.tris.length; i += 3)
      for (let c = 0; c < 3; c++) {
        const v = p.tris[i + c];
        if (v < b[c]) b[c] = v;
        if (v > b[c + 3]) b[c + 3] = v;
      }
  return b[0] === Infinity ? null : [b[3] - b[0], b[4] - b[1], b[5] - b[2]];
}

function updateExportInfo() {
  const size = loaded && loaded.parts.length ? bounds(loaded.parts) : null;
  const scale = parseFloat($("scale").value) || 0;
  const zUp = $("zUp").checked;
  let text = "";
  if (size) {
    const s = size.map((v) => v * scale);
    text = (zUp ? [s[0], s[2], s[1]] : s).map((v) => v.toFixed(1)).join(" × ") + " mm";
  } else if (selected) text = "load the preview to see the size";
  $("exportSize").textContent = text;
  for (const b of document.querySelectorAll("[data-export]")) b.disabled = !selected;
}

for (const id of ["scale", "zUp"]) $(id).addEventListener("input", updateExportInfo);
$("exportBox").open = localStorage.getItem("exportOpen") === "1";
$("exportBox").addEventListener("toggle", () => localStorage.setItem("exportOpen", $("exportBox").open ? "1" : "0"));
document.querySelector(".chips").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.scale) $("scale").value = b.dataset.scale;
  if (b.dataset.fit && loaded) {
    const size = bounds(loaded.parts);
    if (size) $("scale").value = +(parseFloat(b.dataset.fit) / Math.max(...size)).toPrecision(6);
  }
  updateExportInfo();
// The page is created when the panel is first opened, so start right away.
dispatchEvent(new Event("panel-shown"));
document.addEventListener("visibilitychange", () => dispatchEvent(new Event(document.hidden ? "panel-hidden" : "panel-shown")));
});

document.querySelector(".export").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-export]");
  if (!b || !selected) return;
  const format = b.dataset.export;
  const msg = $("exportMsg");
  msg.textContent = "Exporting…";
  try {
    const visibleOnly = $("visibleOnly").checked;
    const data = loaded && loaded.id === selected && loaded.frame === frameKey && loaded.visibleOnly === visibleOnly
      ? loaded
      : await fetchGeometry(selected, visibleOnly);
    if (!data.parts.length) throw new Error("No exportable meshes in the selection.");
    const scale = parseFloat($("scale").value) || 1;
    const parts = data.parts.map((p) => ({ ...p, tris: transform(p.tris, scale, $("zUp").checked) }));
    const buffer = format === "3mf" ? await write3MF(parts, $("separate").checked) : writeSTL(parts);
    const n = findNode(selected);
    const host = (() => {
      try {
        return new URL(current().url).hostname.replace(/^www\./, "");
      } catch (_) {
        return "scene";
      }
    })();
    const name = `${host}-${(n && (n.name || n.type)) || "object"}`.replace(/[^\w.-]+/g, "_").slice(0, 80) + "." + format;
    download(buffer, name, format === "3mf" ? "model/3mf" : "model/stl");
    const tris = parts.reduce((s, p) => s + p.tris.length / 9, 0);
    msg.textContent = `Saved ${name} (${fmt(tris)} triangles)`;
  } catch (err) {
    msg.textContent = err.message;
  }
});

function download(buffer, filename, type) {
  const url = URL.createObjectURL(new Blob([buffer], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ------------------------------ wiring ------------------------------- */

// Puts markup built by this panel into `el`. Every value that comes from the
// inspected page goes through esc() first.
function setHTML(el, html) {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html");
  el.replaceChildren(...doc.body.childNodes);
}

function esc(s) {
  return String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
}

function fmt(n) {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
}

function shortURL(u) {
  try {
    const x = new URL(u);
    return x.host + x.pathname;
  } catch (_) {
    return u;
  }
}

$("rescan").addEventListener("click", rescan);

// Nothing is injected until the panel is opened.
addEventListener("panel-shown", async () => {
  if (visible) return;
  visible = true;
  if (!started) {
    started = true;
    await scanFrames();
  }
  poll();
});
addEventListener("panel-hidden", () => {
  visible = false;
  clearTimeout(pollTimer);
});

bridge.onNavigated(async () => {
  reset();
  started = false;
  if (visible) {
    started = true;
    setTimeout(async () => {
      await scanFrames();
      poll();
    }, 500);
  }
});

// Frames that appear later (lazy iframes) get the agent on the next rescan;
// re-list frames now and then while the panel is open.
setInterval(() => visible && scanFrames(), 3000);
updateExportInfo();
// The page is created when the panel is first opened, so start right away.
dispatchEvent(new Event("panel-shown"));
document.addEventListener("visibilitychange", () => dispatchEvent(new Event(document.hidden ? "panel-hidden" : "panel-shown")));

