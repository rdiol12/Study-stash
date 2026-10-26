import { api, getSettings, getPrefs, queueAuto, setCourseRoot, parseCourseUrl, getBearer, exportCookiesTxt } from "./common.js";
import { findCourse, fetchCurriculum, buildPlan, freshLicenseToken } from "./udemy-api.js";
import { installNameGuard } from "./name-guard.js";
import { nativeExists, nativeUpdateCheck, nativeUpdateApply } from "./native.js";
import { setConcurrency } from "./gate.js";

// exactly one listener is allowed across ALL extension contexts, and download
// drivers now run only here -- so the guard lives only here
installNameGuard();
import {
  applyProgress, hdJobStatus, listHdJobs, resumeHdJobs, watchdogHdJobs,
} from "./hd-runner.js";
import {
  listLocalJobs, localJobStatus, pumpLocalJob, relocateFinishedJob,
} from "./local-runner.js";
import * as vv from "./keyframe.js";
import { initSniffer, streamForTab, hasStream } from "./sniffer.js";

// user-opted one-press autonomy: capture manifest/license per tab (scoped; see
// sniffer.js) so pressing Download needs no URL entry
initSniffer();

/** Relocate + register a finished LOCAL job. Idempotent via job.relocated. */
async function finalizeLocalJob(job) {
  if (!job || job.status !== "done" || job.relocated || !job.counts.complete) return;
  const { nativeTarget } = await getSettings();
  if (nativeTarget) {
    try {
      const res = await relocateFinishedJob(job.id, nativeTarget);
      if (res) {
        await setCourseRoot(job.courseTitle, res.to);
        chrome.notifications.create({
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon128.png"),
          title: "Course moved",
          message: `${res.moved} file(s) -> ${res.to}`,
        });
      }
    } catch (err) {
      console.warn("relocate failed:", err.message);
    }
  } else {
    await deriveCourseRoot(job).catch(() => {});
  }
}

/** Derive the course folder from any completed entry's absolute filename by
 *  stripping the known relative path off the end. */
