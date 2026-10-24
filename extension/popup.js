import {
  api, DEST_KEY, findCourseTabs, getBearer, getSettings, parseCourseUrl,
  PREFS_KEY, setSettings, shortToken,
} from "./common.js";
import {
  cancelLocalFile, cancelLocalJob, listLocalJobs, localJobStatus, removeLocalJob,
} from "./local-runner.js";
import {
  cancelHdJob, hdJobStatus, listHdJobs, removeHdJob, skipHdEntry,
} from "./hd-runner.js";
import {
  nativeAvailable, nativeDrives, nativeList, nativeMkdir,
} from "./native.js";

const BOOLS = [
  "download_captions", "download_assets", "download_quizzes", "skip_lectures",
  "keep_vtt", "skip_hls", "hd", "send_cookies", "subscription_course",
  "id_as_course_name", "continue_lecture_numbers", "save_to_file",
  "load_from_file", "use_h265", "use_nvenc", "skip_existing",
];
const VALUES = ["quality", "concurrent", "chapter", "lang", "h265_crf", "h265_preset", "log_level", "hd_lanes"];

const $ = (id) => document.getElementById(id);
const state = {
  bearer: null,
  host: "www.udemy.com",
  selected: null,
  cursor: 0,
  detailBusy: false,
  gpu: null,
  library: null,
  dest: "",
  browsePath: "",
  fsFolder: null,
  nativeOk: false,
  nativeTarget: "",
};

// x265 and nvenc take disjoint preset vocabularies; sending one to the other
// makes ffmpeg abort and the mux fails. "medium" is valid in both.
const X265_PRESETS = [
  "ultrafast", "superfast", "veryfast", "faster", "fast",
  "medium", "slow", "slower", "veryslow",
];
const NVENC_PRESETS = [
  "p1", "p2", "p3", "p4", "p5", "p6", "p7",
  "fast", "medium", "slow", "hq", "ll",
];

function applyEncoderOptions(desired) {
  const nvenc = $("use_nvenc").checked;
  const sel = $("h265_preset");
  const list = nvenc ? NVENC_PRESETS : X265_PRESETS;
  // prefer an explicitly restored value, else whatever is selected, else medium
  const keep = [desired, sel.value].find((v) => v && list.includes(v)) || "medium";
  sel.textContent = "";
  for (const name of list) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === keep) opt.selected = true;
    sel.append(opt);
  }
  // nvenc's constant-quality knob is -cq, not -crf
  $("crfLabel").textContent = nvenc ? "Quality (CQ)" : "Quality (CRF)";
}

function setBanner(message, kind) {
  const el = $("banner");
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.className = kind === "info" ? "banner info" : "banner";
}

async function savePrefs() {
  const prefs = {};
  for (const id of BOOLS) prefs[id] = $(id).checked;
  for (const id of VALUES) prefs[id] = $(id).value;
  await chrome.storage.local.set({ [PREFS_KEY]: prefs });
}

async function restorePrefs() {
  const stored = await chrome.storage.local.get(PREFS_KEY);
  const prefs = stored[PREFS_KEY];
  if (!prefs) return;
  for (const id of BOOLS) if (id in prefs) $(id).checked = !!prefs[id];
  for (const id of VALUES) if (prefs[id] !== undefined && prefs[id] !== "") $(id).value = prefs[id];
}

function destLabel(rel) {
  return rel ? rel : "library root";
}

function applyDestState() {
  $("destPath").textContent = destLabel(state.dest);

  // Browser mode writes relative to the download folder, so there is nothing
  // to browse -- the picker only makes sense against mounted drives.
  if (state.engine !== "container") {
    $("btnPick").disabled = false;
    {
      if (state.nativeTarget) {
        $("destPath").textContent = state.nativeTarget + "\\<Course>\\";
        $("destSub").hidden = true;
        $("destHint").textContent =
          "Downloaded in the background, then moved here by the local helper.";
        return;
      }
      $("destPath").textContent = `<download folder>/${state.dest || "Courses"}/`;
      $("destSub").hidden = false;
      if ($("destSub").value !== state.dest) $("destSub").value = state.dest;
      $("destHint").textContent = state.nativeOk
        ? "Helper ready — click Change… to send courses anywhere on disk."
        : "Background, no tab. Courses go in this subfolder of Brave's download folder.";
      return;
      $("destHint").textContent =
        "Background, no tab. Courses go in this subfolder of Brave's download " +
        "folder, so other downloads stay where they are.";
    }
    return;
  }

  $("destSub").hidden = true;
  const lib = state.library;
  const ok = lib && lib.mounted && lib.writable;
  $("btnPick").disabled = !ok;
  if (lib && !lib.mounted) {
    $("destHint").textContent = `${lib.path} is not mounted — falling back to the repo's output/ folder.`;
  } else if (lib && !lib.writable) {
    $("destHint").textContent = `${lib.path} is mounted read-only; downloads will fail.`;
  } else {
    $("destHint").textContent =
      "Creates <Course>/01 - Section/001 Lecture.mp4 inside this folder.";
  }
}

