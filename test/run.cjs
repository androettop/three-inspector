// End-to-end test through the real DevTools: opens each test page with
// DevTools attached, selects the "Three" panel, waits for the scene, edits a
// property, exports STL + 3MF and checks that every patch was removed.
//
//   node run.cjs [page,page,...|url]
const fs = require("fs"), path = require("path");
const { launch, waitFor, sleep } = require("./lib.cjs");

const OUT = path.join(__dirname, "out");
const PAGES = (process.argv[2] || "a-loop,b-ondemand,c-old,f-host,g-samehost,e-webgpu").split(",");
const pageURL = (n) => (/^https?:/.test(n) ? n : `http://127.0.0.1:8701/${n}.html`);
const slug = (n) => n.replace(/^https?:\/\//, "").replace(/[^\w.-]+/g, "_").slice(0, 60);

// Pages that only render on input.
const interact = {
  "b-ondemand": async (p) => { await p.mouse.move(400, 300); await p.mouse.down(); await p.mouse.move(450, 320, { steps: 5 }); await p.mouse.up(); },
  "c-old": async (p) => { await p.mouse.move(400, 300); await p.mouse.wheel(0, 100); },
  "g-samehost": async (p) => { await p.mouse.move(300, 300); await p.mouse.move(350, 320, { steps: 5 }); },
  "f-host": async (p) => { await p.mouse.move(300, 300); await p.mouse.move(350, 320, { steps: 5 }); },
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const { cdp } = browser;
  let failures = 0;

  for (const name of PAGES) {
    const url = pageURL(name);
    console.log(`\n=== ${name}`);
    const dir = path.join(OUT, slug(name));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir });
    let tab = null;
    try {
      tab = await browser.open(url, {
        dock: process.env.DOCK,
        ready: async (page) => {
          if (/^https?:\/\/127/.test(url)) await page.waitForFunction(() => document.title === "loaded" || document.querySelector("iframe"), null, { timeout: 20000 });
          else await page.waitForTimeout(5000);
          await page.waitForTimeout(1000);
        },
      });
      const { page, dt, panel } = tab;
      const text = panel.text;
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
      const frameForAgent = page.frames().find((f) => f.url() === (name === "f-host" ? "http://127.0.0.1:8702/d-iframe.html" : name === "g-samehost" ? "http://127.0.0.1:8701/d-iframe.html" : url)) || page.mainFrame();
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
    } catch (err) {
      failures++;
      console.log("FAILED:", err.message);
    } finally {
      if (tab) await tab.close().catch(() => {});
    }
  }
  await sleep(1000);
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
