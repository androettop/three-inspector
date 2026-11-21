// Talks to the page agent through chrome.devtools.inspectedWindow.eval.
// Results come back as JSON, so the agent only returns plain data.
const AGENT = 'window[Symbol.for("threeInspector.agent")]';
let agentSource = null;

function evaluate(expression, frameURL) {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(expression, frameURL ? { frameURL } : {}, (result, exception) => {
      if (exception) reject(new Error(exception.value || exception.description || "Evaluation failed"));
      else resolve(result);
    });
  });
}

// Calls agent[method](...args) in a frame (undefined = top frame).
export function call(frameURL, method, ...args) {
  const list = args.map((a) => JSON.stringify(a === undefined ? null : a)).join(",");
  return evaluate(`(${AGENT} ? ${AGENT}.${method}(${list}) : undefined)`, frameURL);
}

export async function inject(frameURL) {
  agentSource ??= await (await fetch(chrome.runtime.getURL("src/agent.js"))).text();
  return evaluate(agentSource, frameURL);
}

// Top frame plus every other document DevTools knows about.
export function frames() {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.getResources((resources) => {
      const urls = resources.filter((r) => r.type === "document").map((r) => r.url);
      resolve([...new Set(urls)].filter((u) => /^(https?|file):/.test(u)));
    });
  });
}

export function topURL() {
  return evaluate("location.href");
}

export function onNavigated(fn) {
  chrome.devtools.network.onNavigated.addListener(fn);
}

export const theme = chrome.devtools.panels.themeName === "dark" ? "dark" : "light";
