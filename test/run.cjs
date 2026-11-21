// E2E: load the extension, open each test page, "click" the action, interact,
// export STL + 3MF from the panel and validate the files.
const { chromium } = require("playwright-core");
const fs = require("fs"), path = require("path"), os = require("os");
const ext = fs.mkdtempSync(path.join(os.tmpdir(), "three-inspector-"));
fs.cpSync(path.join(__dirname, ".."), ext, { recursive: true, filter: (s) => !s.includes("/test") && !s.includes(".git") });
const mf = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json")));
mf.host_permissions = (process.env.HOST_PERMISSIONS || "<all_urls>").split(","); // tests can't click the toolbar icon, so activeTab is never granted
fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(mf));
const out = path.join(__dirname, "out");
fs.mkdirSync(out, { recursive: true });

const pages = (process.argv[2] || "a-loop,b-ondemand,c-old,f-host,e-webgpu").split(",");
const slug = (n) => n.replace(/^https?:\/\//, "").replace(/[^\w.-]+/g, "_").slice(0, 60);
const interact = {
  "b-ondemand": async (p) => { await p.mouse.move(400, 300); await p.mouse.down(); await p.mouse.move(450, 320, { steps: 5 }); await p.mouse.up(); },
  "c-old": async (p) => { await p.mouse.move(400, 300); await p.mouse.wheel(0, 100); },
  "f-host": async (p) => { await p.mouse.move(300, 300); await p.mouse.move(350, 320, { steps: 5 }); },
};

(async () => {
  const ctx = await chromium.launchPersistentContext("", {
    executablePath: process.env.CHROMIUM_PATH || undefined,
    channel: process.env.CHROMIUM_PATH ? undefined : "chromium", // full Chromium: headless shell has no extensions
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1100, height: 700 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  for (const name of pages) {
    const p = await ctx.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(/^https?:/.test(name) ? name : `http://127.0.0.1:8701/${name}.html`);
    if (/^https?:/.test(name)) await p.waitForTimeout(6000);
    else await p.waitForFunction(() => document.title === "loaded" || [...document.querySelectorAll("iframe")].length, null, { timeout: 20000 });
    await p.waitForTimeout(1500);
    await sw.evaluate(async (url) => { const [t] = await chrome.tabs.query({ url }); await self.grab(t.id); }, p.url());
    const panel = p.locator(".box");
    await panel.waitFor();
    await p.waitForTimeout(1200);
    const before = await p.locator(".body").innerText();
    if (interact[name]) await interact[name](p);
    else if (/^https?:/.test(name)) { await p.mouse.move(500, 400); await p.mouse.down(); await p.mouse.move(560, 420, { steps: 8 }); await p.mouse.up(); await p.mouse.wheel(0, -100); }
    if (process.env.TEST_GRANT && await p.locator("[data-grant]").waitFor({ timeout: 4000 }).then(() => 1, () => 0)) { const [w] = await Promise.all([ctx.waitForEvent("page"), p.click("[data-grant]")]); await w.waitForLoadState(); console.log("grant window:", w.url(), "|", (await w.locator("body").innerText()).replace(/\n+/g, " ")); }
    await p.locator(".root li").first().waitFor({ timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(800);
    // Patches must be gone in every frame once captured.
    const patched = [];
    for (const f of p.frames())
      patched.push(await f.evaluate(() => ({
        call: /native code/.test(Function.prototype.call.toString()),
        apply: /native code/.test(Function.prototype.apply.toString()),
        sort: /native code/.test(Array.prototype.sort.toString()),
        lod: !Object.prototype.hasOwnProperty("isLOD"),
      })).catch((e) => "err " + e.message));
    const listing = await p.locator(".body").innerText();
    console.log(`\n=== ${name}\nbefore interaction: ${before.split("\n")[0]}\n${listing}\nrestored: ${JSON.stringify(patched)}\nsize: ${await p.locator(".size").innerText()}`);
    for (const fmt of ["stl", "3mf"]) {
      if (await p.locator(`[data-x="${fmt}"]`).isDisabled()) { console.log(fmt, "disabled"); continue; }
      const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 30000 }), p.click(`[data-x="${fmt}"]`)]);
      const file = path.join(out, `${slug(name)}.${fmt}`);
      await dl.saveAs(file);
      console.log(fmt, "->", file, fs.statSync(file).size, "bytes;", await p.locator(".msg").last().innerText());
    }
    await p.screenshot({ path: path.join(out, `${slug(name)}.png`) });
    if (errors.length) console.log("page errors:", errors);
    await p.close();
  }
  await ctx.close();
})().catch((e) => { console.error(e); process.exit(1); });
