// End-to-end test through the real DevTools: opens each test page with
// DevTools attached, selects the "Three" panel, waits for the scene, edits a
// property, exports STL + 3MF and checks that every patch was removed.
//
//   node run.cjs [page,page,...|url]
const { chromium } = require("playwright-core");
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os");

const EXT = path.join(__dirname, "..");
const OUT = path.join(__dirname, "out");
const PAGES = (process.argv[2] || "a-loop,b-ondemand,c-old,f-host,e-webgpu").split(",");
const pageURL = (n) => (/^https?:/.test(n) ? n : `http://127.0.0.1:8701/${n}.html`);
const slug = (n) => n.replace(/^https?:\/\//, "").replace(/[^\w.-]+/g, "_").slice(0, 60);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pages that only render on input.
const interact = {
  "b-ondemand": async (p) => { await p.mouse.move(400, 300); await p.mouse.down(); await p.mouse.move(450, 320, { steps: 5 }); await p.mouse.up(); },
  "c-old": async (p) => { await p.mouse.move(400, 300); await p.mouse.wheel(0, 100); },
  "f-host": async (p) => { await p.mouse.move(300, 300); await p.mouse.move(350, 320, { steps: 5 }); },
};

/* Minimal CDP client (flattened sessions) */
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const p = m.id && this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    };
    this.ready = new Promise((r) => (this.ws.onopen = r));
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async attach(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return {
      shot: async (file) => {
        const { data } = await this.send("Page.captureScreenshot", { format: "png" }, sessionId);
        fs.writeFileSync(file, Buffer.from(data, "base64"));
      },
      eval: async (expression) => {
        const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      },
    };
  }
  async target(match, timeout = 15000) {
    for (const end = Date.now() + timeout; Date.now() < end; await sleep(200)) {
      const { targetInfos } = await this.send("Target.getTargets");
      const t = targetInfos.find(match);
      if (t) return t;
    }
    throw new Error("target not found");
  }
}