async function deriveCourseRoot(job) {
  const full = await localJobStatus(job.id);
  if (!full) return;
  for (const entry of full.entries) {
    if (!entry.downloadId) continue;
    const [live] = await chrome.downloads.search({ id: entry.downloadId });
    if (!live || live.state !== "complete" || !live.filename) continue;
    const rel = entry.path.replace(/\//g, "\\");
    if (!live.filename.toLowerCase().endsWith(rel.toLowerCase())) continue;
    const downloadRoot = live.filename.slice(0, live.filename.length - rel.length);
    const sub = (job.destSub ? job.destSub.replace(/\//g, "\\") + "\\" : "");
    await setCourseRoot(job.courseTitle, downloadRoot + sub + job.courseTitle);
    return;
  }
}

/**
 * One compact line describing the newest job, for the in-page bar. Running
 * jobs win over finished ones so the bar tracks what's happening now.
 */
async function progressSummary() {
  // turn "silently never started" into a reported error before reading state
  await watchdogHdJobs().catch(() => {});
  const candidates = [];

  for (const stub of await listHdJobs()) {
    const job = await hdJobStatus(stub.id);
    if (!job) continue;

    const cur = job.current;
    candidates.push({
      created: job.created,
      status: job.status,
      finished: job.finished || 0,
      done: job.counts.complete,
      failed: job.counts.error,
      total: job.total,
      detail: cur && cur.segTotal
        ? `${cur.height || "?"}p seg ${cur.segDone}/${cur.segTotal}`
        : "",
      label: "1080p",
      etaSeconds: job.etaSeconds,
      stalledFor: job.stalledFor,
    });
  }

  for (const stub of await listLocalJobs()) {
    const job = await localJobStatus(stub.id);
    if (!job) continue;
    // feed the next queued files into the freed download slots
    if (job.status === "running") await pumpLocalJob(job.id).catch(() => {});
    await finalizeLocalJob(job);
    candidates.push({
      created: job.created,
      status: job.status,
      finished: job.finished || 0,
      done: job.counts.complete,
      failed: job.counts.interrupted + job.counts.error,
      total: job.entries.length,
      detail: job.total ? `${Math.round(job.bytes / 1048576)} MB` : "",
      label: "files",
    });
  }

  const running = candidates.filter((c) => c.status === "running");
  // a stalled/cancelled/old job must NOT keep showing stale counts forever;
  // when nothing runs, only a just-finished job lingers briefly as confirmation
  const RECENT = 60000;
  const pool = running.length
    ? running
    : candidates.filter((c) => c.status === "done" && Date.now() - (c.finished || 0) < RECENT);
  if (!pool.length) return null;
  pool.sort((a, b) => (b.created || 0) - (a.created || 0));
  const best = pool[0];
  best.percent = best.total ? Math.round((100 * best.done) / best.total) : 0;
  return best;
}

const POLL_ALARM = "ud-poll";

// One flat feed of every download — DRM (per lecture), 1080p HD (per lecture),
// and plain browser downloads (per file) — so the injector and popup can show a
// single unified stack instead of DRM living in a separate panel.
const base = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || "";
function rank(s) { return { running: 0, queued: 1, failed: 2, done: 3, skipped: 4, cancelled: 5 }[s] ?? 6; }
// Derive a course name for a DRM job even if it predates the `course` field, so
// old jobs don't land in a phantom "Downloads" group.
function drmCourse(j) {
  if (j.course) return j.course;
  const parts = String(j.moveRel || j.filename || "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length >= 2) return parts[0].toLowerCase() === "courses" ? parts[1] : parts[0];
  return "Downloads";
}
async function jobStack() {
  const items = [];
  try {
    for (const j of await vv.Keyframe.jobs()) {
      items.push({
        kind: "DRM", mode: "drm", jobId: j.id, title: j.title || base(j.filename) || j.id,
        course: drmCourse(j),
        status: j.status === "cancelled" ? "cancelled" : j.status,
        percent: j.percent != null ? j.percent : (j.status === "done" ? 100 : 0),
        error: j.error || null, created: j.createdAt || 0,
      });
    }
  } catch { /* engine idle */ }
  try {
    for (const stub of await listHdJobs()) {
      const job = await hdJobStatus(stub.id);
      if (!job) continue;
      const map = { complete: "done", error: "failed", cancelled: "cancelled", active: "running", pending: "queued" };
      job.entries.forEach((e, index) => {
        items.push({
          kind: "1080p", mode: "hd", jobId: stub.id, index, title: base(e.path), status: map[e.state] || "queued",
          course: job.courseTitle || "Downloads",
          percent: e.state === "complete" ? 100 : e.state === "active" ? 50 : 0,
          error: e.state === "error" ? e.reason : null, created: job.created || 0,
        });
      });
    }
  } catch { /* none */ }
  try {
    for (const stub of await listLocalJobs()) {
      const job = await localJobStatus(stub.id);
      if (!job) continue;
      const map = { complete: "done", in_progress: "running", interrupted: "failed", error: "failed", skipped: "skipped", queued: "queued" };
      for (const f of job.files) {
        items.push({
          kind: "file", mode: "local", jobId: stub.id, path: f.path, title: base(f.path), status: map[f.state] || "queued",
          course: job.courseTitle || "Downloads",
          percent: f.total ? Math.round((100 * (f.received || 0)) / f.total) : f.state === "complete" ? 100 : 0,
          error: f.state === "error" ? f.reason : null, created: job.created || 0,
        });
      }
    }
  } catch { /* none */ }
  items.sort((a, b) => rank(a.status) - rank(b.status) || (b.created || 0) - (a.created || 0));
  return items;
}

function schedule() {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
}

// Update check: on browser start and every 6h the helper fetches the repo and
// reports how far behind origin/master this install is. The popup reads the
// stored result and offers a one-click update; nothing installs on its own.
const UPDATE_ALARM = "update-check";
const UPDATE_KEY = "updateInfo";

async function checkForUpdate() {
  let info;
  try { info = { ...(await nativeUpdateCheck()), checked: Date.now() }; }
  catch (err) { info = { error: err.message || String(err), checked: Date.now() }; }
  await chrome.storage.local.set({ [UPDATE_KEY]: info });
  return info;
}

async function applyUpdate() {
  const res = await nativeUpdateApply();
  await chrome.storage.local.set({ [UPDATE_KEY]: { ...res, checked: Date.now() } });
  // new extension files are on disk; reload to run them (HD jobs resume on wake)
  if (res.updated) setTimeout(() => chrome.runtime.reload(), 300);
  return res;
}

function wake() {
  schedule();
  chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: 360 });
  // the offscreen worker dies with the extension; revive any unfinished job
  resumeHdJobs().catch(() => {});
}

chrome.runtime.onInstalled.addListener(wake);
chrome.runtime.onStartup.addListener(wake);

// A download finishing is the reliable completion signal for plain jobs: pump
// the next queued file, and finalize (move + register) when the job is done --
// independent of whether any popup or tab is polling.
chrome.downloads.onChanged.addListener(async (delta) => {
  const term = delta.state && (delta.state.current === "complete" || delta.state.current === "interrupted");
  if (!term) return;
  try {
    for (const stub of await listLocalJobs()) {
      const raw = (await listLocalJobs()).find((j) => j.id === stub.id);
      if (!raw || !raw.entries.some((e) => e.downloadId === delta.id)) continue;
      await pumpLocalJob(stub.id).catch(() => {});
      const job = await localJobStatus(stub.id);
      if (job) await finalizeLocalJob(job);
      break;
    }
  } catch (err) {
    console.warn("onChanged finalize failed:", err.message);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) refreshBadge();
  if (alarm.name === UPDATE_ALARM) checkForUpdate().catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && (msg.type === "update-check" || msg.type === "update-apply")) {
    (msg.type === "update-check" ? checkForUpdate() : applyUpdate())
      .then((info) => reply({ ok: true, info }))
      .catch((err) => reply({ ok: false, error: err.message || String(err) }));
    return true;
  }
  if (msg && msg.type === "refresh-badge") {
    refreshBadge().then(() => reply({ ok: true }));
    return true;
  }
  // pushed by the offscreen worker, which has no chrome.storage of its own
  if (msg && msg.type === "hls-progress") {
    applyProgress(msg).catch(() => {});
    return false;
  }
  if (msg && msg.type === "job-stack") {
    jobStack().then((items) => reply({ items })).catch(() => reply({ items: [] }));
    return true;
  }
  if (msg && msg.type === "job-progress") {
    progressSummary()
      .then((summary) => {
        // a long stall usually means the worker is gone, not that a segment is
        // slow; recreating it makes the job pick up where it left off
        if (summary && summary.status === "running" && summary.stalledFor > 90) {
          resumeHdJobs().catch(() => {});
        }
        reply({ summary });
      })
      .catch(() => reply({ summary: null }));
    return true;
  }
  // Keyframe bridge ops, called by the popup/options pages. One async router;
  // every reply is { ok, data } or { ok:false, error }.
  if (msg && typeof msg.type === "string" && msg.type.startsWith("vv:")) {
    handleVv(msg, _sender).then((data) => reply({ ok: true, data }))
      .catch((err) => reply({ ok: false, error: err.message || String(err) }));
    return true;
  }
  if (msg && msg.type === "queue-course") {
    // ONE button: the non-DRM lectures go through queueAuto, and the DRM ones
    // through the standalone in-extension CDM (grabUdemyCourse). Best-effort on
    // the DRM side so a missing CDM never blocks the normal download.
    (async () => {
      const job = await queueAuto({ courseUrl: msg.url, infoOnly: !!msg.infoOnly });
      let drm = null;
      if (!msg.infoOnly) {
        let tabId = msg.tabId;
        if (tabId == null) { try { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = t && t.id; } catch {} }
        try { drm = await grabUdemyCourse(msg.url, tabId); } catch (err) { drm = { error: err.message }; }
      }
      refreshBadge();
      return { job, drm };
    })().then(reply).catch((err) => reply({ error: err.message || String(err) }));
    return true;
  }
  return false;
});

async function refreshBadge() {
  let active = 0;
  let failed = false;
  // legacy Udemy container path, if that mode is on and reachable
  try {
    const { jobs = [] } = await api("/api/jobs");
    active += jobs.filter((j) => j.status === "running" || j.status === "queued").length;
    failed = failed || jobs.some((j) => j.status === "failed");
  } catch {
    /* container off/unreachable */
  }
  // Keyframe bridge: reconcile missed completions + count active work. Never
  // throws (bridge may be down); reconnect only happens on explicit user action.
  try {
    const snap = await vv.reconcile();
    if (snap.reachable) {
      active += snap.active;
      failed = failed || snap.failed;
    }
  } catch {
    /* bridge down */
  }
  try {
    await chrome.action.setBadgeText({ text: active ? String(active) : failed ? "!" : "" });
    await chrome.action.setBadgeBackgroundColor({ color: active ? "#2563eb" : "#b91c1c" });
  } catch {
    /* no action badge here */
  }
}

/** Harvest the current provider session (cookies + bearer) from the browser and
 *  hand it to the bridge as headers on the job, so engine runs authenticate with
 *  no prompt. The secret only ever crosses extension -> native host. */
async function vvProviderHeaders(host) {
  if (!host) return [];
  const cookies = await chrome.cookies.getAll({ domain: host.replace(/^www\./, "") });
  const headers = [];
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  if (cookieHeader) headers.push(`Cookie: ${cookieHeader}`);
  const tok = cookies.find((c) => /access_token|authorization|bearer|token/i.test(c.name) && c.value.length > 20);
  if (tok) headers.push(`Authorization: Bearer ${tok.value}`);
  return headers;
}

// Host -> DRM service hint for non-Udemy providers (domains change over time).
// The injected button only appears on hosts listed here (see content.js /
// manifest content_scripts), so autonomy stays scoped to known providers and
// no network traffic is ever inspected.
const PROVIDERS = [
  { match: /(^|\.)streamingcommunity\./i, service: "streamingcommunity" },
  { match: /(^|\.)animeunity\./i, service: "animeunity" },
];

function serviceForHost(host) {
  const h = String(host || "").toLowerCase();
  const hit = PROVIDERS.find((p) => p.match.test(h));
  return hit ? hit.service : "";
}

/** A sensible search term from a provider page: its title, cleaned of the site
 *  suffix, else the last URL path segment. */
function searchTermFrom(title, url) {
  const t = String(title || "").split(/[|\-–—·•]/)[0].trim();
  if (t && t.length > 1) return t;
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] || "").replace(/[-_]+/g, " ").trim();
  } catch {
    return "";
  }
}

