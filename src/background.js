// Nothing is injected on page load. Clicking the toolbar icon injects the
// hook into every frame of the active tab (page context) and opens the panel.
async function grab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      injectImmediately: true,
      files: ["src/hook.js"],
    });
  } catch (err) {
    // Frames we have no access to are skipped; the top frame is what matters.
    console.warn("hook injection:", err);
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ["src/panel.js"] });
}

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) grab(tab.id).catch((err) => console.warn("Three Inspector:", err));
});

// The panel can't call permissions.request (content script), so cross-origin
// iframes get access through a small extension window with a real button.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "grant" && sender.tab?.id && Array.isArray(msg.origins) && msg.origins.length) {
    const q = new URLSearchParams({ tab: sender.tab.id, origins: msg.origins.join(" ") });
    chrome.windows.create({ url: `src/grant.html?${q}`, type: "popup", width: 460, height: 300 });
  }
  if (msg?.type === "regrab" && Number.isInteger(msg.tabId)) grab(msg.tabId).catch(() => {});
});

self.grab = grab;
