// Store screenshots (1280×800): the demo page with DevTools docked at the
// bottom, after making real edits through the Three panel.
//   node screenshots.cjs   (needs `npm run serve`)
const fs = require("fs"), path = require("path"), os = require("os");
const { execFileSync } = require("child_process");
const { launch, waitFor, sleep } = require("./lib.cjs");

const OUT = path.join(__dirname, "..", "store", "screenshots");
const URL_ = "http://127.0.0.1:8701/demo.html";

// Panel helpers, evaluated inside the panel document.
const HELPERS = `
  window.$sel = (name) => { const n = [...document.querySelectorAll(".node")].find((n) => n.querySelector(".name").firstChild.textContent.trim() === name); n.click(); };
  window.$expand = () => { let c; while ((c = [...document.querySelectorAll(".caret")].find((c) => c.textContent === "▸"))) c.click(); };
  window.$field = (label) => [...document.querySelectorAll(".field")].find((f) => f.firstElementChild.textContent === label);
  window.$set = (label, value, i) => { const f = $field(label); const el = i === undefined ? f.querySelector("[data-path]:not([type=range])") || f.querySelector("[data-path]") : f.querySelectorAll("input")[i];
    if (el.type === "checkbox") el.checked = value; else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
  window.$scrollTo = (title) => { const h = [...document.querySelectorAll("#props h3")].filter((h) => h.textContent === title).pop(); document.getElementById("props").scrollTop = h.offsetTop - 70; };
`;

const PAGE_H = 360, DEV_H = 440;
const SHOTS = [
  { file: "1-scene-graph.png", run: `$sel("Torus Knot");` },
  { file: "2-materials.png", run: `$sel("Torus Knot");`, then: `$set("color", "#3d7cff"); $set("roughness", 0.55); $set("clearcoat", 0.3); $scrollTo("Material");` },
  { file: "3-morph-targets.png", run: `$sel("Morph Blob");`, then: `$set("Spikes", 1); $set("Twist", 0.8); $scrollTo("Morph targets");` },
  { file: "4-lights.png", run: `$sel("Rim Light");`, then: `$set("color", "#ff3fb4"); $set("intensity", 90); $set("distance", 16); $scrollTo("Light");` },
  { file: "5-scene-renderer.png", run: `$sel("Showroom");`, then: `$set("background", "#2b2140"); $set("fog color", "#2b2140"); $set("toneMappingExposure", 1.3); $set("toneMapping", 6); $scrollTo("Scene");` },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch({ width: 1280, height: 800 });
  for (const shot of SHOTS) {
    const { page, dt, panel, close } = await browser.open(URL_, {
      dock: "undocked",
      ready: async (p) => {
        await p.setViewportSize({ width: 1280, height: PAGE_H });
        await p.waitForFunction(() => document.title === "loaded", null, { timeout: 30000 });
      },
    });
    const dtTarget = (await browser.cdp.send("Target.getTargets")).targetInfos.find((t) => t.url.startsWith("devtools://") && t.title.includes("127.0.0.1"));
    const { windowId } = await browser.cdp.send("Browser.getWindowForTarget", { targetId: dtTarget.targetId });
    await browser.cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal", width: 1280, height: DEV_H + 56 } });
    await sleep(800);
    await waitFor(async () => (await panel.text("#tree")).length > 0, 20000, "tree");
    await panel.eval(HELPERS);
    await panel.eval("$expand();" + shot.run);
    await waitFor(() => panel.eval(`!!document.querySelector("#props h3")`), 10000, "props");
    await sleep(1500);
    if (shot.then) {
      await panel.eval(shot.then);
      await sleep(1800);
    }
    await page.mouse.move(5, 5);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shot-"));
    await page.screenshot({ path: path.join(tmp, "page.png") });
    await dt.shot(path.join(tmp, "devtools.png"));
    execFileSync("python3", [path.join(__dirname, "compose.py"), tmp, path.join(OUT, shot.file)], { stdio: "inherit" });
    await close();
  }
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
