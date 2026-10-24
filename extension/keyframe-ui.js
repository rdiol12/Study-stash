// Controller for keyframe.html. Talks only to the background worker over the
// vv:* message router, which owns the native-bridge connection. Keeps nothing
// of its own — the bridge is the source of truth; this just renders and polls.

const $ = (id) => document.getElementById(id);

/** Send a vv op to the background worker; resolve its data or throw its error. */
function vv(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (!res) return reject(new Error("no response from the extension worker"));
      res.ok ? resolve(res.data) : reject(new Error(res.error || "bridge error"));
    });
  });
}

function banner(msg, kind = "error") {
  const b = $("banner");
  b.textContent = msg;
  b.className = kind === "error" ? "banner" : "banner info";
  b.hidden = !msg;
}

function pill(el, text, cls) {
  el.textContent = text;
  el.className = `pill ${cls}`;
}

// ------------------------------------------------------------- status

async function refreshStatus() {
  try {
    const eng = await vv("vv:engine-status");
    pill($("pBridge"), "standalone", "pill-ok");
    pill($("pEngine"), eng.ready ? "engine ready" : "engine missing",
         eng.ready ? "pill-ok" : "pill-wait");
    $("btnSetup").textContent = "Engine ready (built in)";
  } catch (err) {
    pill($("pBridge"), "worker down", "pill-bad");
    pill($("pEngine"), "engine ?", "pill-wait");
    $("setupHint").textContent = "Extension worker not reachable — try reloading the extension.";
  }
  try {
    const cdm = await vv("vv:cdm-status");
    pill($("pCdm"), cdm.available ? `CDM ×${cdm.count}` : "no CDM",
         cdm.available ? "pill-ok" : "pill-wait");
  } catch {
    pill($("pCdm"), "CDM ?", "pill-wait");
  }
}

// ------------------------------------------------------------- jobs

const STATUS_ORDER = { running: 0, resolving: 1, queued: 2, paused: 3, failed: 4, done: 5, cancelled: 6 };

async function refreshJobs() {
  if (!$("jobs")) return; // job list moved to the main popup; this page is settings only
  let jobs;
  try {
    jobs = await vv("vv:jobs");
  } catch {
    $("jobs").innerHTML = '<p class="muted">Bridge not reachable.</p>';
    return;
  }
  jobs.sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || (b.created - a.created));
  if (!jobs.length) {
    $("jobs").innerHTML = '<p class="muted">No jobs yet.</p>';
    return;
  }
  $("jobs").innerHTML = "";
  for (const j of jobs) {
    const title = (j.meta && j.meta.title) || j.output || j.url || j.id;
    const mb = j.bytes_total ? ` · ${(j.bytes_done / 1048576).toFixed(0)}/${(j.bytes_total / 1048576).toFixed(0)} MB` : "";
    const sp = j.speed ? ` · ${j.speed}` : "";
    const eta = j.eta ? ` · ETA ${j.eta}` : "";
    const el = document.createElement("div");
    el.className = "job";
    el.innerHTML = `
      <div class="top">
        <strong>${escapeHtml(title)}</strong>
        <span class="st-${j.status}">${j.status}${j.phase ? " · " + escapeHtml(j.phase) : ""}</span>
      </div>
      <div class="bar"><span style="width:${Math.max(0, Math.min(100, j.percent || 0))}%"></span></div>
      <div class="meta">${j.percent || 0}%${mb}${sp}${eta}${j.error ? " · " + escapeHtml(j.error) : ""}</div>
      <div class="actions"></div>`;
    const acts = el.querySelector(".actions");
    if (["queued", "resolving", "running"].includes(j.status)) acts.append(btn("Cancel", "link-danger", () => act("vv:cancel", j.id)));
    if (["failed", "cancelled"].includes(j.status)) acts.append(btn("Retry", "secondary", () => act("vv:retry", j.id)));
    $("jobs").append(el);
  }
}

function btn(label, cls, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.className = cls;
  b.addEventListener("click", onClick);
  return b;
}

async function act(type, id) {
  try { await vv(type, { id }); await refreshJobs(); }
  catch (err) { banner(err.message); }
}

// ------------------------------------------------------------- watchlist

