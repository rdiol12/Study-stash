import { api, getSettings, queueAuto } from "./common.js";
import { installNameGuard } from "./name-guard.js";

// exactly one listener is allowed across ALL extension contexts, and download
// drivers now run only here -- so the guard lives only here
installNameGuard();
import {
  applyProgress, hdJobStatus, listHdJobs, relocateFinishedHdJob, resumeHdJobs,
  watchdogHdJobs,
} from "./hd-runner.js";
import {
  listLocalJobs, localJobStatus, pumpLocalJob, relocateFinishedJob,
} from "./local-runner.js";

/** The player needs an absolute folder to build file:// URLs from. */
async function setCourseRoot(courseTitle, root) {
  if (!courseTitle || !root) return;
  const stored = await chrome.storage.local.get("courses");
  const courses = stored.courses || {};
  if (!courses[courseTitle] || courses[courseTitle].root === root) return;
  courses[courseTitle].root = root;
  await chrome.storage.local.set({ courses });
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
    // finished HD course: hand it to the helper, same as plain jobs
    if (job.status === "done" && !job.relocated && job.counts.complete) {
      const { nativeTarget } = await getSettings();
      if (nativeTarget) {
        relocateFinishedHdJob(job.id, nativeTarget)
          .then((res) => {
            if (res) {
              setCourseRoot(job.courseTitle, res.to);
              chrome.notifications.create({
                type: "basic",
                iconUrl: chrome.runtime.getURL("icons/icon128.png"),
                title: "Course moved",
                message: `${res.moved} file(s) -> ${res.to}`,
              });
            }
          })
          .catch((err) => console.warn("hd relocate failed:", err.message));
      } else {
        // course stays under the download folder; record it for the player
        const done = job.entries.find((e) => e.state === "complete" && e.abs);
        if (done) {
          const rel = done.path.replace(/\//g, "\\");
          if (done.abs && done.abs.toLowerCase().endsWith(rel.toLowerCase())) {
            const root = done.abs.slice(0, done.abs.length - rel.length);
            const parts = done.path.split("/");
            setCourseRoot(job.courseTitle, root + parts[0] + "\\" + parts[1]);
          }
        }
      }
    }

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
    // finished and not yet moved? hand it to the helper
    if (job.status === "done" && !job.relocated && job.counts.complete) {
      const { nativeTarget } = await getSettings();
      if (nativeTarget) {
        relocateFinishedJob(job.id, nativeTarget)
          .then((res) => {
            if (res) {
              setCourseRoot(job.courseTitle, res.to);
              chrome.notifications.create({
                type: "basic",
                iconUrl: chrome.runtime.getURL("icons/icon128.png"),
                title: "Course moved",
                message: `${res.moved} file(s) -> ${res.to}`,
              });
            }
          })
          .catch((err) => console.warn("relocate failed:", err.message));
      } else {
        // no helper: the course stays under the download folder, and only a
        // real DownloadItem knows that folder's absolute path
        deriveCourseRoot(job).catch(() => {});
      }
    }
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

function schedule() {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
}

function wake() {
  schedule();
  // the offscreen worker dies with the extension; revive any unfinished job
  resumeHdJobs().catch(() => {});
}

chrome.runtime.onInstalled.addListener(wake);
chrome.runtime.onStartup.addListener(wake);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) refreshBadge();
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === "refresh-badge") {
    refreshBadge().then(() => reply({ ok: true }));
    return true;
  }
  // pushed by the offscreen worker, which has no chrome.storage of its own
  if (msg && msg.type === "hls-progress") {
    applyProgress(msg).catch(() => {});
    return false;
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
  if (msg && msg.type === "queue-course") {
    // the in-page button routes through here so the API token never has to
    // exist in the page's context
    queueAuto({ courseUrl: msg.url, infoOnly: !!msg.infoOnly })
      .then((job) => {
        refreshBadge();
        reply({ job });
      })
      .catch((err) => reply({ error: err.message || String(err) }));
    return true;
  }
  return false;
});

async function refreshBadge() {
  try {
    const { jobs = [] } = await api("/api/jobs");
    const active = jobs.filter((j) => j.status === "running" || j.status === "queued").length;
    const failed = jobs.some((j) => j.status === "failed");
    await chrome.action.setBadgeText({ text: active ? String(active) : failed ? "!" : "" });
    await chrome.action.setBadgeBackgroundColor({ color: active ? "#2563eb" : "#b91c1c" });
  } catch {
    await chrome.action.setBadgeText({ text: "" });
  }
}