async function waitFor(fn, timeout = 15000, label = "condition") {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(250)) {
    const v = await fn().catch(() => null);
    if (v) return v;
  }
  throw new Error("timeout waiting for " + label);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "three-inspector-"));
  const exe = process.env.CHROMIUM_PATH || chromium.executablePath();
  const proc = spawn(exe, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--auto-open-devtools-for-tabs",
    "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--window-size=1400,1000", "about:blank",
  ]);
  const wsURL = await new Promise((resolve, reject) => {
    let buf = "";
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) resolve(m[1]);
    });
    proc.on("exit", () => reject(new Error("browser exited:\n" + buf)));
  });
  const cdp = new CDP(wsURL);
  await cdp.ready;
  const pw = await chromium.connectOverCDP(wsURL);
  let failures = 0;

  for (const name of PAGES) {
    const url = pageURL(name);
    console.log(`\n=== ${name}`);
    const dir = path.join(OUT, slug(name));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir });
    try {
      const { targetId } = await cdp.send("Target.createTarget", { url });
      const page = await waitFor(async () => pw.contexts()[0].pages().find((p) => p.url() === url), 10000, "page");
      if (/^https?:\/\/127/.test(url)) await page.waitForFunction(() => document.title === "loaded" || document.querySelector("iframe"), null, { timeout: 20000 });
      else await page.waitForTimeout(5000);
      await page.waitForTimeout(1000);

      // The DevTools window opened for this tab, then the "Three" tab in it.
      const dtTarget = await cdp.target((t) => t.type === "page" && t.url.startsWith("devtools://") && !t.attachedTo && t.title.includes(new URL(url).host));
      const dt = await cdp.attach(dtTarget.targetId);
      // Extension panels may sit in the overflow menu; open it through the
      // DevTools frontend's own view manager.
      await waitFor(() => dt.eval(`(async () => {
        const UI = await import("./ui/legacy/legacy.js");
        const pane = UI.InspectorView.InspectorView.instance().tabbedPane;
        const id = pane.tabIds().find((t) => t.endsWith("Three"));
        if (!id) return false;
        await UI.InspectorView.InspectorView.instance().showPanel(id);
        if (${JSON.stringify(process.env.DOCK || "")}) UI.DockController.DockController.instance().setDockSide(${JSON.stringify(process.env.DOCK || "")});
        return true; })()`), 15000, "Three tab");
      const panelTarget = await cdp.target((t) => t.url.includes("/src/devtools/panel.html"));
      const panel = await cdp.attach(panelTarget.targetId);
      const text = (sel) => panel.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ""`);

      await sleep(1500);
      console.log("before interaction:", await text("#status"));
      if (interact[name]) await interact[name](page);
      await waitFor(async () => (await text("#tree")).length > 0, 20000, "scene tree");
      console.log("status:", await text("#status"), "|", await text("#meta"));
      console.log("tree:", (await panel.eval(`[...document.querySelectorAll(".node")].map(n => n.innerText.replace(/\\s+/g, " ").trim()).join(" / ")`)).slice(0, 300));

      // Patches must be gone in every frame.
      const restored = [];
      for (const f of page.frames())
        restored.push(await f.evaluate(() => [Function.prototype.call, Function.prototype.apply, Array.prototype.sort].every((fn) => /native code/.test(fn.toString())) && !Object.prototype.hasOwnProperty("isLOD")).catch((e) => e.message));
      console.log("patches removed:", restored);

      // Expand the whole tree, select the first mesh, edit its position and
      // read it back in the page.
      for (let i = 0; i < 30; i++) {
        const more = await panel.eval(`(() => { const c = [...document.querySelectorAll(".caret")].find((c) => c.textContent === "▸"); if (c) c.click(); return !!c; })()`);
        if (!more) break;
        await sleep(50);
      }
      await panel.eval(`(() => { const n = [...document.querySelectorAll(".node")].find(n => /icon k-(mesh|skinned|instanced)/.test(n.innerHTML)); n.click(); return n.dataset.id; })()`);
      const meshId = await panel.eval(`document.querySelector(".node.selected").dataset.id`);
      await waitFor(() => panel.eval(`!!document.querySelector('[data-path="position"]')`), 10000, "props");
      await panel.eval(`(() => { const el = document.querySelector('[data-path="position"][data-i="1"]'); el.value = "0.25"; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await sleep(400);
      const frameForAgent = page.frames().find((f) => f.url() === (name === "f-host" ? "http://127.0.0.1:8702/d-iframe.html" : url)) || page.mainFrame();
      const pos = await frameForAgent.evaluate((id) => window[Symbol.for("threeInspector.agent")].props(id).sections[0].fields.find((f) => f.path === "position").value, meshId);
      console.log("edit position.y = 0.25 ->", pos[1] === 0.25 ? "applied" : "NOT applied " + pos);

      // Select the root and export everything.
      await panel.eval(`document.querySelector(".node").click()`);
      await waitFor(async () => /triangle/.test(await text("#previewInfo")), 30000, "preview");
      console.log("preview:", await text("#previewInfo"), "| size:", await text("#exportSize"));
      for (const fmt of ["stl", "3mf"]) {
        await panel.eval(`document.querySelector('[data-export="${fmt}"]').click()`);
        const msg = await waitFor(async () => { const t = await text("#exportMsg"); return /Saved|No |rror/.test(t) && t; }, 30000, "export");
        console.log(fmt + ":", msg);
      }
      await page.screenshot({ path: path.join(OUT, `${slug(name)}.png`) });
      // Leave a mesh selected and capture the DevTools window.
      await panel.eval(`[...document.querySelectorAll(".node")].find((n) => /icon k-(mesh|skinned)/.test(n.innerHTML) && /k\\b|M/.test(n.querySelector(".tris").textContent))?.click()`);
      await sleep(2500);
      await dt.shot(path.join(OUT, `${slug(name)}-devtools${process.env.DOCK ? "-" + process.env.DOCK : ""}.png`));
      await cdp.send("Target.closeTarget", { targetId });
    } catch (err) {
      failures++;
      console.log("FAILED:", err.message);
    }
  }
  await sleep(1000);
  await pw.close().catch(() => {});
  proc.kill();
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
