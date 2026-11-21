const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tab"));
const origins = (params.get("origins") || "").split(" ").filter((o) => /^https?:\/\/[^/]+\/\*$/.test(o));
document.getElementById("list").innerHTML = origins.map((o) => `<code>${o.replace(/[<>&]/g, "")}</code>`).join("");
document.getElementById("ok").addEventListener("click", async () => {
  const granted = await chrome.permissions.request({ origins });
  if (!granted) {
    document.getElementById("msg").textContent = "Permission was not granted.";
    return;
  }
  await chrome.runtime.sendMessage({ type: "regrab", tabId });
  window.close();
});
