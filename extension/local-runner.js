// Local mode: download without the container, using Chrome's own download
// manager. Every item is enqueued up front rather than driven by a JS loop --
// an MV3 service worker can be terminated at any time, but native downloads
// keep running, so the browser owns the queue and we only observe it.

import { nativeMove, nativeExists, nativeWriteFile } from "./native.js";
// NOTE: circular with common.js (it imports startLocalJob) -- safe because the
// binding is only invoked at call time, never during module evaluation.
import { getSettings, getPrefs } from "./common.js";
import { registerDownloadName } from "./name-guard.js";
import { vttToSrt } from "./subs.js";

const JOBS_KEY = "localJobs";
const MAX_JOBS_KEPT = 20;

async function readJobs() {
  const stored = await chrome.storage.local.get(JOBS_KEY);
  return stored[JOBS_KEY] || [];
}

async function writeJobs(jobs) {
  await chrome.storage.local.set({ [JOBS_KEY]: jobs.slice(0, MAX_JOBS_KEPT) });
}

/** Flatten a plan into concrete download items, honouring the UI options. */
export function flattenPlan(plan, opts = {}) {
  const items = [];
  const root = [opts.dest, plan.courseTitle].filter(Boolean).join("/");
  const wantChapters = parseChapterFilter(opts.chapter);

  plan.chapters.forEach((chapter, idx) => {
    if (wantChapters && !wantChapters.has(idx + 1)) return;
    const dir = `${root}/${chapter.title}`;

    for (const lecture of chapter.lectures) {
      if (lecture.kind === "quiz" && opts.quizzes) {
        if (lecture.dataUrl) {
          // generated interactive player; a data: URL downloads like any other
          items.push({ path: `${dir}/${lecture.name}.html`, url: lecture.dataUrl });
        } else {
          items.push({
            path: `${dir}/${lecture.name}.html`,
            skipped: lecture.unsupported || "quiz not generated",
          });
        }
        continue;
      }
      if (lecture.kind === "video" && !opts.skipLectures) {
        if (lecture.drm) {
          items.push({ path: `${dir}/${lecture.name}.mp4`, skipped: "drm" });
        } else if (lecture.url) {
          items.push({ path: `${dir}/${lecture.name}.mp4`, url: lecture.url });
        } else {
          // HLS-only and unencrypted: reachable, but not without a muxer
          items.push({ path: `${dir}/${lecture.name}.mp4`, skipped: "hls-only" });
        }
      }
      if (opts.captions) {
        const want = (opts.lang || "en").toLowerCase();
        for (const cap of lecture.captions || []) {
          if (want !== "all" && cap.lang.toLowerCase().split("_")[0] !== want) continue;
          // default: convert the VTT to SRT on the way down; keep_vtt leaves it raw
          if (opts.keepVtt) items.push({ path: `${dir}/${lecture.name}.${cap.lang}.vtt`, url: cap.url });
          else items.push({ path: `${dir}/${lecture.name}.${cap.lang}.srt`, url: cap.url, convert: "srt" });
        }
      }
      if (opts.assets) {
        for (const asset of lecture.assets || []) {
          if (!asset.url) continue;
          items.push({ path: `${dir}/${lecture.name} - ${asset.name}`, url: asset.url });
        }
      }
    }
  });
  return items;
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

async function startDownload(item) {
  let url = item.url;
  let path = item.path;
  // Subtitles: fetch the VTT and hand Chrome a converted SRT as a data: URL
  // (small text, so no offscreen/blob needed). Fall back to the raw VTT on error.
  if (item.convert === "srt") {
    try {
      const resp = await fetch(item.url, { credentials: "include" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const srt = vttToSrt(await resp.text());
      url = "data:application/x-subrip;charset=utf-8," + encodeURIComponent(srt);
    } catch {
      path = path.replace(/\.srt$/i, ".vtt");
    }
  }
  registerDownloadName(url, path);
  return new Promise((resolve) => {
    chrome.downloads.download(
      {
        url,
        filename: path,
        // re-runs replace rather than piling up "file (1).mp4"
        conflictAction: "overwrite",
        saveAs: false,
      },
      (id) => {
        const err = chrome.runtime.lastError;
        resolve({ id: id || null, error: err ? err.message : null });
      }
    );
  });
}

export async function startLocalJob(plan, opts = {}) {
  const items = flattenPlan(plan, opts);
  // Skip files already on disk in the destination (match the final location:
  // nativeTarget\<course>\<chapter>\<file>, i.e. the path minus the destSub).
  if (opts.skipExisting && opts.nativeTarget) {
    const rel = (p) => p.replace(/\\/g, "/").split("/").slice(1).join("/").replace(/\//g, "\\");
    const dl = items.filter((it) => it.url && !it.skipped);
    const want = dl.map((it) => opts.nativeTarget.replace(/[\/\\]+$/, "") + "\\" + rel(it.path));
    const present = await nativeExists(want);
    dl.forEach((it, i) => { if (present[want[i]]) { delete it.url; it.skipped = "already downloaded"; } });
  }
  // Captions: fetch + VTT->SRT convert + write straight to the folder via the
  // helper, so they never hit chrome.downloads (whose data-URL path pops a
  // Save As dialog in Brave). Videos/assets stay on the normal path.
  if (opts.nativeTarget) {
    const relOf = (p) => opts.nativeTarget.replace(/[\/\\]+$/, "") + "\\" + p.replace(/\\/g, "/").split("/").slice(1).join("/").replace(/\//g, "\\");
    for (const it of items) {
      if (it.convert !== "srt" || !it.url || it.skipped) continue;
      try {
        const resp = await fetch(it.url, { credentials: "include" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const u8 = new TextEncoder().encode(vttToSrt(await resp.text()));
        const dest = relOf(it.path);
        let sent = false;
        await nativeWriteFile(dest, async () => {
          if (sent) return null;
          sent = true;
          let s = ""; for (let k = 0; k < u8.length; k++) s += String.fromCharCode(u8[k]);
          return btoa(s);
        });
        it.doneNative = true; it.abs = dest; delete it.url;
      } catch { /* leave it on the chrome.downloads path as a .vtt fallback */ }
    }
  }
  // a job with nothing in it would appear and complete instantly -- noise
  if (!items.length) return null;
  const jobId = `local-${Date.now().toString(36)}`;

  // Entries start as "queued": nothing downloads yet. pumpLocalJob() feeds the
  // browser `parallel` files at a time instead of fire-hosing all ~100 at once.
  const entries = items.map((item) =>
    item.skipped
      ? { path: item.path, state: "skipped", reason: item.skipped }
      : item.doneNative
        ? { path: item.path, state: "complete", abs: item.abs, nativeWritten: true }
        : { path: item.path, url: item.url, state: "queued", convert: item.convert }
  );

  const job = {
    id: jobId,
    mode: "local",
    label: opts.skipLectures ? "extras" : "files",
    courseTitle: plan.courseTitle,
    destSub: opts.dest || "",
    created: Date.now(),
    maxHeight: plan.stats.maxHeight,
    entries,
  };
  const jobs = await readJobs();
  jobs.unshift(job);
  await writeJobs(jobs);
  await pumpLocalJob(jobId);
  return job;
}

/**
 * Keep up to `parallel` downloads in flight. Idempotent and cheap, so it can
 * be called from every progress poll; it only talks to chrome.downloads for
 * entries this job actually started.
 */
export async function pumpLocalJob(jobId) {
  // Honor whichever concurrency knob the user actually changed (options page
  // `parallel`, or the popup's "Parallel lectures"/"Concurrent" fields).
  const { parallel } = await getSettings();
  const { prefs } = await getPrefs();
  const want = Math.max(Number(parallel) || 0, Number(prefs.hd_lanes) || 0, 3);
  const limit = Math.max(1, Math.min(12, want));

  const jobs = await readJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return 0;

  let active = 0;
  for (const entry of job.entries) {
    if (!entry.downloadId || entry.state !== "pending") continue;
    const [live] = await chrome.downloads.search({ id: entry.downloadId });
    if (live && live.state === "in_progress") active += 1;
    else if (live && live.state !== "in_progress") entry.state = live.state;
  }

  let started = 0;
  for (const entry of job.entries) {
    if (active + started >= limit) break;
    if (entry.state !== "queued") continue;
    const { id, error } = await startDownload({ url: entry.url, path: entry.path, convert: entry.convert });
    if (error) {
      entry.state = "error";
      entry.reason = error;
    } else {
      entry.state = "pending";
      entry.downloadId = id;
      started += 1;
    }
  }

  await writeJobs(jobs);
  return started;
}

/** Reconcile stored entries against Chrome's live download state. */
export async function localJobStatus(jobId) {
  const jobs = await readJobs();
  const job = jobs.find((j) => j.id === jobId) || jobs[0];
  if (!job) return null;

  const counts = { complete: 0, running: 0, interrupted: 0, skipped: 0, error: 0, queued: 0 };
  let bytes = 0;
  let total = 0;
  const files = [];

  for (const entry of job.entries) {
    if (entry.state === "queued") {
      counts.queued += 1;
      files.push({ path: entry.path, state: "queued" });
      continue;
    }
    if (entry.state === "skipped") {
      counts.skipped += 1;
      files.push({ path: entry.path, state: "skipped", reason: entry.reason });
      continue;
    }
    if (entry.state === "error") {
      counts.error += 1;
      files.push({ path: entry.path, state: "error", reason: entry.reason });
      continue;
    }
    if (entry.state === "complete" && !entry.downloadId) {
      // written straight to disk by the helper (e.g. a converted .srt caption)
      counts.complete += 1;
      files.push({ path: entry.path, state: "complete", received: 0, total: 0 });
      continue;
    }
    const [live] = await chrome.downloads.search({ id: entry.downloadId });
    if (!live) {
      counts.error += 1;
      files.push({ path: entry.path, state: "error", reason: "download record gone" });
      continue;
    }
    if (live.state === "complete") counts.complete += 1;
    else if (live.state === "interrupted") counts.interrupted += 1;
    else counts.running += 1;

    const received = live.bytesReceived || 0;
    const size = live.totalBytes || 0;
    bytes += received;
    total += size;
    files.push({
      path: entry.path,
      state: live.state,
      received,
      total: size,
      reason: live.error || null,
    });
  }

  const done = counts.running === 0 && counts.queued === 0;
  return { ...job, counts, bytes, total, files, status: done ? "done" : "running" };
}

export async function listLocalJobs() {
  return readJobs();
}

export async function cancelLocalJob(jobId) {
  const jobs = await readJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return 0;
  let cancelled = 0;
  for (const entry of job.entries) {
    if (!entry.downloadId) continue;
    const [live] = await chrome.downloads.search({ id: entry.downloadId });
    if (live && live.state === "in_progress") {
      await chrome.downloads.cancel(entry.downloadId);
      cancelled += 1;
    }
  }
  return cancelled;
}

/** Cancel one file's transfer without touching the rest of the job. */
export async function cancelLocalFile(jobId, path) {
  const jobs = await readJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return false;
  const entry = job.entries.find((e) => e.path === path);
  if (!entry || !entry.downloadId) return false;

  const [live] = await chrome.downloads.search({ id: entry.downloadId });
  if (live && live.state === "in_progress") {
    await chrome.downloads.cancel(entry.downloadId);
    return true;
  }
  return false;
}

/**
 * Hand the finished course to the native helper so it can land outside the
 * browser download folder. The absolute download root is only knowable from a
 * real DownloadItem, so it is derived by stripping the known relative path.
 */
export async function relocateFinishedJob(jobId, target) {
  const jobs = await readJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job || job.relocated || !target) return null;

  const done = job.entries.find((e) => e.downloadId && e.state !== "skipped");
  if (!done) return null;
  const [live] = await chrome.downloads.search({ id: done.downloadId });
  if (!live || !live.filename) return null;

  const rel = done.path.replace(/\//g, "\\");
  const abs = live.filename;
  if (!abs.toLowerCase().endsWith(rel.toLowerCase())) return null;
  const root = abs.slice(0, abs.length - rel.length);

  const from = root + (job.destSub ? job.destSub + "\\" : "") + job.courseTitle;
  const to = target.replace(/[\/]+$/, "") + "\\" + job.courseTitle;

  const res = await nativeMove(from, to);
  job.relocated = to;
  job.movedFiles = res.moved;
  await writeJobs(jobs);
  // files were moved off the download folder — clear their browser history rows
  for (const e of job.entries) {
    if (e.downloadId) { try { await chrome.downloads.erase({ id: e.downloadId }); } catch { /* gone */ } }
  }
  return res;
}

export async function removeLocalJob(jobId) {
  const jobs = await readJobs();
  await writeJobs(jobs.filter((j) => j.id !== jobId));
}