const mb = (n) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;

/** Render per-file rows with a progress bar. Used by both browser modes. */
function renderFiles(files, ctx = {}) {
  const box = $("fileList");
  box.textContent = "";
  box.hidden = false;
  $("jobLog").hidden = true;

  for (const file of files.slice(0, 200)) {
    const row = document.createElement("div");
    row.className = `file-row ${file.state}`;

    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = file.path.split("/").pop();
    name.title = file.path + (file.reason ? `\n${file.reason}` : "");

    const meta = document.createElement("span");
    meta.className = "file-meta";
    let pct = 0;
    if (file.state === "skipped") {
      meta.textContent =
        file.reason === "drm" ? "DRM" : file.reason === "hls-only" ? "HLS only" : file.reason || "skipped";
    } else if (file.state === "error") {
      meta.textContent = "failed";
    } else if (file.segTotal) {
      // HD mode has no Content-Length ahead of time; segments are the measure
      pct = Math.min(100, Math.round((100 * file.segDone) / file.segTotal));
      meta.textContent = `seg ${file.segDone}/${file.segTotal} · ${mb(file.received)}`;
    } else if (file.total) {
      pct = Math.min(100, Math.round((100 * file.received) / file.total));
      meta.textContent = `${mb(file.received)} / ${mb(file.total)} · ${pct}%`;
      if (file.state === "complete") pct = 100;
    } else if (file.state === "complete") {
      pct = 100;
      meta.textContent = file.received ? mb(file.received) : "done";
    } else {
      meta.textContent = file.received ? mb(file.received) : "waiting";
    }

    const track = document.createElement("div");
    track.className = "file-track";
    const fill = document.createElement("div");
    fill.className = "file-fill";
    fill.style.width = `${pct}%`;
    track.append(fill);

    row.append(name, meta, track);

    // per-file skip: only meaningful while it is still unfinished
    const stoppable =
      ctx.jobId && !["complete", "skipped", "cancelled"].includes(file.state);
    if (stoppable) {
      const skip = document.createElement("button");
      skip.className = "file-skip";
      skip.textContent = "×";
      skip.title = "Skip this file";
      skip.setAttribute("aria-label", `Skip ${file.path}`);
      skip.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          if (ctx.mode === "local-hd") await skipHdEntry(ctx.jobId, file.index);
          else await cancelLocalFile(ctx.jobId, file.path);
          await refreshDetail();
        } catch (err) {
          setBanner(err.message);
        }
      });
      meta.append(" ");
      meta.append(skip);
    }

    box.append(row);
  }
}

/** Drop a saved destination that no longer resolves (e.g. after a remount). */
async function validateDest() {
  if (!state.dest) return;
  try {
    await api(`/api/browse?path=${encodeURIComponent(state.dest)}`);
  } catch {
    state.dest = "";
    await chrome.storage.local.set({ [DEST_KEY]: "" });
    applyDestState();
    setBanner("Your saved destination no longer exists — pick it again under Save to.", "info");
  }
}

/** Folder browser backed by the native helper: real absolute paths, any drive. */
async function browseNative(path) {
  try {
    let data;
    if (!path) {
      const res = await nativeDrives();
      data = {
        path: "",
        parent: null,
        dirs: res.drives.map((d) => d.path),
        writable: false,
        absolute: true,
      };
    } else {
      const res = await nativeList(path);
      data = { ...res, absolute: true };
    }
    state.browsePath = data.path;

    $("pickerPath").textContent = data.path || "This PC";
    const list = $("pickerList");
    list.textContent = "";

    if (data.parent !== null && data.path) {
      const up = document.createElement("li");
      up.className = "dir-up";
      up.textContent = "⬆  ..";
      up.addEventListener("click", () => browseNative(data.parent || ""));
      list.append(up);
    }
    if (!data.dirs.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No subfolders here.";
      list.append(li);
    }
    for (const name of data.dirs) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.className = "slug";
      label.textContent = `📁  ${name}`;
      li.append(label);
      const child = data.path
        ? data.path.replace(/[\/]+$/, "") + "\\" + name
        : name;
      li.addEventListener("click", () => browseNative(child));
      list.append(li);
    }
    $("btnUseFolder").disabled = !data.path;
    $("btnUseFolder").textContent = data.path ? "Use this folder" : "Open a drive first";
  } catch (err) {
    setBanner(err.message);
  }
}

async function browseTo(path) {
  try {
    const data = await api(`/api/browse?path=${encodeURIComponent(path || "")}`);
    state.browsePath = data.path;
    renderPicker(data);
  } catch (err) {
    setBanner(err.message);
  }
}

