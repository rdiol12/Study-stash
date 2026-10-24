// Drives the 1080p path from the service worker.
//
// Split of responsibility is forced by a platform constraint: an offscreen
// document only gets chrome.runtime -- no chrome.storage, no chrome.downloads,
// no chrome.notifications. So the worker does only fetch + transmux + blob URL,
// and everything stateful lives here.

import { nativeMove, nativeWriteFile, nativeExists } from "./native.js";
import { getSettings, getPrefs, setCourseRoot } from "./common.js";
import { setConcurrency, acquireSlot, releaseSlot } from "./gate.js";
import { registerDownloadName } from "./name-guard.js";

const HD_KEY = "hdJobs";
const MAX_KEPT = 10;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJobs() {
  const stored = await chrome.storage.local.get(HD_KEY);
  return stored[HD_KEY] || [];
}

async function writeJobs(jobs) {
  await chrome.storage.local.set({ [HD_KEY]: jobs.slice(0, MAX_KEPT) });
}

async function patchJob(jobId, patch) {
  const jobs = await readJobs();
  const idx = jobs.findIndex((j) => j.id === jobId);
  if (idx === -1) return null;
  jobs[idx] = { ...jobs[idx], ...patch };
  await writeJobs(jobs);
  return jobs[idx];
}

async function patchEntry(jobId, index, patch) {
  const jobs = await readJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job || !job.entries[index]) return;
  job.entries[index] = { ...job.entries[index], ...patch };
  await writeJobs(jobs);
}

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message,
      priority: 1,
    });
  } catch {
    /* the popup still shows the result */
  }
}

/** Destroy the worker. Only ever called for an explicit user cancel: an
 *  earlier version called it from the watchdog and killed healthy workers. */
export async function closeWorker() {
  try {
    if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.closeDocument();
      return true;
    }
  } catch {
    /* already gone */
  }
  return false;
}

async function pingWorker(timeoutMs = 8000) {
  try {
    const res = await Promise.race([
      chrome.runtime.sendMessage({ target: "offscreen", type: "hls-ping" }),
      wait(timeoutMs).then(() => {
        throw new Error("ping timed out");
      }),
    ]);
    return res && res.ok ? res : null;
  } catch {
    return null;
  }
}

async function ensureOffscreen() {
  const alive = await pingWorker();
  if (alive) return { ok: true, pong: alive };

  // never tear down on a missed ping; a busy worker can drop one
  if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) {
    return { ok: true, pong: null, busy: true };
  }

  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification:
        "Assemble MP4 files from HLS video segments in memory before saving them.",
    });
  } catch (err) {
    if (!/single offscreen/i.test(err.message || "")) {
      return { ok: false, reason: `createDocument failed: ${err.message}` };
    }
  }

  for (let i = 0; i < 12; i += 1) {
    const pong = await pingWorker(1500);
    if (pong) return { ok: true, pong };
    await wait(300);
  }
  return {
    ok: false,
    reason: "worker created but never answered a ping (its module failed to load)",
  };
}

function parseChapterFilter(raw) {
  const text = String(raw || "").replace(/\s/g, "");
  if (!text) return null;
  const want = new Set();
  for (const part of text.split(",")) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      for (let i = Number(range[1]); i <= Number(range[2]); i += 1) want.add(i);
    } else if (/^\d+$/.test(part)) {
      want.add(Number(part));
    }
  }
  return want.size ? want : null;
}

/** Videos that can take the HLS path: unencrypted and with a master playlist. */
export function hdCandidates(plan, opts = {}) {
  const wantChapters = parseChapterFilter(opts.chapter);
  const out = [];
  const root = [opts.dest, plan.courseTitle].filter(Boolean).join("/");

  plan.chapters.forEach((chapter, idx) => {
    if (wantChapters && !wantChapters.has(idx + 1)) return;
    for (const lecture of chapter.lectures) {
      if (lecture.kind !== "video" || lecture.drm || !lecture.hlsUrl) continue;
      out.push({
        path: `${root}/${chapter.title}/${lecture.name}.mp4`,
        masterUrl: lecture.hlsUrl,
        maxHeight: opts.maxHeight || 1080,
        state: "pending",
      });
    }
  });
  return out;
}

