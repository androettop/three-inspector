// End-to-end test in Firefox through the real DevTools toolbox: installs the
// extension as a temporary add-on, opens the "Three" panel on each test page,
// edits a property, exports STL + 3MF and checks that every patch was removed.
// Drives Firefox with its built-in Marionette protocol (no geckodriver).
//
//   node firefox.cjs [page,page,...]       (needs `npm run serve`)
const net = require("net");
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os");

const EXT = path.join(__dirname, "..");
const OUT = path.join(__dirname, "out", "firefox");
const PORT = 2829;
const PAGES = (process.argv[2] || "a-loop,b-ondemand,c-old,f-host,g-samehost,e-webgpu").split(",");
const pageURL = (n) => (/^https?:/.test(n) ? n : `http://127.0.0.1:8701/${n}.html`);
const slug = (n) => n.replace(/^https?:\/\//, "").replace(/[^\w.-]+/g, "_").slice(0, 60);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Minimal Marionette client: messages are "<length>:<json>". */
class Marionette {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.id = 0;
    this.pending = new Map();
    this.greeting = new Promise((r) => (this.onGreeting = r));
    socket.on("data", (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      for (;;) {
        const colon = this.buf.indexOf(":");
        if (colon < 0) return;
        const len = parseInt(this.buf.subarray(0, colon).toString(), 10);
        if (this.buf.length < colon + 1 + len) return;
        const msg = JSON.parse(this.buf.subarray(colon + 1, colon + 1 + len).toString());
        this.buf = this.buf.subarray(colon + 1 + len);
        if (!Array.isArray(msg)) this.onGreeting(msg);
        else {
          const [, id, error, result] = msg;
          const p = this.pending.get(id);
          this.pending.delete(id);
          error ? p.reject(new Error(error.message || error.error)) : p.resolve(result);
        }
      }
    });
  }
  send(name, params = {}) {
    const id = ++this.id;
    const body = JSON.stringify([0, id, name, params]);
    this.socket.write(Buffer.byteLength(body) + ":" + body);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async context(value) {
    await this.send("Marionette:SetContext", { value });
  }
  async script(source, args = []) {
    const r = await this.send("WebDriver:ExecuteAsyncScript", { script: source, args, scriptTimeout: 60000 });
    return r.value;
  }
}

async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const socket = await new Promise((resolve, reject) => {
        const s = net.connect(PORT, "127.0.0.1", () => resolve(s));
        s.on("error", reject);
      });
      const m = new Marionette(socket);
      await m.greeting;
      return m;
    } catch (_) {
      await sleep(300);
    }
  }
  throw new Error("Marionette did not start");
}

// Chrome-context helpers: open the toolbox of the selected tab on the Three
// panel, then evaluate code inside the panel page through the DevTools
// commands API (the same path about:debugging uses for extensions).
const PANEL = `
  const { require } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");
  const { gDevTools } = require("devtools/client/framework/devtools");
  const { CommandsFactory } = require("devtools/shared/commands/commands-factory");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function openThree() {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const toolbox = await gDevTools.showToolboxForTab(win.gBrowser.selectedTab, { hostType: "bottom" });
    let tool;
    for (let i = 0; i < 100 && !tool; i++) {
      tool = toolbox.getAdditionalTools().find((t) => t.label === "Three");
      if (!tool) await wait(100);
    }
    if (!tool) throw new Error("Three panel not registered");
    if (toolbox.currentToolId !== tool.id) await toolbox.selectTool(tool.id);
    return win;
  }
  async function panelEval(expression) {
    const win = await openThree();
    if (!win.__threeInspectorCommands) {
      const commands = await CommandsFactory.forAddon("three-inspector@androettop");
      await commands.targetCommand.startListening();
      win.__threeInspectorCommands = commands;
    }
    const c = win.__threeInspectorCommands;
    let target;
    for (let i = 0; i < 100 && !target; i++) {
      target = c.targetCommand.getAllTargets([c.targetCommand.TYPES.FRAME]).filter((t) => t.url.includes("/src/devtools/panel.html")).pop();
      if (!target) await wait(100);
    }
    if (!target) throw new Error("panel page not loaded");
    const r = await c.scriptCommand.execute("JSON.stringify((" + expression + ") ?? null)", { selectedTargetFront: target });
    if (r.exceptionMessage) throw new Error(r.exceptionMessage);
    return typeof r.result === "string" ? JSON.parse(r.result) : null;
  }
`;