function renderPicker(data) {
  $("pickerPath").textContent = `/${data.path || ""}${data.writable ? "" : "  (read-only)"}`;
  const list = $("pickerList");
  list.textContent = "";

  if (data.path) {
    const up = document.createElement("li");
    up.className = "dir-up";
    up.textContent = "⬆  ..";
    up.addEventListener("click", () => browseTo(data.parent));
    list.append(up);
  }
  if (!data.dirs.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No subfolders here.";
    list.append(li);
  }
  for (const name of data.dirs) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "slug";
    label.textContent = `📁  ${name}`;
    li.append(label);
    li.addEventListener("click", () =>
      browseTo(data.path ? `${data.path}/${name}` : name)
    );
    list.append(li);
  }
  // the root only holds the per-drive mounts; a course written there would
  // land inside the container and vanish on restart
  const atRoot = !data.path;
  $("btnUseFolder").disabled = !data.writable || atRoot;
  $("btnUseFolder").textContent = atRoot ? "Open a drive first" : "Use this folder";
}

async function createFolder() {
  const name = $("newFolderName").value.trim();
  if (!name) return;
  try {
    if (state.engine !== "container") {
      const target = state.browsePath.replace(/[\/]+$/, "") + "\\" + name;
      await nativeMkdir(target);
      $("newFolderName").value = "";
      await browseNative(target);
      return;
    }
    const res = await api("/api/folders", {
      method: "POST",
      body: { path: state.browsePath, name },
    });
    $("newFolderName").value = "";
    await browseTo(res.path);
  } catch (err) {
    setBanner(err.message);
  }
}

async function checkHealth() {
  const pill = $("health");
  try {
    const h = await api("/api/health");
    state.gpu = h.gpu || null;
    state.library = h.library || null;
    applyGpuState();
    applyDestState();
    const missing = Object.entries(h.tools || {}).filter(([, ok]) => !ok).map(([n]) => n);
    if (missing.length) {
      pill.textContent = "tools missing";
      pill.className = "pill pill-bad";
      setBanner(`Container is up but missing: ${missing.join(", ")}`);
      return h;
    }
    // /api/health is deliberately unauthenticated, so reaching it proves
    // nothing about the token. Check explicitly or the pill reads "ok" while
    // every real call 401s.
    const { apiToken } = await getSettings();
    if (h.auth_required && !apiToken) {
      pill.textContent = "no token";
      pill.className = "pill pill-bad";
      setBanner("Container is reachable but no API token is saved. Open Settings and paste UD_API_TOKEN from the repo's .env.");
      return h;
    }

    pill.textContent = `api ok · ${h.active}/${h.max_jobs} busy`;
    pill.className = "pill pill-ok";
    return h;
  } catch (err) {
    pill.textContent = "offline";
    pill.className = "pill pill-bad";
    state.gpu = null;
    state.library = null;
    applyGpuState();
    applyDestState();
    setBanner(err.message);
    return null;
  }
}

// NVENC is only reachable when the GPU is passed through AND main.py is
// re-encoding (it ignores the codec on a plain remux, see main.py:1317).
function applyGpuState() {
  const box = $("use_nvenc");
  const hint = $("nvencHint");
  const gpu = state.gpu;

  if (!gpu) {
    box.disabled = true;
    box.checked = false;
    hint.textContent = "GPU status unknown — container unreachable.";
    return;
  }
  if (!gpu.nvenc_ready) {
    box.disabled = true;
    box.checked = false;
    hint.textContent = `GPU encode unavailable: ${gpu.detail}`;
    return;
  }
  box.disabled = false;
  hint.textContent = box.checked
    ? `Encoding on ${gpu.name} (driver ${gpu.driver}).`
    : `${gpu.name} ready — turning this on also enables H.265.`;
}

/** Decide and display which engine is in play. Returns health, or null. */
// Hide settings that don't apply to the selected mode (confirmed by audit).
// CONTAINER_ONLY: only the Docker path reads these. BROWSER_ONLY: only the
// in-browser path uses these (the container never gets them).
const CONTAINER_ONLY = [
  "concurrent", "use_h265", "use_nvenc", "h265_crf", "h265_preset",
  "subscription_course", "save_to_file", "load_from_file", "send_cookies", "log_level",
];
const BROWSER_ONLY = ["hd", "hd_lanes", "skip_existing"];
function hostOf(el) { return el.closest("label") || el.parentElement; }
function setVisible(ids, visible) {
  for (const id of ids) {
    const el = $(id);
    if (!el) continue;
    const host = hostOf(el);
    if (host) host.hidden = !visible;
  }
}
function applyModeVisibility(isContainer) {
  setVisible(CONTAINER_ONLY, isContainer);
  setVisible(BROWSER_ONLY, !isContainer);
  // encoder sub-panel + GPU hint only make sense in Docker mode
  const h265 = $("h265opts"); if (h265) h265.hidden = !isContainer || !$("use_h265").checked;
  const nv = $("nvencHint"); if (nv) nv.hidden = !isContainer;
}