/** Autonomous one-press: use the manifest + license the sniffer captured for
 *  this tab and hand them straight to our engine (keys/CDM/decrypt happen in the
 *  bridge). A tidy title comes from the page. */
async function grabTab(msg, sender) {
  const tabId = msg.tabId != null ? msg.tabId : (sender && sender.tab && sender.tab.id);
  const title = msg.title || (sender && sender.tab && sender.tab.title) || "";
  if (tabId == null) throw new Error("no tab to grab");
  const stream = await streamForTab(tabId);
  if (!stream || !stream.url) {
    throw new Error("No stream detected yet — start playback for a moment, then press Download.");
  }
  const cleanTitle = (title || "").split(/[|\-–—·•]/)[0].trim() || undefined;
  const job = {
    url: stream.url,
    stream_type: stream.type,
    title: cleanTitle,
    headers: stream.headers,
    drm: stream.drm,
    license_url: stream.license_url,
    license_headers: stream.license_headers,
  };
  // the bridge resolves keys itself when drm is set; one call does it all
  return vv.Keyframe.download(job);
}

/** Autonomous Udemy DRM: the API already says which lectures are encrypted and
 *  gives their DASH manifest URLs, so we queue exactly those to the bridge with
 *  the signed-in bearer — no playback, no sniffer. The engine reads the license
 *  URL out of each manifest and decrypts with the user's CDM. */
