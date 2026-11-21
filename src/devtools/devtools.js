// Adds the "Three" panel to DevTools (Chrome and Firefox). The panel page is
// only loaded the first time the user opens it; these events just pause and
// resume its polling.
// Chrome also defines `browser` nowadays: tell them apart by a Chrome-only API.
const firefox = typeof browser !== "undefined" && typeof browser.devtools?.inspectedWindow?.getResources !== "function";

function setup(panel) {
  let view = null;
  panel.onShown.addListener((win) => {
    if (win) view = win;
    view && view.dispatchEvent(new Event("panel-shown"));
  });
  panel.onHidden.addListener(() => view && view.dispatchEvent(new Event("panel-hidden")));
}

if (firefox) browser.devtools.panels.create("Three", "/icons/32.png", "/src/devtools/panel.html").then(setup);
else chrome.devtools.panels.create("Three", "/icons/32.png", "/src/devtools/panel.html", setup);