async function refreshEngine() {
  const settings = await getSettings();
  const { useContainer, apiBase } = settings;
  state.nativeTarget = settings.nativeTarget || "";
  // Probe the helper WITHOUT blocking: spawning it starts a python process, and
  // awaiting that here froze the popup on "checking..." until it timed out.
  nativeAvailable()
    .then((ok) => {
      state.nativeOk = ok;
      applyDestState();
    })
    .catch(() => {});
  // also non-blocking: the FSA handle only matters to the runner tab, and a
  // slow IndexedDB must not hold up the whole popup
  const btn = $("engineToggle");
  btn.setAttribute("aria-pressed", String(useContainer));
  btn.textContent = useContainer ? "Docker: on" : "Docker: off";

  if (!useContainer) {
    state.engine = "local";
    state.gpu = null;
    state.library = null;
    $("engineState").textContent = "browser only";
    $("engineState").className = "pill";
    $("engineHint").textContent =
      "No setup needed — DRM, 1080p and subtitles all work in the browser. Docker only adds GPU re-encoding.";
    $("health").textContent = "local";
    $("health").className = "pill";
    applyGpuState();
    applyDestState();
    applyModeVisibility(false);
    return null;
  }

  const health = await checkHealth();
  if (health) {
    state.engine = "container";
    $("engineState").textContent = "connected";
    $("engineState").className = "pill pill-ok";
    $("engineHint").textContent = "1080p, DRM with your own keys, and GPU encoding.";
  } else {
    state.engine = "local";
    $("engineState").textContent = "not reachable";
    $("engineState").className = "pill pill-bad";
    $("engineHint").textContent =
      `Nothing answering on ${apiBase} — falling back to browser mode.`;
  }
  applyDestState();
  applyModeVisibility(state.engine === "container");
  return health;
}

async function detectTab() {
  const tabs = await findCourseTabs();
  const wrap = $("tabPickWrap");
  const sel = $("tabPick");
  sel.textContent = "";

  // With more than one course tab open, make the choice explicit rather than
  // silently taking whichever comes first in tab order.
  if (tabs.length > 1) {
    wrap.hidden = false;
    $("tabPickCount").textContent = `${tabs.length} open`;
    for (const tab of tabs) {
      const opt = document.createElement("option");
      opt.value = tab.url;
      opt.textContent = (tab.isActive ? "● " : "") + tab.slug;
      opt.title = tab.title;
      sel.append(opt);
    }
    sel.value = tabs[0].url;
  } else {
    wrap.hidden = true;
  }

  if (tabs.length) {
    $("courseUrl").value = tabs[0].url;
    state.host = tabs[0].host;
  } else if (!$("courseUrl").value) {
    setBanner("Open a Udemy course tab, or paste the course URL above.", "info");
  }

  await refreshAuthLine();
}

async function refreshAuthLine() {
  state.bearer = await getBearer(state.host);
  $("authState").textContent = state.bearer
    ? `Signed in — access_token ${shortToken(state.bearer)}`
    : "No access_token cookie found. Sign in to Udemy in this browser first.";
}

async function submit(infoOnly) {
  setBanner("");
  const courseUrl = $("courseUrl").value.trim();
  if (!parseCourseUrl(courseUrl)) {
    setBanner("That does not look like a Udemy course URL.");
    return;
  }

  $("btnDownload").disabled = true;
  $("btnInfo").disabled = true;
  try {
    // persist first: queueJob reads the saved prefs, which keeps the popup and
    // the in-page button on identical settings
    await savePrefs();
    await chrome.storage.local.set({ [DEST_KEY]: state.dest });
    // the service worker runs the job: a driver started in this popup would
    // die the moment it closes, and the filename guard only exists there
    const res = await chrome.runtime.sendMessage({
      type: "queue-course",
      url: courseUrl,
      infoOnly,
    });
    if (!res) throw new Error("no response from the background worker");
    if (res.error) throw new Error(res.error);
    const job = res.job;
    if (job.mode === "local") {
      const s = job.plan || {};
      if (infoOnly) {
        const h = job.hls;
        let hlsNote = "";
        if (h && h.error) {
          hlsNote = ` HLS probe failed: ${h.error}`;
        } else if (h) {
          hlsNote =
            ` HLS: ${h.bestHeight}p, ${h.segmentKind}` +
            `${h.separateAudio ? ", separate audio" : ", muxed audio"}` +
            `, ${h.segmentCount} segments — ` +
            (h.concatenable ? "1080p LOCAL IS POSSIBLE" : "needs a muxer, container only");
        }
        setBanner(
          `Local: ${s.chapters} chapters, ${s.downloadable} downloadable, ` +
            `${s.drm} DRM-only, progressive max ${s.maxHeight}p.${hlsNote}`,
          "info"
        );
      } else {
        setBanner(
          `Local mode: queued ${job.entries.length} files to your Downloads folder. ` +
            `Progress is in brave://downloads.`,
          "info"
        );
      }
      return;
    }
    state.selected = job.id;
    state.cursor = 0;
    $("jobLog").textContent = "";
    await refreshJobs();
    chrome.runtime.sendMessage({ type: "refresh-badge" }).catch(() => {});
  } catch (err) {
    setBanner(err.message);
  } finally {
    $("btnDownload").disabled = false;
    $("btnInfo").disabled = false;
  }
}