// Evaluates an expression in the Three panel page and returns its value.
async function inPanel(m, expression) {
  return m.script(`const done = arguments[arguments.length - 1];
    ${PANEL}
    panelEval(${JSON.stringify(expression)}).then((v) => done(v), (e) => done("ERR " + e.message));`);
}

async function waitFor(fn, timeout = 20000, label = "condition") {
  let last;
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(300)) {
    const v = await fn().catch((e) => "ERR " + e.message);
    if (v && !(typeof v === "string" && v.startsWith("ERR "))) return v;
    last = v;
  }
  throw new Error(`timeout waiting for ${label}${last ? " (" + last + ")" : ""}`);
}

const interact = {
  "b-ondemand": [{ type: "pointer", id: "mouse", actions: [{ type: "pointerMove", x: 400, y: 300 }, { type: "pointerDown", button: 0 }, { type: "pointerMove", x: 450, y: 320, duration: 200 }, { type: "pointerUp", button: 0 }] }],
  "c-old": [{ type: "wheel", id: "wheel", actions: [{ type: "scroll", x: 400, y: 200, deltaX: 0, deltaY: 100 }] }],
  "g-samehost": [{ type: "pointer", id: "mouse", actions: [{ type: "pointerMove", x: 300, y: 200 }, { type: "pointerMove", x: 350, y: 220, duration: 200 }] }],
  "f-host": [{ type: "pointer", id: "mouse", actions: [{ type: "pointerMove", x: 300, y: 200 }, { type: "pointerMove", x: 350, y: 220, duration: 200 }] }],
};

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "three-inspector-ff-"));
  const prefs = {
    "marionette.port": PORT,
    "devtools.toolbox.host": "bottom",
    "devtools.chrome.enabled": true,
    "browser.shell.checkDefaultBrowser": false,
    "browser.startup.homepage_override.mstone": "ignore",
    "datareporting.policy.dataSubmissionEnabled": false,
    "browser.download.folderList": 2,
    "browser.download.dir": OUT,
    "browser.download.useDownloadDir": true,
    "browser.download.always_ask_before_handling_new_types": false,
    "browser.download.alwaysOpenPanel": false,
  };
  fs.writeFileSync(path.join(profile, "user.js"), Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n"));
  // Headless Firefox has no WebGL without a GPU context: when DISPLAY is set,
  // run with a window instead (HEADLESS=1 forces headless).
  const headless = !process.env.DISPLAY || process.env.HEADLESS === "1";
  const args = ["--marionette", "--remote-allow-system-access", "--no-remote", "--profile", profile, "--width", "1400", "--height", "1000"];
  const proc = spawn(process.env.FIREFOX_PATH || "firefox", headless ? ["--headless", ...args] : args, { stdio: "ignore" });
  let failures = 0;
  try {
    const m = await connect();
    await m.send("WebDriver:NewSession", { capabilities: {} });
    await m.send("Addon:Install", { path: EXT, temporary: true });

    for (const name of PAGES) {
      const url = pageURL(name);
      console.log(`\n=== ${name}`);
      try {
        await m.context("content");
        await m.send("WebDriver:Navigate", { url });
        if (/^https?:\/\/127/.test(url))
          await waitFor(async () => (await m.send("WebDriver:ExecuteScript", { script: `return document.title === "loaded" || !!document.querySelector("iframe")` })).value, 20000, "page");
        await sleep(1500);

        await m.context("chrome");
        await waitFor(() => inPanel(m, `document.getElementById("status").textContent`), 20000, "panel");
        await sleep(1500);
        const before = await inPanel(m, `document.getElementById("status").textContent`);
        console.log("before interaction:", before);
        // Firefox can't reach cross-origin iframes: the panel must say so.
        if (name === "f-host") {
          console.log(/cross-origin iframe/.test(before) ? "expected: cross-origin iframe reported" : "FAILED: no cross-origin notice");
          if (!/cross-origin iframe/.test(before)) failures++;
          continue;
        }
        // Interact until the panel shows the tree (on-demand pages only render then).
        const end = Date.now() + 30000;
        for (;;) {
          if (interact[name]) {
            await m.context("content");
            await m.send("WebDriver:PerformActions", { actions: interact[name] });
            await m.send("WebDriver:ReleaseActions");
            await m.context("chrome");
          }
          if ((await inPanel(m, `document.querySelectorAll(".node").length`).catch(() => 0)) > 0) break;
          if (Date.now() > end) throw new Error("timeout waiting for scene tree");
          await sleep(1500);
        }
        console.log("status:", await inPanel(m, `document.getElementById("status").textContent + " | " + document.getElementById("meta").textContent`));

        await m.context("content");
        const restored = (await m.send("WebDriver:ExecuteScript", { script: `
          const out = [];
          const check = (w) => { try { const p = w.wrappedJSObject || w;
            out.push([p.Function.prototype.call, p.Function.prototype.apply, p.Array.prototype.sort].every((f) => /native code/.test(p.Function.prototype.toString.apply(f))) && !p.Object.prototype.hasOwnProperty("isLOD"));
            for (let i = 0; i < w.frames.length; i++) check(w.frames[i]); } catch (e) { out.push("cross-origin"); } };
          check(window); return out;` })).value;
        console.log("patches removed:", JSON.stringify(restored));
        await m.context("chrome");

        // Select the first mesh and edit its position from the panel.
        await inPanel(m, `(() => { let c; while ((c = [...document.querySelectorAll(".caret")].find((c) => c.textContent === "▸"))) c.click();
          [...document.querySelectorAll(".node")].find((n) => /icon k-(mesh|skinned|instanced)/.test(n.innerHTML)).click(); })()`);
        await waitFor(() => inPanel(m, `!!document.querySelector('[data-path="position"][data-i="1"]')`), 10000, "props");
        await inPanel(m, `(() => { const el = document.querySelector('[data-path="position"][data-i="1"]'); el.value = "0.25"; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
        // Force a props refresh: the panel re-renders the field from the page's value.
        await inPanel(m, `document.getElementById("tree").click()`);
        await sleep(1500);
        const value = await inPanel(m, `document.querySelector('[data-path="position"][data-i="1"]').value`);
        console.log("edit position.y = 0.25 ->", value === "0.25" ? "applied" : "NOT applied: " + value);

        // Select the root, wait for the preview and export.
        await inPanel(m, `document.querySelector(".node").click()`);
        console.log("preview:", await waitFor(async () => { const t = await inPanel(m, `document.getElementById("previewInfo").textContent`); return /triangle/.test(t) && t; }, 30000, "preview"));
        for (const fmt of ["stl", "3mf"]) {
          await inPanel(m, `document.querySelector('[data-export="${fmt}"]').click()`);
          const msg = await waitFor(async () => { const t = await inPanel(m, `document.getElementById("exportMsg").textContent`); return /Saved|No |rror/.test(t) && t; }, 30000, "export");
          console.log(fmt + ":", msg);
          await inPanel(m, `document.getElementById("exportMsg").textContent = ""`);
        }
        const shot = await m.send("WebDriver:TakeScreenshot", { full: false });
        fs.writeFileSync(path.join(OUT, `${slug(name)}.png`), Buffer.from(shot.value, "base64"));
      } catch (err) {
        failures++;
        console.log("FAILED:", err.message);
        try {
          await m.context("chrome");
          console.log("  panel status:", await inPanel(m, `document.getElementById("status").textContent`));
          await m.context("content");
          console.log("  page agent:", (await m.send("WebDriver:ExecuteScript", { script: `const a = (window.wrappedJSObject || window)[Symbol.for("threeInspector.agent")]; return a ? JSON.stringify(a.status()) : "none";` })).value);
        } catch (_) {}
      }
    }
    await sleep(1500);
    for (const f of fs.readdirSync(OUT)) if (/\.(stl|3mf)$/.test(f)) console.log("file:", f, fs.statSync(path.join(OUT, f)).size);
  } finally {
    proc.kill();
  }
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
