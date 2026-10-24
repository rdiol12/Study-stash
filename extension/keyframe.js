// Keyframe DRM engine — fully standalone, in-extension. No native host, no Docker.
//
// The Widevine CDM, CENC decryption, MPD parsing and muxing all run in JS
// (wvcdm.js / cenc.js / dash.js / remux.js, loaded in the offscreen document).
// This module is the service-worker-side controller: it stores the user's .wvd,
// drives the offscreen pipeline, saves the file via chrome.downloads, and tracks
// jobs in chrome.storage. The export surface matches the old native client so
// callers (grabUdemyCourse / grabTab / the UI) are unchanged.

import { registerDownloadName } from "./name-guard.js";
import { getSettings, setCourseRoot } from "./common.js";
import { nativeWriteFile } from "./native.js";
import { acquireSlot, releaseSlot } from "./gate.js";
import "./wvcdm.js"; // runs its IIFE -> self.WVCDM in the service worker (the
// license request must happen here so it carries the browser's Udemy session).

function headersToObj(h) {
  if (!h) return {};
  if (!Array.isArray(h)) return h; // already an object (background sends this)
  const o = {};
  for (const line of h) { const i = line.indexOf(":"); if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return o;
}

const JOBS_KEY = "keyframe.jobs";
const WVD_KEY = "keyframe.wvd";
const COURSES_KEY = "courses";
const REGISTERED_KEY = "keyframe.registered";

let seq = 0;
const listeners = new Set();

export function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(event, payload) { for (const fn of listeners) { try { fn(event, payload); } catch { /* ignore */ } } }

// --------------------------------------------------------------- CDM (.wvd) storage
// Priority: a user-loaded device (chrome.storage) wins; otherwise auto-import a
// .wvd bundled in the extension at cdm/device.wvd (an extension CAN read its own
// packaged files, but never an arbitrary folder on disk).
async function getWvd() {
  const stored = (await chrome.storage.local.get(WVD_KEY))[WVD_KEY];
  if (stored) return stored;
  return importBundledWvd();
}
async function importBundledWvd() {
  try {
    const res = await fetch(chrome.runtime.getURL("cdm/device.wvd"));
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length < 4 || String.fromCharCode(buf[0], buf[1], buf[2]) !== "WVD") return null;
    let bin = ""; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    const rec = { b64: btoa(bin), name: "device.wvd (bundled)", at: Date.now() };
    await chrome.storage.local.set({ [WVD_KEY]: rec });
    return rec;
  } catch { return null; }
}
export async function setWvd(b64, name) {
  if (!b64) { await chrome.storage.local.remove(WVD_KEY); return { ok: true, cleared: true }; }
  await chrome.storage.local.set({ [WVD_KEY]: { b64, name: name || "device.wvd", at: Date.now() } });
  return { ok: true, name: name || "device.wvd" };
}

// --------------------------------------------------------------- jobs
async function allJobs() { return (await chrome.storage.local.get(JOBS_KEY))[JOBS_KEY] || {}; }
// Serialize writes: with parallel lanes, a bare read-modify-write would let one
// job's save clobber another's (they read the same map and race on set()).
let writeChain = Promise.resolve();
function saveJob(patch) {
  const run = async () => {
    const jobs = await allJobs();
    jobs[patch.id] = { ...(jobs[patch.id] || {}), ...patch };
    await chrome.storage.local.set({ [JOBS_KEY]: jobs });
    emit("job.updated", jobs[patch.id]);
    return jobs[patch.id];
  };
  const result = writeChain.then(run, run);
  writeChain = result.catch(() => {});
  return result;
}

// --------------------------------------------------------------- offscreen + download
async function ensureOffscreen() {
  if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Decrypt and assemble DRM video in memory before saving.",
    });
  } catch (err) { if (!/single offscreen/i.test(err.message || "")) throw err; }
}
function sanitizeName(p) {
  return String(p || "video.mp4").replace(/\\/g, "/").split("/").map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, "_")).join("/");
}
function downloadBlob(url, filename) {
  // blob downloads ignore the filename arg and save as "<uuid>.mp4"; name-guard
  // forces our relative path via onDeterminingFilename, so register it first.
  registerDownloadName(url, filename);
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false }, (id) => {
      const e = chrome.runtime.lastError; e ? reject(new Error(e.message)) : resolve(id);
    });
  });
}