function jobLabel(job) {
  const parsed = parseCourseUrl(job.course_url);
  let label = parsed ? parsed.slug : job.course_url;
  if (job.mode === "local-hd") {
    const done = (job.counts && job.counts.complete) || 0;
    const seg = job.current && job.current.segTotal
      ? ` · seg ${job.current.segDone}/${job.current.segTotal}`
      : "";
    label += ` — 1080p ${done}/${job.total}${seg}`;
  } else if (job.mode === "local") {
    const done = (job.counts && job.counts.complete) || 0;
    label += ` — ${done}/${job.total} ${job.label || "files"}`;
  } else if (job.lecture && job.total_lectures) {
    label += ` — ${job.lecture}/${job.total_lectures}`;
  } else if (job.percent != null && job.status === "running") {
    label += ` — ${job.percent}%`;
  }
  return label;
}

/** Browser-mode jobs live in extension storage; container jobs in the API.
 *  The list shows both so a local job isn't invisible. */
async function collectJobs() {
  const rows = [];

  for (const stub of await listHdJobs()) {
    const live = await hdJobStatus(stub.id);
    if (!live) continue;
    rows.push({
      id: live.id,
      mode: "local-hd",
      course_url: live.courseTitle,
      status: live.status,
      counts: live.counts,
      total: live.total,
      current: live.current,
    });
  }

  for (const stub of await listLocalJobs()) {
    const live = await localJobStatus(stub.id);
    if (!live) continue;
    rows.push({
      id: live.id,
      mode: "local",
      course_url: live.courseTitle,
      status: live.status,
      counts: live.counts,
      total: live.entries.length,
    });
  }

  if (state.engine === "container") {
    try {
      const { jobs = [] } = await api("/api/jobs");
      rows.push(...jobs.map((j) => ({ ...j, mode: "container" })));
    } catch {
      /* container vanished mid-session; local rows still render */
    }
  }
  return rows;
}

const collapsedCourses = new Set(); // courses currently collapsed in the stack
const seenCourses = new Set(); // courses start collapsed (one line per course)
let lastStackSig = null; // skip identical redraws so the list doesn't blink

/** Discard one item (lecture/file), across all three backends. */
async function discardItem(it) {
  try {
    if (it.mode === "drm") await chrome.runtime.sendMessage({ type: "vv:remove", id: it.jobId });
    else if (it.mode === "hd") await skipHdEntry(it.jobId, it.index);
    else if (it.mode === "local") await cancelLocalFile(it.jobId, it.path);
  } catch { /* already gone */ }
  chrome.runtime.sendMessage({ type: "refresh-badge" }).catch(() => {});
  await refreshJobs();
}