// Udemy CMAF manifests carry a per-asset UUID (…/cmaf/<id>/<uuid>/…/stream.mpd);
// use it to tell whether a sniffed license belongs to a given lecture's manifest.
function manifestAsset(url) {
  const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(url || "");
  return m ? m[0].toLowerCase() : null;
}

async function grabUdemyCourse(courseUrl, tabId) {
  const parsed = parseCourseUrl(courseUrl);
  if (!parsed) throw new Error("not a Udemy course URL");
  const course = await findCourse(parsed.portal, parsed.slug);
  const items = await fetchCurriculum(parsed.portal, course.id);
  const planPrefs = (await getPrefs()).prefs;
  const plan = buildPlan(items, course.title, {
    idAsName: !!planPrefs.id_as_course_name,
    courseId: course.id,
    continueNumbers: planPrefs.continue_lecture_numbers !== false,
    quality: planPrefs.quality,
  });

  const bearer = await getBearer(parsed.host);
  const cookies = await chrome.cookies.getAll({ domain: "udemy.com" });
  if (!bearer && !cookies.length) throw new Error("not signed in to Udemy in this browser");

  // Start each course fresh: drop finished/failed DRM jobs from earlier runs so
  // the injector stack shows this batch, not stale 401s from a previous attempt.
  try { await vv.Keyframe.clear(); } catch { /* engine idle */ }

  // Real endpoint (confirmed by sniffing the player): validate-auth-token, NOT
  // the /api-2.0/.../validate-auth/widevine/ path. It authenticates with the
  // per-asset JWT in auth_token + the session cookies (credentials:'include'
  // sends those from the service worker); no Authorization header is used.
  const licenseUrlFor = (token) => token
    ? `https://www.udemy.com/media-license-server/validate-auth-token?drm_type=widevine&auth_token=${encodeURIComponent(token)}`
    : undefined;

  // If the sniffer caught the player's real license request on this tab, use its
  // exact URL for the lecture that was played (that token is live right now).
  let sniffed = null;
  try { sniffed = tabId != null ? await streamForTab(tabId) : null; } catch {}

  // Download into the SAME subfolder non-DRM uses (queueAuto's `dest`, default
  // "Courses"), so DRM and non-DRM land together. moveRel is the course-relative
  // path the native helper relocates under the absolute target (destSub stripped).
  const { parallel } = await getSettings();
  const { prefs, dest } = await getPrefs();
  const destSub = (dest || "Courses").replace(/[\/\\]+$/, "");

  const jobs = [];
  for (const ch of plan.chapters) {
    for (const lec of ch.lectures) {
      if (lec.kind !== "video" || !lec.drm || !lec.dashUrl) continue;
      const isPlayed = sniffed && sniffed.license_url && sniffed.url &&
        manifestAsset(sniffed.url) && manifestAsset(sniffed.url) === manifestAsset(lec.dashUrl);
      const moveRel = `${plan.courseTitle}/${ch.title}/${lec.name}.mp4`;
      jobs.push({
        url: lec.dashUrl,
        drm: "widevine",
        license_url: isPlayed ? sniffed.license_url : licenseUrlFor(lec.licenseToken),
        // mint a live token right before this job downloads (below); the played
        // lecture keeps the sniffed URL whose token is already valid now.
        assetId: isPlayed ? null : lec.assetId,
        title: lec.name,
        course: plan.courseTitle,
        filename: destSub ? `${destSub}/${moveRel}` : moveRel,
        moveRel,
        content_key: `udemy:${plan.courseTitle}:${lec.name}`,
      });
    }
  }
  if (!jobs.length) {
    return { queued: 0, note: "no DRM lectures found (or none exposed a DASH manifest)" };
  }

  // Skip lectures already on disk (by filename) when the user opted in and a
  // move target is set. Filename-only: an updated video with the same name is
  // skipped too, so the option is off-switchable for a forced re-download.
  let skipped = 0;
  const { nativeTarget } = await getSettings();
  if (prefs.skip_existing !== false && nativeTarget) {
    const want = jobs.map((j) => nativeTarget.replace(/[\/\\]+$/, "") + "\\" + j.moveRel.replace(/\//g, "\\"));
    const present = await nativeExists(want);
    const remaining = jobs.filter((j, i) => {
      const hit = present[want[i]];
      if (hit) { skipped += 1; return false; }
      return true;
    });
    jobs.length = 0; jobs.push(...remaining);
  }
  if (!jobs.length) return { queued: 0, skipped, note: `all ${skipped} DRM lecture(s) already downloaded` };
  // Lecture parallelism is the "Parallel lectures" knob (hd_lanes) or the
  // options-page `parallel` (default 3); capped so many DRM decrypts don't OOM
  // the single offscreen document.
  const lanes = Math.min(12, Math.max(Number(parallel) || 0, Number(prefs.hd_lanes) || 0, 1));
  setConcurrency(lanes); // cap TOTAL across the DRM + 1080p pools, not per-pool

  let next = 0, first = null;
  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++];
      // Refresh the token right before this job starts, so it hasn't expired —
      // the JWT is only valid ~5 min from minting. The played lecture already
      // has a live sniffed URL (no assetId), so it is skipped here.
      if (job.assetId) {
        const tok = await freshLicenseToken(parsed.portal, job.assetId);
        if (tok) job.license_url = licenseUrlFor(tok);
      }
      const r = await vv.Keyframe.download(job);
      if (!first) first = r && r.id;
    }
  }
  await Promise.all(Array.from({ length: Math.min(lanes, jobs.length) }, worker));
  return { queued: jobs.length, skipped, first, lanes };
}