function downloadBlobUrl(blobUrl, path) {
  // the determining-filename hook is what actually lands the name; the
  // filename option below proved to be only advisory for blob URLs
  registerDownloadName(blobUrl, path);
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: blobUrl, filename: path, conflictAction: "overwrite", saveAs: false },
      (id) => {
        if (chrome.runtime.lastError || id === undefined) {
          reject(new Error(chrome.runtime.lastError?.message || "download refused"));
          return;
        }
        const onChanged = (delta) => {
          if (delta.id !== id) return;
          const s = delta.state && delta.state.current;
          if (s === "complete") {
            chrome.downloads.onChanged.removeListener(onChanged);
            resolve(id);
          } else if (s === "interrupted") {
            chrome.downloads.onChanged.removeListener(onChanged);
            reject(new Error((delta.error && delta.error.current) || "download interrupted"));
          }
        };
        chrome.downloads.onChanged.addListener(onChanged);
      }
    );
  });
}

/** Progress pushed from the worker, which cannot write storage itself. */
export async function applyProgress(p) {
  const jobs = await readJobs();
  const job = jobs.find((j) => j.id === p.jobId);
  if (!job) return;
  const entry = job.entries[p.index];
  // progress lives on the entry: with parallel lanes there is no single
  // "current" lecture, and the file list shows each one's own bar
  if (entry) {
    job.entries[p.index] = {
      ...entry,
      segDone: p.segDone || 0,
      segTotal: p.segTotal || 0,
      liveBytes: p.bytes || 0,
      stage: p.stage || "",
    };
  }
  job.current = {
    path: entry ? entry.path : "",
    segDone: p.segDone || 0,
    segTotal: p.segTotal || 0,
    height: p.height || null,
    bytes: p.bytes || 0,
    stage: p.stage || "",
    updatedAt: Date.now(),
  };
  if (p.segTotal) job.segPerLecture = p.segTotal;
  const done = job.entries.filter((e) => e.state === "complete").length;
  job.segDoneTotal = done * (job.segPerLecture || 0) + (p.segDone || 0);
  await writeJobs(jobs);
}

/** The per-lecture loop. Runs in the service worker; each round trip to the
 *  worker also keeps this context alive. */
let claimLock = Promise.resolve();
function withClaimLock(fn) {
  const run = claimLock.then(fn, fn);
  claimLock = run.then(() => {}, () => {});
  return run;
}

/**
 * Background driver: lanes claim lectures, the offscreen worker fetches and
 * transmuxes each one, chrome.downloads saves the blob. No tab anywhere --
 * the runner-tab design is gone; it existed only for FSA folder handles,
 * which the native helper has replaced.
 */