/** Discard every job in a course group, across all three backends. */
async function discardCourse(rows) {
  const seen = new Set();
  for (const it of rows) {
    const key = `${it.mode}:${it.jobId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (it.mode === "drm") await chrome.runtime.sendMessage({ type: "vv:remove", id: it.jobId });
      else if (it.mode === "hd") { await cancelHdJob(it.jobId).catch(() => {}); await removeHdJob(it.jobId); }
      else if (it.mode === "local") { await cancelLocalJob(it.jobId).catch(() => {}); await removeLocalJob(it.jobId); }
    } catch { /* already gone */ }
  }
  chrome.runtime.sendMessage({ type: "refresh-badge" }).catch(() => {});
  await refreshJobs();
}

/** Unified per-item download stack (DRM + 1080p + files), grouped by course and
 *  collapsible, mirroring the on-page injector. Fed by the background job-stack. */
async function renderStack() {
  const el = $("stack");
  if (!el) return;
  let items = [];
  try { const res = await chrome.runtime.sendMessage({ type: "job-stack" }); items = (res && res.items) || []; }
  catch { return; }
  const sig = JSON.stringify(items.map((i) => [i.course, i.title, i.status, i.percent]))
    + "|" + [...collapsedCourses].sort().join(",");
  if (sig === lastStackSig) return; // nothing changed -> no redraw -> no blink
  lastStackSig = sig;
  el.textContent = "";
  if (!items.length) return;

  const groups = new Map();
  for (const it of items) { const k = it.course || "Downloads"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
  for (const [course, rows] of groups) {
    if (!seenCourses.has(course)) { seenCourses.add(course); collapsedCourses.add(course); } // default collapsed
    const gDone = rows.filter((i) => i.status === "done").length;
    const gFail = rows.filter((i) => i.status === "failed").length;
    const gPct = Math.round(rows.reduce((a, i) => a + (i.status === "done" ? 100 : (i.percent || 0)), 0) / rows.length);
    const head = document.createElement("div");
    head.className = "ghead" + (collapsedCourses.has(course) ? " collapsed" : "");
    const car = document.createElement("span"); car.className = "gcaret"; car.textContent = "▾";
    const nm = document.createElement("span"); nm.className = "gname"; nm.textContent = course; nm.title = course;
    const ct = document.createElement("span"); ct.className = "gcount"; ct.textContent = `${gDone}/${rows.length}` + (gFail ? ` · ${gFail}✕` : "");
    const del = document.createElement("button");
    del.className = "gdiscard"; del.textContent = "×"; del.title = "Discard this course";
    del.addEventListener("click", (e) => { e.stopPropagation(); discardCourse(rows); });
    head.append(car, nm, ct, del);
    head.addEventListener("click", () => {
      if (collapsedCourses.has(course)) collapsedCourses.delete(course); else collapsedCourses.add(course);
      renderStack();
    });
    el.appendChild(head);
    const gbar = document.createElement("div"); gbar.className = "gbar";
    const gfill = document.createElement("div"); gfill.className = "gbar-fill"; gfill.style.width = `${gPct}%`;
    gbar.appendChild(gfill); el.appendChild(gbar);
    if (collapsedCourses.has(course)) continue;
    for (const it of rows) {
      const row = document.createElement("div");
      row.className = `srow ${it.status} nested`;
      const pct = Math.max(0, Math.min(100, it.percent || 0));
      const t = document.createElement("span"); t.className = "t"; t.textContent = it.title;
      t.title = it.error ? `${it.title}\n${it.error}` : it.title;
      const s = document.createElement("span"); s.className = "s";
      const k = document.createElement("span"); k.className = "k"; k.textContent = it.kind;
      const d = document.createElement("button");
      d.className = "sdiscard"; d.textContent = "×"; d.title = "Discard this file";
      d.addEventListener("click", (e) => { e.stopPropagation(); discardItem(it); });
      s.append(k, document.createTextNode(it.status === "running" ? `${pct}%` : it.status), d);
      const mini = document.createElement("span"); mini.className = "mini";
      const fill = document.createElement("span"); fill.className = "mini-fill";
      fill.style.width = `${it.status === "done" ? 100 : pct}%`;
      mini.appendChild(fill);
      row.append(t, s, mini);
      el.appendChild(row);
    }
  }
}

async function refreshJobs() {
  await renderStack();
  // the unified stack above is now the single job list (DRM + 1080p + files),
  // so the legacy per-mode list and its detail pane stay hidden.
  $("jobs").hidden = true;
  $("jobDetail").hidden = true;
  return;

  // eslint-disable-next-line no-unreachable
  const jobs = await collectJobs();

  const list = $("jobs");
  list.textContent = "";
  if (!jobs.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No jobs yet.";
    list.append(li);
  }
  for (const job of jobs) {
    const li = document.createElement("li");
    if (job.id === state.selected) li.classList.add("selected");
    const slug = document.createElement("span");
    slug.className = "slug";
    slug.textContent = jobLabel(job);
    // the label ellipsizes, so expose the whole thing on hover
    li.title = `${job.course_url}\n${job.status}${job.error ? " — " + job.error : ""}`;
    const st = document.createElement("span");
    st.className = `state ${job.status}`;
    st.textContent = job.status;
    li.append(slug, st);

    // Container jobs own an OS subprocess, so removing one mid-flight would
    // orphan it -- those must be cancelled first. Browser-mode jobs have no
    // such handle, and hiding the x there made a wedged job unremovable.
    if (job.status !== "running" || job.mode !== "container") {
      const kill = document.createElement("button");
      kill.className = "kill";
      kill.textContent = "×";
      kill.title = "Remove from the list";
      kill.setAttribute("aria-label", `Remove job ${job.id}`);
      kill.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          if (job.mode === "local-hd") {
            // stop the worker before forgetting the record, or it would keep
            // fetching segments for a job nobody can see
            await cancelHdJob(job.id);
            await removeHdJob(job.id);
          }
          else if (job.mode === "local") await removeLocalJob(job.id);
          else await api(`/api/jobs/${job.id}`, { method: "DELETE" });
          if (state.selected === job.id) {
            state.selected = null;
            state.cursor = 0;
            $("jobLog").textContent = "";
          }
          await refreshJobs();
        } catch (err) {
          setBanner(err.message);
        }
      });
      li.append(kill);
    }

    li.addEventListener("click", () => {
      state.selected = job.id;
      state.cursor = 0;
      $("jobLog").textContent = "";
      refreshJobs();
    });
    list.append(li);
  }

  if (!state.selected && jobs.length) {
    state.selected = jobs[0].id;
    state.cursor = 0;
  }
  await refreshDetail();
}

async function refreshDetail() {
  const panel = $("jobDetail");
  if (!state.selected) {
    panel.hidden = true;
    return;
  }
  // two timers drive this; overlapping fetches would share a cursor and
  // append the same log lines twice
  if (state.detailBusy) return;
  state.detailBusy = true;

  const jobId = state.selected;

  // HD jobs are driven by the offscreen transmuxer, which reports per-segment
  // progress into storage rather than a log stream.
  if (jobId.startsWith("hd-")) {
    state.detailBusy = false;
    const live = await hdJobStatus(jobId);
    if (!live) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const c = live.counts;
    const cur = live.current;
    const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
    const eta =
      live.status === "running" && live.etaSeconds != null
        ? ` · ~${live.etaSeconds < 90 ? live.etaSeconds + "s" : Math.round(live.etaSeconds / 60) + " min"} left`
        : "";
    const stalled =
      live.stalledFor != null && live.stalledFor > 45
        ? ` · stalled ${live.stalledFor}s`
        : "";
    $("jobStatus").textContent =
      `${live.status} · ${c.complete}/${live.total} done, ${c.error} failed` +
      (live.bytes ? ` · ${mb(live.bytes)}` : "") +
      (cur && cur.segTotal
        ? ` · ${cur.height || "?"}p segment ${cur.segDone}/${cur.segTotal}`
        : "") +
      eta +
      stalled +
      (live.error ? ` · ${live.error}` : "");
    $("btnCancel").hidden = live.status !== "running";
    renderFiles(
      live.entries.map((e, i) => ({
        index: i,
        path: e.path,
        // each lane reports onto its own entry now, so several can be live
        state: e.state === "active" ? "in_progress" : e.state,
        reason: e.reason || e.stage,
        received: e.state === "complete" ? e.bytes || 0 : e.liveBytes || 0,
        total: 0,
        segDone: e.segDone || null,
        segTotal: e.segTotal || null,
      })),
      { jobId, mode: "local-hd" }
    );
    return;
  }

  // Browser-mode jobs have no server-side log: report file counts and point at
  // the browser's own download manager, which actually owns the transfers.
  if (jobId.startsWith("local-")) {
    state.detailBusy = false;
    const live = await localJobStatus(jobId);
    if (!live) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const c = live.counts;
    const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
    $("jobStatus").textContent =
      `${live.status} · ${c.complete} done, ${c.running} running, ` +
      `${c.interrupted} failed, ${c.skipped} DRM-skipped` +
      (live.bytes ? ` · ${mb(live.bytes)}` : "");
    $("btnCancel").hidden = c.running === 0;
    renderFiles(live.files || [], { jobId, mode: "local" });
    return;
  }

  let job;
  try {
    job = await api(`/api/jobs/${jobId}?cursor=${state.cursor}`);
  } catch {
    panel.hidden = true;
    return;
  } finally {
    state.detailBusy = false;
  }
  if (jobId !== state.selected) return; // selection changed mid-flight
  panel.hidden = false;
  // container jobs stream a real log; the file list belongs to browser modes
  $("fileList").hidden = true;
  $("jobLog").hidden = false;
  state.cursor = job.cursor;

  const bits = [job.status];
  if (job.lecture && job.total_lectures) bits.push(`lecture ${job.lecture}/${job.total_lectures}`);
  if (job.current) bits.push(job.current.slice(0, 60));
  if (job.error) bits.push(job.error);
  $("jobStatus").textContent = bits.join(" · ");
  $("btnCancel").hidden = !(job.status === "running" || job.status === "queued");

  if (job.log && job.log.length) {
    const log = $("jobLog");
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.textContent += `${job.log.join("\n")}\n`;
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
}

async function cancelSelected() {
  if (!state.selected) return;
  try {
    if (state.selected.startsWith("hd-")) {
      await cancelHdJob();
      setBanner("Cancelling after the current segment…", "info");
      await refreshJobs();
      return;
    }
    if (state.selected.startsWith("local-")) {
      const n = await cancelLocalJob(state.selected);
      setBanner(`Cancelled ${n} in-progress download(s).`, "info");
      await refreshJobs();
      return;
    }
    await api(`/api/jobs/${state.selected}/cancel`, { method: "POST" });
  } catch (err) {
    setBanner(err.message);
  }
}

function wire() {
  $("btnDownload").addEventListener("click", () => submit(false));
  $("btnInfo").addEventListener("click", () => submit(true));
  $("btnCancel").addEventListener("click", cancelSelected);
  $("openOptions").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  $("openPlayer").addEventListener("click", async (e) => {
    e.preventDefault();
    await chrome.tabs.create({ url: chrome.runtime.getURL("player.html") });
    window.close();
  });
  $("engineToggle").addEventListener("click", async () => {
    const { useContainer } = await getSettings();
    await setSettings({ useContainer: !useContainer });
    setBanner("");
    const health = await refreshEngine();
    if (health) await validateDest();
    await refreshJobs();
  });
  $("destSub").addEventListener("change", async () => {
    state.dest = $("destSub").value.trim().replace(/^[\/]+|[\/]+$/g, "");
    await chrome.storage.local.set({ [DEST_KEY]: state.dest });
    applyDestState();
  });
  $("clearJobs").addEventListener("click", async (e) => {
    e.preventDefault();
    let removed = 0;
    try { await chrome.runtime.sendMessage({ type: "vv:clear" }); } catch { /* engine idle */ }
    try {
      for (const stub of await listHdJobs()) {
        const j = await hdJobStatus(stub.id);
        if (j && (j.status === "done" || j.status === "cancelled")) { await removeHdJob(stub.id); removed += 1; }
      }
    } catch { /* none */ }
    try {
      for (const stub of await listLocalJobs()) {
        const j = await localJobStatus(stub.id);
        if (j && j.status === "done") { await removeLocalJob(stub.id); removed += 1; }
      }
    } catch { /* none */ }
    try { const res = await api("/api/jobs/clear", { method: "POST" }); removed += res.removed || 0; } catch { /* container off */ }
    state.selected = null;
    state.cursor = 0;
    $("jobLog").textContent = "";
    await refreshJobs();
    chrome.runtime.sendMessage({ type: "refresh-badge" }).catch(() => {});
    setBanner("Cleared finished downloads.", "info");
  });
  $("tabPick").addEventListener("change", async (e) => {
    $("courseUrl").value = e.target.value;
    const parsed = parseCourseUrl(e.target.value);
    if (parsed) state.host = parsed.host;
    await refreshAuthLine();
  });
  $("btnPick").addEventListener("click", async () => {
    $("picker").hidden = false;
    if (state.engine !== "container") {
      if (!state.nativeOk) {
        setBanner(
          "Helper not reachable. Run native\install.ps1, then restart Brave.",
        );
        return;
      }
      await browseNative(state.nativeTarget || "");
      return;
    }
    await browseTo(state.dest);
  });
  $("pickerClose").addEventListener("click", () => {
    $("picker").hidden = true;
  });
  $("btnNewFolder").addEventListener("click", createFolder);
  $("newFolderName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") createFolder();
  });
  $("btnUseFolder").addEventListener("click", async () => {
    if (state.engine !== "container") {
      state.nativeTarget = state.browsePath;
      await setSettings({ nativeTarget: state.nativeTarget });
      $("picker").hidden = true;
      applyDestState();
      return;
    }
    state.dest = state.browsePath;
    await chrome.storage.local.set({ [DEST_KEY]: state.dest });
    $("picker").hidden = true;
    applyDestState();
  });
  $("use_h265").addEventListener("change", (e) => {
    $("h265opts").hidden = !e.target.checked;
    if (e.target.checked) {
      // no reason to burn CPU on libx265 when the GPU can do it
      if (state.gpu && state.gpu.nvenc_ready) $("use_nvenc").checked = true;
    } else {
      // GPU encode is meaningless without a re-encode
      $("use_nvenc").checked = false;
    }
    applyEncoderOptions();
    applyGpuState();
  });
  $("use_nvenc").addEventListener("change", (e) => {
    if (e.target.checked) {
      $("use_h265").checked = true;
      $("h265opts").hidden = false;
    }
    applyEncoderOptions();
    applyGpuState();
  });
  for (const id of [...BOOLS, ...VALUES]) {
    $(id).addEventListener("change", savePrefs);
  }
}

(async function init() {
  try {
    // Each await is announced in the pill first, so if startup stalls the
    // visible text names the exact step rather than sitting on "checking...".
    const step = (name) => {
      const pill = document.getElementById("health");
      if (pill) pill.textContent = name;
    };
    const guard = setTimeout(() => {
      const banner = document.getElementById("banner");
      if (banner && banner.hidden) {
        banner.hidden = false;
        banner.className = "banner";
        banner.textContent =
          "Startup is stuck — the status pill shows which step. Reload the extension if it persists.";
      }
    }, 8000);

    step("wiring");
    wire();
    step("prefs");
    await restorePrefs();
    const stored = await chrome.storage.local.get([PREFS_KEY, DEST_KEY]);
    applyEncoderOptions((stored[PREFS_KEY] || {}).h265_preset);
    state.dest = stored[DEST_KEY] || "";
    applyDestState();
    $("h265opts").hidden = !$("use_h265").checked;

    step("tabs");
    await detectTab();
    step("engine");
    const health = await refreshEngine();
    if (health) {
      step("dest");
      await validateDest();
    }
    step("jobs");
    await refreshJobs();
    clearTimeout(guard);

    setInterval(refreshDetail, 1200);
    setInterval(refreshJobs, 4000);
  } catch (err) {
    // A throw anywhere above used to leave the UI stuck on "checking…"
    // with no clue why. Always say what happened.
    const pill = document.getElementById("health");
    if (pill) { pill.textContent = "popup error"; pill.className = "pill pill-bad"; }
    const banner = document.getElementById("banner");
    if (banner) {
      banner.hidden = false;
      banner.className = "banner";
      banner.textContent = `Popup failed to start: ${err && err.message ? err.message : err}`;
    }
    console.error("popup init failed", err);
  }
})();