async function handleVv(msg, sender) {
  switch (msg.type) {
    case "vv:grab-udemy":
      return grabUdemyCourse(msg.courseUrl);
    case "vv:has-stream": {
      const tabId = msg.tabId != null ? msg.tabId : (sender && sender.tab && sender.tab.id);
      return { has: tabId != null ? await hasStream(tabId) : false };
    }
    case "vv:provider-for":
      return { service: serviceForHost(msg.host) };
    case "vv:grab-tab":
      return grabTab(msg, sender);
    case "vv:engine-status":  return vv.Keyframe.engineStatus();
    case "vv:engine-install": return vv.Keyframe.engineInstall();
    case "vv:engine-update":  return vv.Keyframe.engineUpdate();
    case "vv:cdm-status":     return vv.Keyframe.cdmStatus();
    case "vv:cdm-validate":   return vv.Keyframe.cdmValidate();
    case "vv:set-wvd":        return vv.Keyframe.setWvd(msg.b64, msg.name);
    case "vv:submit": {
      // optionally attach harvested provider auth before dispatching
      const job = { ...(msg.job || {}) };
      if (msg.authHost) {
        const harvested = await vvProviderHeaders(msg.authHost);
        job.headers = [...(job.headers || []), ...harvested];
      }
      return msg.resolveFirst ? vv.Keyframe.grab(job) : vv.Keyframe.download(job);
    }
    case "vv:resolve":     return vv.Keyframe.resolve(msg.job);
    case "vv:jobs":        return vv.Keyframe.jobs(msg.statuses);
    case "vv:job":         return vv.Keyframe.job(msg.id);
    case "vv:cancel":      return vv.Keyframe.cancel(msg.id);
    case "vv:remove":      return vv.Keyframe.remove(msg.id);
    case "vv:retry":       return vv.Keyframe.retry(msg.id);
    case "vv:clear":       return vv.Keyframe.clear();
    case "vv:watch-list":  return vv.Keyframe.watchList();
    case "vv:watch-add":   return vv.Keyframe.watchAdd(msg.spec);
    case "vv:watch-remove":return vv.Keyframe.watchRemove(msg.id);
    case "vv:watch-poll":  return vv.Keyframe.watchPoll();
    case "vv:vault":       return vv.Keyframe.vaultStats();
    default: throw new Error(`unknown vv op: ${msg.type}`);
  }
}