export async function runHdJob(jobId) {
  const job0 = await patchJob(jobId, { startedAt: Date.now(), segDoneTotal: 0 });
  const lanes = Math.max(1, Math.min(12, (job0 && job0.concurrency) || 1));
  const settings = await getSettings();
  const nativeTarget = settings.nativeTarget; // set -> stream to disk, no chrome.downloads
  const { prefs } = await getPrefs();
  setConcurrency(Math.min(12, Math.max(Number(settings.parallel) || 0, Number(prefs.hd_lanes) || 0, 1)));
  let ok = 0;
  let bad = 0;

  const claim = () =>
    withClaimLock(async () => {
      const jobs = await readJobs();
      const job = jobs.find((j) => j.id === jobId);
      if (!job || job.cancelRequested || job.status === "cancelled") return null;
      const i = job.entries.findIndex((e) => e.state === "pending");
      if (i === -1) return null;
      job.entries[i] = { ...job.entries[i], state: "active" };
      await writeJobs(jobs);
      return { i, entry: job.entries[i] };
    });

  async function lane() {
    for (;;) {
      const got = await claim();
      if (!got) return;
      const { i, entry } = got;
      await acquireSlot(); // shared global cap with the DRM pool
      try {

      let res;
      try {
        res = await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "hls-build",
          jobId,
          index: i,
          path: entry.path,
          masterUrl: entry.masterUrl,
          maxHeight: entry.maxHeight,
        });
      } catch (err) {
        res = { ok: false, error: `worker unreachable: ${err.message}` };
      }

      if (!res || !res.ok) {
        bad += 1;
        await patchEntry(jobId, i, {
          state: "error",
          reason: (res && res.error) || "no reply from worker",
        });
        continue;
      }

      try {
        let abs = null, downloadId = null;
        if (res.bytesId && nativeTarget) {
          // Stream straight to the user's folder via the helper — no
          // chrome.downloads (no Save As) and no later move step.
          const relNoSub = entry.path.split("/").slice(1).join("/").replace(/\//g, "\\");
          abs = nativeTarget.replace(/[\/\\]+$/, "") + "\\" + relNoSub;
          let offset = 0;
          await nativeWriteFile(abs, async () => {
            const c = await chrome.runtime.sendMessage({ target: "offscreen", type: "bytes-chunk", bytesId: res.bytesId, offset });
            if (!c || !c.ok) throw new Error((c && c.error) || "failed to read bytes");
            offset = c.next;
            return c.b64 || null;
          });
        } else {
          // Fallback (no destination folder set): blob via chrome.downloads.
          downloadId = await downloadBlobUrl(res.blobUrl, entry.path);
          try { const [live] = await chrome.downloads.search({ id: downloadId }); abs = live ? live.filename : null; } catch { /* cosmetic */ }
        }
        ok += 1;
        await patchEntry(jobId, i, {
          state: "complete", bytes: res.size, height: res.height, downloadId, abs, nativeWritten: !!(res.bytesId && nativeTarget),
        });
      } catch (err) {
        bad += 1;
        await patchEntry(jobId, i, { state: "error", reason: err.message });
      } finally {
        try {
          await chrome.runtime.sendMessage({ target: "offscreen", type: "bytes-free", bytesId: res.bytesId });
          await chrome.runtime.sendMessage({ target: "offscreen", type: "hls-revoke", blobUrl: res.blobUrl });
        } catch { /* worker gone; blob dies with it */ }
      }
      } finally {
        releaseSlot();
      }
    }
  }

  await Promise.all(Array.from({ length: lanes }, () => lane()));

  const fin = (await readJobs()).find((j) => j.id === jobId);
  const wasCancelled = !!(fin && (fin.cancelRequested || fin.status === "cancelled"));
  await patchJob(jobId, {
    status: wasCancelled ? "cancelled" : "done",
    current: null,
    finished: Date.now(),
  });
  notify(
    wasCancelled ? "Download cancelled" : "Course download finished",
    `${ok} lecture(s) saved at 1080p${bad ? `, ${bad} failed` : ""}`
  );
}

/**
 * Relocate + register a finished HD course. Called from the worker-awaited
 * completion path so it runs with nothing open -- not dependent on a UI poll.
 */
