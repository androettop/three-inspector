// Shared helpers: launch Chromium with the extension and DevTools, and drive
// the "Three" panel through a minimal Chrome DevTools Protocol client.
const { chromium } = require("playwright-core");
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os");

const EXT = path.join(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 15000, label = "condition") {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(250)) {
    const v = await fn().catch(() => null);
    if (v) return v;
  }
  throw new Error("timeout waiting for " + label);
}

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
      send: (method, params) => this.send(method, params, sessionId),
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
    return waitFor(async () => (await this.send("Target.getTargets")).targetInfos.find(match), timeout, "target");
  }
}

async function launch({ width = 1400, height = 1000, scale = 1 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "three-inspector-"));
  const exe = process.env.CHROMIUM_PATH || chromium.executablePath();
  const proc = spawn(exe, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--auto-open-devtools-for-tabs",
    "--use-angle=swiftshader", "--enable-unsafe-swiftshader", `--window-size=${width},${height}`,
    `--force-device-scale-factor=${scale}`, "about:blank",
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

  // Opens `url` in a new tab, waits for it, and selects the Three panel in
  // the DevTools window attached to it.
  async function open(url, { ready, dock } = {}) {
    const before = new Set(pw.contexts()[0].pages());
    const { targetId } = await cdp.send("Target.createTarget", { url });
    const page = await waitFor(async () => pw.contexts()[0].pages().find((p) => !before.has(p) && p.url() === url), 10000, "page");
    if (ready) await ready(page);
    const host = new URL(url).host;
    const dtTarget = await cdp.target((t) => t.type === "page" && t.url.startsWith("devtools://") && t.title.includes(host));
    const dt = await cdp.attach(dtTarget.targetId);
    // Extension panels may sit in the overflow menu; open it through the
    // DevTools frontend's own view manager.
    await waitFor(() => dt.eval(`(async () => {
      const UI = await import("./ui/legacy/legacy.js");
      const view = UI.InspectorView.InspectorView.instance();
      const id = view.tabbedPane.tabIds().find((t) => t.endsWith("Three"));
      if (!id) return false;
      await view.showPanel(id);
      ${dock ? `UI.DockController.DockController.instance().setDockSide(${JSON.stringify(dock)});` : ""}
      return true; })()`), 15000, "Three tab");
    const panelTarget = await cdp.target((t) => t.url.includes("/src/devtools/panel.html"));
    const panel = await cdp.attach(panelTarget.targetId);
    // textContent: works inside the collapsed Export section too.
    panel.text = (sel) => panel.eval(`(document.querySelector(${JSON.stringify(sel)})?.textContent ?? "").trim()`);
    return { page, dt, panel, targetId, close: () => cdp.send("Target.closeTarget", { targetId }) };
  }

  return { cdp, pw, open, close: async () => { await pw.close().catch(() => {}); proc.kill(); } };
}

module.exports = { launch, waitFor, sleep };