async function refreshWatches() {
  if (!$("watches")) return; // watchlist UI removed; settings-only page
  let watches;
  try { watches = await vv("vv:watch-list"); }
  catch { $("watches").innerHTML = ""; return; }
  if (!watches.length) { $("watches").innerHTML = '<p class="muted">Nothing watched.</p>'; return; }
  $("watches").innerHTML = "";
  for (const w of watches) {
    const el = document.createElement("div");
    el.className = "job";
    el.innerHTML = `<div class="top"><strong>${escapeHtml(w.title || w.id)}</strong>
      <span class="muted">${w.enabled ? "on" : "off"}</span></div>`;
    el.querySelector(".top").append(btn("Remove", "link-danger", async () => {
      await vv("vv:watch-remove", { id: w.id }); refreshWatches();
    }));
    $("watches").append(el);
  }
}

// ------------------------------------------------------------- form

function jobFromForm() {
  const job = {};
  const url = $("url").value.trim();
  if (url) job.url = url;
  const title = $("title").value.trim();
  if (title) job.title = title;
  if ($("drm").checked) {
    job.drm = "widevine";
    const lic = $("licenseUrl").value.trim();
    if (lic) job.license_url = lic;
  }
  for (const k of ["service", "search", "season", "episode"]) {
    const v = $(k).value.trim();
    if (v) job[k] = v;
  }
  const authHost = $("authHost").value.trim();
  return { job, authHost, resolveFirst: $("drm").checked };
}

async function doDownload() {
  const { job, authHost, resolveFirst } = jobFromForm();
  if (!job.url && !(job.service && job.search)) {
    return banner("Give a URL, or a provider service + search.");
  }
  banner("");
  try {
    await vv("vv:submit", { job, authHost: authHost || undefined, resolveFirst });
    await refreshJobs();
  } catch (err) {
    banner(err.message);
  }
}

async function doWatch() {
  const { job } = jobFromForm();
  if (!job.service && !job.url) return banner("Watchlist needs a provider service + search (or a URL).");
  try { await vv("vv:watch-add", { spec: job }); await refreshWatches(); banner("Added to watchlist.", "ok"); }
  catch (err) { banner(err.message); }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ------------------------------------------------------------- wire-up

$("drm").addEventListener("change", () => { $("drmOpts").hidden = !$("drm").checked; });
$("btnDownload").addEventListener("click", doDownload);
$("btnWatch").addEventListener("click", doWatch);
$("btnSetup").addEventListener("click", async () => {
  $("setupHint").textContent = "Installing… first run clones Keyframe and its dependencies (can take minutes).";
  try { await vv("vv:engine-install"); $("setupHint").textContent = "Engine ready."; refreshStatus(); }
  catch (err) { $("setupHint").textContent = ""; banner(err.message); }
});
$("btnUpdate").addEventListener("click", async () => {
  try { const r = await vv("vv:engine-update"); banner(r.ok ? "Engine updated." : "Update: " + (r.tail || "see log"), r.ok ? "ok" : "error"); }
  catch (err) { banner(err.message); }
});
$("btnCdm").addEventListener("click", async () => {
  try { const r = await vv("vv:cdm-validate"); banner(r.ok ? `CDM OK (${r.count})` : r.hint, r.ok ? "ok" : "error"); refreshStatus(); }
  catch (err) { banner(err.message); }
});
$("wvdFile").addEventListener("change", async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = ""; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    await vv("vv:set-wvd", { b64: btoa(bin), name: file.name });
    banner(`Loaded CDM: ${file.name}`, "ok"); refreshStatus();
  } catch (err) { banner(err.message); }
  e.target.value = "";
});
const pw = $("pollWatch"); if (pw) pw.addEventListener("click", async (e) => { e.preventDefault(); try { const r = await vv("vv:watch-poll"); banner(`Queued ${r.queued} watch(es).`, "ok"); refreshJobs(); } catch (err) { banner(err.message); } });
const cj = $("clearJobs"); if (cj) cj.addEventListener("click", async (e) => { e.preventDefault(); try { await vv("vv:clear"); refreshJobs(); } catch (err) { banner(err.message); } });

refreshStatus();
refreshJobs();
refreshWatches();
setInterval(refreshJobs, 1500);
setInterval(refreshStatus, 10000);
