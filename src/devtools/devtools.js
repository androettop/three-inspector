// Adds the "Three" panel to DevTools and tells it when it's shown or hidden.
chrome.devtools.panels.create("Three", "/icons/32.png", "/src/devtools/panel.html", (panel) => {
  let view = null;
  panel.onShown.addListener((win) => {
    view = win;
    win.panelShown = true; // in case panel.js hasn't loaded yet
    win.dispatchEvent(new Event("panel-shown"));
  });
  panel.onHidden.addListener(() => view && view.dispatchEvent(new Event("panel-hidden")));
});