export async function finishHdJob(jobId) {
  const job = (await readJobs()).find((j) => j.id === jobId);
  if (!job || job.status !== "done" || job.relocated || !job.counts && !job.entries) return;
  const complete = job.entries.filter((e) => e.state === "complete");
  if (!complete.length) return;
  const { nativeTarget } = await getSettings();
  // native-written entries are already in the user's folder — no move needed; a
  // move would look for a Downloads source that doesn't exist (WinError 2).
  const needsMove = complete.some((e) => e.downloadId && !e.nativeWritten);
  if (nativeTarget && needsMove) {
    try {
      const res = await relocateFinishedHdJob(jobId, nativeTarget);
      if (res) {
        await setCourseRoot(job.courseTitle, res.to);
        notify("Course moved", `${res.moved} file(s) -> ${res.to}`);
      }
    } catch (err) {
      console.warn("hd finalize relocate failed:", err.message);
    }
  } else if (nativeTarget) {
    // all streamed straight to disk; point the player library at the folder
    await setCourseRoot(job.courseTitle, nativeTarget.replace(/[\/\\]+$/, "") + "\\" + job.courseTitle).catch(() => {});
  } else {
    // no helper: record the download-folder location for the player
    const done = complete.find((e) => e.abs);
    if (done) {
      const rel = done.path.replace(/\//g, "\\");
      if (done.abs.toLowerCase().endsWith(rel.toLowerCase())) {
        const root = done.abs.slice(0, done.abs.length - rel.length);
        const parts = done.path.split("/");
        await setCourseRoot(job.courseTitle, root + parts[0] + "\\" + parts[1]);
      }
    }
  }
}

export async function startHdJob(plan, opts = {}) {
  let entries = hdCandidates(plan, opts);
  if (!entries.length) throw new Error("No HLS-capable lectures found for HD mode.");
  // Skip lectures already on disk in the destination (final location =
  // nativeTarget\<course>\<chapter>\<file>, i.e. the entry path minus destSub).
  if (opts.skipExisting && opts.nativeTarget) {
    const rel = (p) => p.replace(/\\/g, "/").split("/").slice(1).join("/").replace(/\//g, "\\");
    const want = entries.map((e) => opts.nativeTarget.replace(/[\/\\]+$/, "") + "\\" + rel(e.path));
    const present = await nativeExists(want);
    entries = entries.filter((e, i) => !present[want[i]]);
  }
  if (!entries.length) return null; // everything already downloaded

  const job = {
    id: `hd-${Date.now().toString(36)}`,
    mode: "local-hd",
    courseTitle: plan.courseTitle,
    created: Date.now(),
    status: "running",
    index: 0,
    current: null,
    concurrency: Math.max(1, Math.min(12, Number(opts.concurrency) || 1)),
    entries,
  };

  const jobs = await readJobs();
  jobs.unshift(job);
  await writeJobs(jobs);

  const worker = await ensureOffscreen();
  if (!worker.ok) {
    await patchJob(job.id, { status: "error", error: worker.reason });
    throw new Error(worker.reason);
  }
  runHdJob(job.id)
    .then(() => finishHdJob(job.id))
    .catch(async (err) => {
      await patchJob(job.id, { status: "error", error: err.message, current: null });
    });
  return job;
}

/** Restart the driver for a job left running (e.g. the worker was reloaded). */
export async function resumeHdJobs() {
  const jobs = await readJobs();
  const running = jobs.find((j) => j.status === "running");
  if (!running) return null;
  running.entries = running.entries.map((e) =>
    e.state === "active" ? { ...e, state: "pending" } : e
  );
  await writeJobs(jobs);
  const worker = await ensureOffscreen();
  if (!worker.ok) return null;
  runHdJob(running.id).then(() => finishHdJob(running.id)).catch(() => {});
  return running.id;
}

/**
 * Report a job whose driver never got going. Deliberately does not close the
 * worker: this runs on every progress poll, and an earlier version destroyed
 * healthy workers mid-job.
 */
export async function watchdogHdJobs({ graceMs = 600000 } = {}) {
  const jobs = await readJobs();
  let changed = false;
  for (const job of jobs) {
    if (job.status !== "running" || job.startedAt) continue;
    if (Date.now() - (job.created || 0) < graceMs) continue;
    job.status = "error";
    job.current = null;
    job.error =
      "Not started yet — open the Udemy Downloader tab and click Allow access.";
    changed = true;
  }
  if (changed) await writeJobs(jobs);
  return changed;
}

/** Move a finished HD course to its final home via the native helper. The
 *  absolute download root comes from a completed entry's recorded filename. */
export async function relocateFinishedHdJob(jobId, target) {
  const jobs = await readJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job || job.relocated || !target) return null;

  const done = job.entries.find((e) => e.state === "complete" && e.abs);
  if (!done) return null;
  const rel = done.path.replace(/\//g, "\\");
  if (!done.abs.toLowerCase().endsWith(rel.toLowerCase())) return null;
  const root = done.abs.slice(0, done.abs.length - rel.length);

  // path = <destSub>/<courseTitle>/<chapter>/<file>; move the course folder
  const sub = done.path.split("/")[0];
  const courseDirName = done.path.split("/")[1];
  const from = root + sub + "\\" + courseDirName;
  const to = target.replace(/[\/]+$/, "") + "\\" + courseDirName;

  const res = await nativeMove(from, to);
  job.relocated = to;
  job.movedFiles = res.moved;
  await writeJobs(jobs);
  // moved off the download folder — clear their browser download-history rows
  for (const e of job.entries) {
    if (e.downloadId) { try { await chrome.downloads.erase({ id: e.downloadId }); } catch { /* gone */ } }
  }
  return res;
}

export async function listHdJobs() {
  return readJobs();
}

export async function hdJobStatus(jobId) {
  const job = (await readJobs()).find((j) => j.id === jobId);
  if (!job) return null;

  const counts = { complete: 0, error: 0, pending: 0, cancelled: 0, active: 0 };
  let bytes = 0;
  for (const entry of job.entries) {
    if (entry.state === "complete") {
      counts.complete += 1;
      bytes += entry.bytes || 0;
    } else if (entry.state === "error") counts.error += 1;
    else if (entry.state === "cancelled") counts.cancelled += 1;
    else if (entry.state === "active") {
      counts.active = (counts.active || 0) + 1;
      bytes += entry.liveBytes || 0;
    } else counts.pending += 1;
  }

  // segments are the only measurable unit: a TS stream has no Content-Length
  let etaSeconds = null;
  if (job.status === "running" && job.startedAt && job.segDoneTotal > 0) {
    const elapsed = (Date.now() - job.startedAt) / 1000;
    const rate = job.segDoneTotal / elapsed;
    const perLecture = job.segPerLecture || 0;
    if (rate > 0 && perLecture > 0) {
      const estTotal = perLecture * job.entries.length;
      etaSeconds = Math.round(Math.max(0, estTotal - job.segDoneTotal) / rate);
    }
  }

  const stalledFor =
    job.status === "running" && job.current && job.current.updatedAt
      ? Math.round((Date.now() - job.current.updatedAt) / 1000)
      : null;

  return { ...job, counts, bytes, total: job.entries.length, etaSeconds, stalledFor };
}

export async function cancelHdJob(jobId) {
  const jobs = await readJobs();
  const job = jobId
    ? jobs.find((j) => j.id === jobId)
    : jobs.find((j) => j.status === "running");
  if (!job) return false;
  job.cancelRequested = true;
  job.status = "cancelled";
  job.current = null;
  await writeJobs(jobs);
  return true;
}

/** Skip one lecture without stopping the job. */
export async function skipHdEntry(jobId, index) {
  const jobs = await readJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job || !job.entries[index]) return false;
  if (job.entries[index].state === "complete") return false;
  job.entries[index] = {
    ...job.entries[index],
    state: "cancelled",
    reason: "skipped by you",
  };
  await writeJobs(jobs);
  // if it's the one in flight, stop its fetches
  try {
    await chrome.runtime.sendMessage({ target: "offscreen", type: "hls-cancel" });
  } catch {
    /* not running */
  }
  return true;
}

export async function removeHdJob(jobId) {
  const jobs = await readJobs();
  await writeJobs(jobs.filter((j) => j.id !== jobId));
}