// relay fine-grained offscreen progress to job listeners
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "hls-progress" && String(msg.jobId || "").startsWith("drm-")) {
    const percent = msg.segTotal ? Math.round((100 * msg.segDone) / msg.segTotal) : undefined;
    // persist so the popup (which reads storage) shows a moving bar; don't touch
    // status here, so a late tick can't resurrect a finished job.
    saveJob({ id: msg.jobId, stage: msg.stage, bytes: msg.bytes, ...(percent != null ? { percent } : {}) }).catch(() => {});
  }
});

/** Run one DRM download end to end. job: {url(mpd), headers, license_url,
 *  license_headers, title, filename, maxHeight}. Returns {id}. */
async function download(job) {
  const id = job.job_id || `drm-${Date.now()}-${++seq}`;
  await saveJob({ id, status: "running", percent: 0, title: job.title, url: job.url,
    course: job.course, filename: job.filename, moveRel: job.moveRel, createdAt: Date.now() });
  const wvd = await getWvd();
  if (!wvd) {
    await saveJob({ id, status: "failed", error: "no CDM — load your .wvd in the Keyframe panel" });
    emit("job.failed", { id, error: "no CDM" });
    return { id };
  }
  await acquireSlot(); // global cap shared with the 1080p pool
  try {
    await ensureOffscreen();
    // 1. parse the MPD in the offscreen document (it has DOMParser)
    const parsed = await chrome.runtime.sendMessage({
      target: "offscreen", type: "drm-parse", mpdUrl: job.url, maxHeight: job.maxHeight,
    });
    if (!parsed || !parsed.ok) throw new Error((parsed && parsed.error) || "could not parse the manifest");
    const licUrl = job.license_url || parsed.licenseUrl;
    if (!licUrl) throw new Error("no license URL (not in manifest and none supplied)");
    // 2. get content keys HERE in the service worker, so the license request
    //    carries the browser's Udemy session (offscreen fetches cannot).
    const kr = await self.WVCDM.widevineKeys({
      wvd: self.WVCDM.b64ToU8(wvd.b64),
      initData: self.WVCDM.b64ToU8(parsed.psshInit),
      licenseUrl: licUrl,
      licenseHeaders: headersToObj(job.license_headers),
    });
    if (!kr.keys.length) throw new Error("license returned no content keys");
    const keysByKid = {}; for (const k of kr.keys) keysByKid[k.kid] = k.key;
    // 3. download + decrypt + mux in the offscreen document
    const res = await chrome.runtime.sendMessage({
      target: "offscreen", type: "drm-decrypt", jobId: id, index: 0,
      video: parsed.video, audio: parsed.audio, keysByKid,
    });
    if (!res || !res.ok) throw new Error((res && res.error) || "decrypt/mux failed");
    const filename = sanitizeName(job.filename || `${job.title || "video"}.mp4`);
    const { nativeTarget } = await getSettings();

    let finalPath = null, downloadId = null;
    if (res.bytesId && nativeTarget) {
      // Stream the bytes straight to the user's folder through the native helper
      // — no chrome.downloads (so no Save As dialog) and no separate move step.
      const dest = nativeTarget.replace(/[\/\\]+$/, "") + "\\" + (job.moveRel || filename).replace(/\//g, "\\");
      let offset = 0;
      const getNextChunk = async () => {
        const c = await chrome.runtime.sendMessage({ target: "offscreen", type: "bytes-chunk", bytesId: res.bytesId, offset });
        if (!c || !c.ok) throw new Error((c && c.error) || "failed to read decrypted bytes");
        offset = c.next;
        if (res.size) saveJob({ id, percent: Math.min(99, Math.round((100 * offset) / res.size)) }).catch(() => {});
        return c.b64 || null; // "" ends the stream
      };
      await nativeWriteFile(dest, getNextChunk);
      finalPath = dest;
    } else {
      // Fallback (no destination folder set): the blob path via chrome.downloads.
      downloadId = await downloadBlob(res.blobUrl, filename);
      try { const [live] = await chrome.downloads.search({ id: downloadId }); finalPath = live ? live.filename : filename; } catch { finalPath = filename; }
    }
    // free the buffered bytes + any fallback blob URL in the offscreen
    chrome.runtime.sendMessage({ target: "offscreen", type: "bytes-free", bytesId: res.bytesId }).catch(() => {});
    chrome.runtime.sendMessage({ target: "offscreen", type: "hls-revoke", blobUrl: res.blobUrl }).catch(() => {});

    await saveJob({ id, status: "done", percent: 100, bytes: res.size, height: res.height, output: finalPath, downloadId });
    emit("job.completed", { id, job_id: id, output: finalPath, title: job.title });
    // Udemy course flow: the manifest already holds one course card with every
    // lecture — just point it at the folder. Only standalone/manual DRM (no
    // job.course) registers its own library card.
    if (job.course) {
      const relParts = String(job.moveRel || "").split("/");       // course/chapter/lecture.mp4
      const manifestRel = relParts.slice(1).join("\\");            // chapter\lecture.mp4
      const fp = String(finalPath).replace(/\//g, "\\");
      const root = manifestRel && fp.toLowerCase().endsWith(manifestRel.toLowerCase())
        ? fp.slice(0, fp.length - manifestRel.length).replace(/[\\]+$/, "")
        : null;
      if (root) await setCourseRoot(job.course, root).catch(() => {});
    } else {
      await registerCompleted({ job_id: id, output: finalPath, title: job.title }).catch(() => {});
    }
  } catch (err) {
    await saveJob({ id, status: "failed", error: err.message });
    emit("job.failed", { id, error: err.message });
  } finally {
    releaseSlot();
  }
  return { id };
}

// --------------------------------------------------------------- public API (same shape as before)
export const Keyframe = {
  engineStatus: async () => ({ installed: true, standalone: true, ready: true, drm_ready: !!(await getWvd()), ffmpeg: true, mp4decrypt: true, pywidevine: true }),
  engineInstall: async () => ({ ok: true, ...(await Keyframe.engineStatus()) }),
  engineUpdate: async () => ({ ok: true, ...(await Keyframe.engineStatus()) }),
  cdmStatus: async () => { const w = await getWvd(); return { cdm: !!w, available: !!w, count: w ? 1 : 0, cdm_file: w ? w.name : null, cdm_devices: w ? [w.name] : [], ready: !!w, pywidevine: true, standalone: true }; },
  cdmValidate: async () => { const s = await Keyframe.cdmStatus(); s.ok = s.ready; s.hint = s.ready ? `CDM loaded: ${s.cdm_file}` : "load your own .wvd device file"; return s; },
  setWvd,
  resolve: async (payload) => ({ status: "done", id: `drm-${Date.now()}-${++seq}`, ...payload }),
  download,
  jobs: async (statuses) => { const j = Object.values(await allJobs()); return statuses ? j.filter((x) => statuses.includes(x.status)) : j; },
  job: async (id) => (await allJobs())[id] || null,
  cancel: async (id) => { await chrome.runtime.sendMessage({ target: "offscreen", type: "hls-cancel", jobId: id }).catch(() => {}); await saveJob({ id, status: "cancelled" }); return { ok: true }; },
  remove: async (id) => { await chrome.runtime.sendMessage({ target: "offscreen", type: "hls-cancel", jobId: id }).catch(() => {}); const j = await allJobs(); delete j[id]; await chrome.storage.local.set({ [JOBS_KEY]: j }); return { ok: true }; },
  retry: async () => ({ ok: false, error: "retry is not supported in standalone mode" }),
  clear: async () => { const j = await allJobs(); for (const k of Object.keys(j)) if (["done", "failed", "cancelled"].includes(j[k].status)) delete j[k]; await chrome.storage.local.set({ [JOBS_KEY]: j }); return { ok: true }; },
  drain: async () => ({ ok: true }),
  watchList: async () => [], watchAdd: async () => ({ ok: true }), watchRemove: async () => ({ ok: true }), watchPoll: async () => ({ ok: true }),
  vaultStats: async () => ({}),
  async grab(payload) { return download(payload); },
};

/** Thin dispatcher kept for any caller still using call(method, payload). */
export function call(method, payload = {}) {
  const map = {
    "engine.status": () => Keyframe.engineStatus(), "engine.install": () => Keyframe.engineInstall(),
    "engine.update": () => Keyframe.engineUpdate(), "cdm.status": () => Keyframe.cdmStatus(),
    "cdm.validate": () => Keyframe.cdmValidate(), "resolve": () => Keyframe.resolve(payload),
    "download.start": () => Keyframe.download(payload), "job.list": () => Keyframe.jobs(payload.statuses),
    "job.get": () => Keyframe.job(payload.job_id), "job.cancel": () => Keyframe.cancel(payload.job_id),
    "job.clear": () => Keyframe.clear(), "queue.drain": () => Keyframe.drain(),
  };
  if (!map[method]) return Promise.reject(new Error(`unknown method: ${method}`));
  return Promise.resolve(map[method]());
}

// --------------------------------------------------------------- player registration

function splitPath(p) {
  const norm = String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  return idx < 0 ? { root: "", name: norm } : { root: norm.slice(0, idx), name: norm.slice(idx + 1) };
}

/** Register a finished download into the player's `courses` library. Idempotent. */
export async function registerCompleted(payload) {
  const id = payload.job_id || payload.id;
  const output = payload.output || payload.output_path;
  if (!id || !output) return false;

  const done = (await chrome.storage.local.get(REGISTERED_KEY))[REGISTERED_KEY] || {};
  if (done[id]) return false;

  const { root, name } = splitPath(output);
  if (!root || !name) return false;
  if (!/\.(mkv|mp4|webm|mov|avi)$/i.test(name)) {
    done[id] = true;
    await chrome.storage.local.set({ [REGISTERED_KEY]: done });
    return false;
  }

  const meta = payload.meta || {};
  const isEpisode = meta.season != null || meta.episode != null;
  const groupId = (isEpisode && (payload.title || meta.title)) || payload.title || meta.title || splitPath(root).name || "Keyframe Library";
  const itemName = payload.title || meta.title || name.replace(/\.[^.]+$/, "");

  const stored = await chrome.storage.local.get(COURSES_KEY);
  const courses = stored[COURSES_KEY] || {};
  const course = courses[groupId] || {
    id: groupId, title: groupId, root, source: "keyframe",
    sections: [{ title: "", items: [] }], savedAt: Date.now(),
  };

  let rel = name;
  const outFwd = output.replace(/\\/g, "/");
  if (course.root && root !== course.root && outFwd.startsWith(course.root + "/")) {
    rel = outFwd.slice(course.root.length + 1);
  } else if (course.root && root !== course.root) {
    course.root = root;
  }

  const section = course.sections[0] || { title: "", items: [] };
  if (!section.items.some((i) => i.rel === rel)) {
    section.items.push({ name: itemName, kind: "video", rel, drm: false, captions: [] });
  }
  course.sections[0] = section;
  course.savedAt = Date.now();
  courses[groupId] = course;
  await chrome.storage.local.set({ [COURSES_KEY]: courses });

  done[id] = true;
  await chrome.storage.local.set({ [REGISTERED_KEY]: done });
  return true;
}

/** Reconcile on wake. Standalone: always reachable; just report tracked jobs. */
export async function reconcile() {
  const jobs = Object.values(await allJobs());
  const active = jobs.filter((j) => ["queued", "resolving", "running"].includes(j.status)).length;
  return { reachable: true, active, failed: jobs.some((j) => j.status === "failed"), registered: 0, jobs };
}
