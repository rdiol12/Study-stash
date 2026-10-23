import { api, getSettings, setSettings } from "./common.js";
import { nativeDrives, nativePing } from "./native.js";

const $ = (id) => document.getElementById(id);

function setBanner(message, kind) {
  const el = $("banner");
  if (!message) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.className = kind === "info" ? "banner info" : "banner";
}

async function test() {
  const pill = $("health");
  pill.textContent = "checking…";
  pill.className = "pill pill-wait";
  try {
    const h = await api("/api/health");
    const missing = Object.entries(h.tools || {}).filter(([, ok]) => !ok).map(([n]) => n);
    pill.textContent = missing.length ? "tools missing" : "api ok";
    pill.className = missing.length ? "pill pill-bad" : "pill pill-ok";
    setBanner(
      missing.length
        ? `Reachable, but these binaries are missing in the container: ${missing.join(", ")}`
        : `Connected. Output dir ${h.out_dir}, ${h.max_jobs} job slot(s), auth ${h.auth_required ? "required" : "disabled"}.`,
      "info"
    );
  } catch (err) {
    pill.textContent = "offline";
    pill.className = "pill pill-bad";
    setBanner(err.message);
  }
}

async function testHelper() {
  const el = $("helperState");
  el.textContent = "checking…";
  try {
    const pong = await nativePing();
    const drives = await nativeDrives();
    const list = drives.drives
      .map((d) => `${d.path}${d.free ? ` (${Math.round(d.free / 1073741824)} GB free)` : ""}`)
      .join("  ");
    el.textContent = `ready — v${pong.version}, python ${pong.python}`;
    setBanner(`Helper reachable. Drives: ${list}`, "info");
  } catch (err) {
    el.textContent = "not reachable";
    setBanner(
      `${err.message}  —  run native\install.ps1 and restart Brave.`
    );
  }
}

(async function init() {
  const { apiBase, apiToken } = await getSettings();
  $("apiBase").value = apiBase;
  $("apiToken").value = apiToken;

  $("btnSave").addEventListener("click", async () => {
    await setSettings({
      apiBase: $("apiBase").value.trim() || "http://127.0.0.1:8787",
      apiToken: $("apiToken").value.trim(),
    });
    setBanner("Saved.", "info");
    await test();
  });
  $("btnTest").addEventListener("click", test);
  $("btnHelper").addEventListener("click", testHelper);

  await test();
})();
