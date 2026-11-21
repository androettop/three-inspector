// Talks to the page agent through devtools.inspectedWindow.eval, in Chrome
// (callbacks, frameURL) and Firefox (promises, no frameURL). Results come back
// as JSON, so the agent only returns plain data.
//
// Frames are identified by a key: "" for the top frame, the frame URL in
// Chrome, and "path:0.1" (indexes into window.frames) in Firefox, which can
// only reach same-origin frames through the top frame.
// Chrome also defines `browser` nowadays: tell them apart by a Chrome-only API.
const firefox = typeof browser !== "undefined" && typeof browser.devtools?.inspectedWindow?.getResources !== "function";
const api = firefox ? browser : chrome;
const AGENT = 'window[Symbol.for("threeInspector.agent")]';
let agentSource = null;

// An eval sent while the page navigates may never be answered (seen in
// Firefox): give up after a while so the panel can retry.
const TIMEOUT_MS = 8000;

// Firefox can also lose its link to the page after some navigations: every
// eval then fails, even `location.href`. broken() reports that, so the panel
// can reload itself and get a fresh link.
let failingSince = 0;

function evaluate(expression, key) {
  let timer;
  const timeout = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("The page did not answer")), TIMEOUT_MS)));
  return Promise.race([send(expression, key), timeout])
    .then(
      (value) => {
        failingSince = 0;
        return value;
      },
      (err) => {
        if (!key) failingSince ||= Date.now();
        throw err;
      }
    )
    .finally(() => clearTimeout(timer));
}

export function broken() {
  return failingSince > 0 && Date.now() - failingSince > 4000;
}

function send(expression, key) {
  if (firefox) {
    if (key) expression = inFrame(key, expression);
    return api.devtools.inspectedWindow.eval(expression).then(([result, exception]) => {
      if (exception) throw new Error(exception.value || exception.description || "Evaluation failed");
      return result;
    });
  }
  return new Promise((resolve, reject) => {
    api.devtools.inspectedWindow.eval(expression, key ? { frameURL: key } : {}, (result, exception) => {
      if (exception) reject(new Error(exception.value || exception.description || "Evaluation failed"));
      else resolve(result);
    });
  });
}

// Runs `expression` in a same-origin child frame, reached from the top frame.
function inFrame(key, expression) {
  const path = JSON.stringify(key.replace(/^path:/, "").split(".").map(Number));
  return `(() => { let w = window; for (const i of ${path}) w = w.frames[i]; return w.eval(${JSON.stringify(expression)}); })()`;
}

// Calls agent[method](...args) in a frame ("" = top frame).
export function call(key, method, ...args) {
  const list = args.map((a) => JSON.stringify(a === undefined ? null : a)).join(",");
  return evaluate(`(${AGENT} ? ${AGENT}.${method}(${list}) : undefined)`, key);
}

export async function inject(key) {
  agentSource ??= await (await fetch(api.runtime.getURL("src/agent.js"))).text();
  return evaluate(agentSource, key);
}

// [{ key, url }] for the top frame and every frame we can reach. In Firefox,
// list.blocked counts cross-origin frames that can't be reached.
export async function frames() {
  const top = await evaluate("location.href");
  const list = [{ key: "", url: top }];
  if (firefox) {
    const found = await evaluate(`(() => {
      const out = [];
      let blocked = 0;
      const walk = (w, path) => {
        for (let i = 0; i < w.frames.length; i++) {
          const f = w.frames[i];
          try {
            out.push({ key: "path:" + path.concat(i).join("."), url: f.location.href });
            walk(f, path.concat(i));
          } catch (_) {
            blocked++; // cross-origin
          }
        }
      };
      walk(window, []);
      return { out, blocked };
    })()`);
    const all = list.concat(found.out.filter((f) => /^(https?|file):/.test(f.url)));
    all.blocked = found.blocked;
    return all;
  }
  const urls = await new Promise((resolve) => api.devtools.inspectedWindow.getResources((r) => resolve(r)));
  for (const url of new Set(urls.filter((r) => r.type === "document").map((r) => r.url)))
    if (url !== top && /^(https?|file):/.test(url)) list.push({ key: url, url });
  return list;
}

export function onNavigated(fn) {
  api.devtools.network.onNavigated.addListener(fn);
}

export const theme = api.devtools.panels.themeName === "dark" ? "dark" : "light";
export const isFirefox = firefox;
