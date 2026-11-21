// Three Inspector — in-page panel (isolated world, top frame only).
// Talks to the hook in every frame through window.postMessage.
(() => {
  const KEY = "__threeInspectorPanel";
  if (window[KEY]) {
    window[KEY].show();
    return;
  }

  const MSG = "__threeInspector";
  const frames = new Map(); // token -> { source, info, data }
  const pending = new Map();
  let seq = 0;
  const selected = new Set();
  const opts = { scale: 1000, zUp: true, separate: true };

  /* ------------------------------ comms ------------------------------ */

  function send(source, token, cmd, args, timeout = 120000) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error("No response from frame"));
      }, timeout);
      pending.set(id, { resolve, reject, t });
      source.postMessage({ [MSG]: "cmd", id, token, cmd, args }, "*");
    });
  }

  function allWindows(w = window, out = []) {
    out.push(w);
    try {
      for (let i = 0; i < w.frames.length; i++) allWindows(w.frames[i], out);
    } catch (_) {}
    return out;
  }

  // Frames that didn't answer have no hook: the extension has no access to
  // their origin (activeTab only covers the top frame's origin).
  let blocked = [];
  function pingAll() {
    const answered = new Set();
    for (const w of allWindows()) {
      const id = ++seq;
      pending.set(id, {
        resolve: (info) => (answered.add(w), register(w, info)),
        reject() {},
        t: setTimeout(() => pending.delete(id), 3000),
      });
      try {
        w.postMessage({ [MSG]: "cmd", id, cmd: "ping" }, "*");
      } catch (_) {}
    }
    setTimeout(() => {
      const origins = new Set();
      for (const el of document.querySelectorAll("iframe")) {
        if (!el.contentWindow || answered.has(el.contentWindow)) continue;
        try {
          const u = new URL(el.src, location.href);
          if (/^https?:$/.test(u.protocol) && u.origin !== location.origin) origins.add(u.origin + "/*");
        } catch (_) {}
      }
      blocked = [...origins];
      render();
    }, 1500);
  }

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || typeof d !== "object" || !d[MSG]) return;
    if (d[MSG] === "res") {
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      clearTimeout(p.t);
      d.error ? p.reject(new Error(d.error)) : p.resolve(d.result);
    } else if (d[MSG] === "state" && d.frame) {
      register(e.source, d.frame);
    }
  });

  async function register(source, info) {
    if (!source || !info || !info.token) return;
    const f = frames.get(info.token) || { source, data: null };
    f.info = info;
    frames.set(info.token, f);
    if (info.state === "found" && info.meshes) {
      try {
        f.data = await send(source, info.token, "list");
        for (const r of f.data.roots)
          for (const m of r.meshes) {
            const key = info.token + "/" + m.id;
            if (m.visible && m.cpu && !f.seen?.has(key)) selected.add(key);
          }
        f.seen = new Set(f.data.roots.flatMap((r) => r.meshes.map((m) => info.token + "/" + m.id)));
      } catch (err) {
        f.error = err.message;
      }
    }
    render();
  }

  /* ------------------------------- UI -------------------------------- */

  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;top:12px;right:12px;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .box { width: 340px; max-height: calc(100vh - 24px); display: flex; flex-direction: column;
        font: 13px/1.4 system-ui, sans-serif; color: #e8e8ea; background: #1b1c20; border: 1px solid #34363c;
        border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.45); overflow: hidden; }
      header { display: flex; align-items: center; gap: 8px; padding: 9px 12px; background: #23252a;
        border-bottom: 1px solid #34363c; cursor: move; user-select: none; }
      header b { flex: 1; font-size: 14px; }
      header button { background: none; border: 0; color: #aaa; font-size: 16px; cursor: pointer; padding: 0 2px; }
      .body { overflow: auto; padding: 8px 12px; flex: 1; }
      .status { padding: 8px 10px; border-radius: 6px; background: #26282e; margin-bottom: 8px; }
      .status.searching::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-right: 7px;
        border-radius: 50%; background: #f5b942; animation: p 1s infinite alternate; }
      @keyframes p { to { opacity: .2; } }
      .root { margin: 6px 0 10px; }
      .root > .t { display: flex; gap: 6px; align-items: center; font-weight: 600; color: #b9bcc6; margin-bottom: 3px; }
      .root > .t small { font-weight: 400; color: #81848e; margin-left: auto; }
      .root > .t a { color: #7db3ff; cursor: pointer; font-weight: 400; font-size: 12px; }
      ul { list-style: none; margin: 0; padding: 0; }
      li { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
      li label { flex: 1; display: flex; gap: 6px; align-items: center; overflow: hidden; cursor: pointer; }
      li .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      li .n.off { color: #777; }
      li small { color: #81848e; white-space: nowrap; }
      .sw { width: 10px; height: 10px; border-radius: 2px; flex: none; border: 1px solid #0006; }
      li button { background: none; border: 0; color: #888; cursor: pointer; padding: 0 2px; font-size: 13px; }
      li button:hover { color: #fff; }
      footer { border-top: 1px solid #34363c; padding: 10px 12px; background: #202227; display: grid; gap: 8px; }
      .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      input[type=number] { width: 80px; background: #121316; color: inherit; border: 1px solid #3a3d44; border-radius: 5px; padding: 3px 6px; }
      .size { color: #9fd59f; }
      .btn { flex: 1; height: 32px; border-radius: 6px; border: 1px solid #3e6fd8; background: #2f5fc8; color: #fff;
        font-weight: 600; cursor: pointer; }
      .btn.alt { background: #2a2c33; border-color: #3a3d44; }
      .btn:disabled { opacity: .5; cursor: default; }
      .msg { color: #9aa0ac; font-size: 12px; }
      .err { color: #ff8b8b; }
      .grant { margin-top: 6px; width: 100%; flex: none; height: 28px; }
      .chips button { background: #2a2c33; border: 1px solid #3a3d44; color: #ccc; border-radius: 4px; padding: 1px 6px; cursor: pointer; font-size: 12px; }
    </style>
    <div class="box">
      <header><b>Three Inspector</b><button data-a="rearm" title="Search again">⟳</button><button data-a="close" title="Close">✕</button></header>
      <div class="body"></div>
      <footer>
        <div class="row"><span>Scale</span><input type="number" step="any" min="0" data-o="scale"> <span>mm per unit</span>
          <span class="chips"><button data-s="1">1</button> <button data-s="10">10</button> <button data-s="1000">1000</button> <button data-fit="100">→100 mm</button></span></div>
        <div class="row"><label><input type="checkbox" data-o="zUp"> Z up (slicers)</label>
          <label><input type="checkbox" data-o="separate"> 3MF: one object per mesh</label></div>
        <div class="row size"></div>
        <div class="row"><button class="btn" data-x="stl">Export STL</button><button class="btn" data-x="3mf">Export 3MF</button></div>
        <div class="msg"></div>
      </footer>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const body = $(".body");
  const msg = $(".msg");

  for (const el of root.querySelectorAll("[data-o]")) {
    const k = el.dataset.o;
    if (el.type === "checkbox") el.checked = opts[k];
    else el.value = opts[k];
    el.addEventListener("input", () => {
      opts[k] = el.type === "checkbox" ? el.checked : parseFloat(el.value) || 0;
      renderSize();
    });
  }
  root.addEventListener("click", (e) => {
    const t = e.target.closest("button,a");
    if (!t) return;
    if (t.dataset.a === "close") host.remove();
    if (t.dataset.a === "rearm") rearm();
    if (t.dataset.s) setScale(parseFloat(t.dataset.s));
    if (t.dataset.fit) {
      const s = selectionSize(1);
      if (s) setScale(parseFloat(t.dataset.fit) / Math.max(...s));
    }
    if (t.dataset.x) doExport(t.dataset.x);
    if (t.dataset.grant !== undefined) chrome.runtime.sendMessage({ type: "grant", origins: blocked });
    if (t.dataset.flash) {
      const [token, id] = t.dataset.flash.split("/");
      const f = frames.get(token);
      f && send(f.source, token, "flash", { id }).catch(() => {});
    }
    if (t.dataset.all !== undefined) {
      const [token, ri] = t.dataset.all.split("/");
      const ms = frames.get(token).data.roots[ri].meshes;
      const keys = ms.filter((m) => m.cpu).map((m) => token + "/" + m.id);
      const on = !keys.every((k) => selected.has(k));
      keys.forEach((k) => (on ? selected.add(k) : selected.delete(k)));
      render();
    }
  });
  body.addEventListener("change", (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    e.target.checked ? selected.add(k) : selected.delete(k);
    renderSize();
  });

  // Drag by header.
  $("header").addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    const r = host.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => {
      host.style.left = Math.max(0, ev.clientX - dx) + "px";
      host.style.top = Math.max(0, ev.clientY - dy) + "px";
      host.style.right = "auto";
    };
    const up = () => (removeEventListener("pointermove", move), removeEventListener("pointerup", up));
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  });

  function setScale(v) {
    opts.scale = +v.toPrecision(6);
    $('[data-o="scale"]').value = opts.scale;
    renderSize();
  }

  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
  const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + " M" : n >= 1e3 ? (n / 1e3).toFixed(1) + " k" : String(n));

  function selectedMeshes() {
    const out = [];
    for (const [token, f] of frames)
      for (const r of f.data?.roots || []) for (const m of r.meshes) if (selected.has(token + "/" + m.id)) out.push(m);
    return out;
  }

  function selectionSize(scale) {
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    let any = false;
    for (const m of selectedMeshes())
      if (m.box) {
        any = true;
        for (let c = 0; c < 3; c++) (box[c] = Math.min(box[c], m.box[c])), (box[c + 3] = Math.max(box[c + 3], m.box[c + 3]));
      }
    if (!any) return null;
    const s = [box[3] - box[0], box[4] - box[1], box[5] - box[2]].map((v) => v * scale);
    return opts.zUp ? [s[0], s[2], s[1]] : s;
  }

  function renderSize() {
    const ms = selectedMeshes();
    const s = selectionSize(opts.scale);
    const tris = ms.reduce((a, m) => a + m.tris, 0);
    $(".size").textContent = ms.length
      ? `${ms.length} mesh(es) · ${fmt(tris)} triangles` + (s ? ` · ${s.map((v) => v.toFixed(1)).join(" × ")} mm` : "")
      : "Nothing selected";
    for (const b of root.querySelectorAll("[data-x]")) b.disabled = !ms.length;
  }

  function render() {
    const list = [...frames.entries()];
    const found = list.filter(([, f]) => f.data && f.data.roots.some((r) => r.meshes.length));
    const searching = list.some(([, f]) => f.info.state === "searching");
    const canvas = list.some(([, f]) => f.info.state !== "nocanvas");
    let html = "";
    if (!found.length) {
      html += searching
        ? `<div class="status searching">Looking for three.js… Orbit, zoom or move the model so it renders.</div>`
        : !list.length
          ? `<div class="status">Starting…</div>`
          : canvas
            ? `<div class="status">No three.js scene found. Press ⟳ and interact with the viewer.</div>`
            : `<div class="status">No &lt;canvas&gt; on this page${blocked.length ? " (outside the iframes below)" : ""}.</div>`;
    }
    if (blocked.length)
      html += `<div class="status">No access to ${blocked.length} cross-origin iframe(s): ${blocked.map((o) => esc(o.slice(0, -2).replace(/^https?:\/\//, ""))).join(", ")}.
        <button class="btn alt grant" data-grant>Grant access and search there</button></div>`;
    for (const [token, f] of found) {
      const multi = found.length > 1 || f.data.url !== location.href;
      for (const [ri, r] of f.data.roots.entries()) {
        if (!r.meshes.length) continue;
        const tris = r.meshes.reduce((a, m) => a + m.tris, 0);
        html += `<div class="root"><div class="t">${esc(r.label)} <a data-all="${token}/${ri}">all/none</a>
          <small>${f.data.revision ? "r" + esc(f.data.revision) + " · " : ""}${r.meshes.length} meshes · ${fmt(tris)} tris</small></div>
          ${multi ? `<div class="msg">${esc(new URL(f.data.url).host)}</div>` : ""}<ul>`;
        for (const m of r.meshes) {
          const k = token + "/" + m.id;
          html += `<li><label title="${esc(m.name)} (${esc(m.type)})"><input type="checkbox" data-k="${k}" ${selected.has(k) ? "checked" : ""} ${m.cpu ? "" : "disabled"}>
            <span class="sw" style="background:${m.color || "#888"}"></span><span class="n ${m.visible ? "" : "off"}">${esc(m.name)}</span></label>
            <small>${m.cpu ? fmt(m.tris) : "GPU only"}</small><button data-flash="${k}" title="Blink in the scene">◉</button></li>`;
        }
        html += `</ul></div>`;
      }
    }
    if (found.length && searching) html += `<div class="msg">Looking for more scenes…</div>`;
    body.innerHTML = html;
    renderSize();
  }

  async function doExport(format) {
    const byFrame = new Map();
    for (const k of selected) {
      const [token, id] = k.split("/");
      if (!frames.get(token)?.data) continue;
      (byFrame.get(token) || byFrame.set(token, []).get(token)).push(id);
    }
    msg.className = "msg";
    msg.textContent = "Exporting…";
    try {
      for (const [token, ids] of byFrame) {
        const f = frames.get(token);
        const r = await send(f.source, token, "export", { ids, format, ...opts });
        download(r.buffer, r.filename, format);
        msg.textContent = `Saved ${r.filename} (${fmt(r.tris)} triangles)` + (r.skipped.length ? ` · no data: ${r.skipped.join(", ")}` : "");
      }
    } catch (err) {
      msg.className = "msg err";
      msg.textContent = err.message;
    }
  }

  function download(buffer, filename, format) {
    const type = format === "3mf" ? "model/3mf" : "model/stl";
    const url = URL.createObjectURL(new Blob([buffer], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    root.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function rearm() {
    selected.clear();
    for (const [token, f] of frames) {
      f.data = null;
      f.seen = null;
      send(f.source, token, "rearm").then((info) => register(f.source, info), () => {});
    }
    render();
  }

  window[KEY] = {
    show() {
      if (!host.isConnected) document.documentElement.appendChild(host);
      pingAll();
    },
  };
  document.documentElement.appendChild(host);
  render();
  pingAll();
})();
