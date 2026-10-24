// Course library + player. Mimics Udemy's layout: curriculum sidebar with
// collapsible sections, a tick per watched lecture, resume at the saved
// position, and per-video reset by unticking.
//
// Videos play over file:// built from the course's absolute root, which the
// background worker derives when a download completes. That requires the
// "Allow access to file URLs" toggle on brave://extensions — checked at
// runtime with a real fetch, not assumed.

const COURSES_KEY = "courses";
const PROGRESS_KEY = "playerProgress";
const SETTINGS_KEY = "playerSettings"; // speed/volume, persisted across videos + reloads
const DONE_AT = 0.95; // Udemy ticks a lecture near the end, not only at 100%

const $ = (id) => document.getElementById(id);
const video = $("video");

const state = {
  courses: {},
  progress: {},
  settings: { speed: 1, volume: 1 },
  courseId: null,
  playing: null, // rel of the current item
  saveTimer: null,
};

// ---------------------------------------------------------------- storage

async function load() {
  const stored = await chrome.storage.local.get([COURSES_KEY, PROGRESS_KEY, SETTINGS_KEY]);
  state.courses = stored[COURSES_KEY] || {};
  state.progress = stored[PROGRESS_KEY] || {};
  state.settings = { speed: 1, volume: 1, ...(stored[SETTINGS_KEY] || {}) };
}

async function saveProgress() {
  await chrome.storage.local.set({ [PROGRESS_KEY]: state.progress });
}

async function saveSettings() {
  await chrome.storage.local.set({ [SETTINGS_KEY]: state.settings });
}

function prog(courseId) {
  if (!state.progress[courseId]) state.progress[courseId] = { last: null, items: {} };
  return state.progress[courseId];
}

function itemProg(courseId, rel) {
  const p = prog(courseId);
  if (!p.items[rel]) p.items[rel] = { t: 0, d: 0, done: false };
  return p.items[rel];
}

// ---------------------------------------------------------------- helpers

function fileUrl(root, rel) {
  const full = `${root.replace(/[\\/]+$/, "")}/${rel}`.replace(/\\/g, "/");
  const parts = full.replace(/^\/+/, "").split("/");
  return (
    "file:///" +
    parts
      // the drive letter must stay "A:", not "A%3A" — file URLs reject the latter
      .map((p, i) => (i === 0 && /^[A-Za-z]:$/.test(p) ? p : encodeURIComponent(p)))
      .join("/")
  );
}

function flatVideos(course) {
  // DRM lectures are decrypted to plain .mp4 at the same path, so they count
  // and play like any other video.
  return course.sections.flatMap((s) => s.items).filter((i) => i.kind === "video");
}

function courseStats(course) {
  const vids = flatVideos(course);
  const p = state.progress[course.id];
  const done = vids.filter((v) => p && p.items[v.rel] && p.items[v.rel].done).length;
  return { total: vids.length, done, pct: vids.length ? Math.round((100 * done) / vids.length) : 0 };
}

function fmt(sec) {
  if (!sec || !isFinite(sec)) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- library

function renderLibrary() {
  $("library").classList.remove("hiddenEl");
  $("course").classList.remove("active");
  $("back").classList.add("hiddenEl");
  $("title").textContent = "My courses";
  video.pause();

  const cards = $("cards");
  cards.textContent = "";
  const list = Object.values(state.courses).sort((a, b) => b.savedAt - a.savedAt);

  if (!list.length) {
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "Nothing downloaded yet. Download a course from the extension popup first.";
    cards.append(div);
    return;
  }

  for (const course of list) {
    const stats = courseStats(course);
    const card = document.createElement("div");
    card.className = "card";

    // thumbnail: a real frame from the first lecture once generated, like
    // Udemy's course image; initials as the placeholder until then
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.dataset.course = course.id;
    if (course.thumb) {
      const img = document.createElement("img");
      img.src = course.thumb;
      img.alt = "";
      thumb.append(img);
    } else {
      thumb.textContent = course.title
        .split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();
    }
    card.append(thumb);

    const body = document.createElement("div");
    body.className = "body";
    card.append(body);

    const h = document.createElement("h2");
    h.textContent = course.title;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${course.sections.length} sections · ${stats.total} lectures`;
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("div");
    fill.style.width = `${stats.pct}%`;
    bar.append(fill);
    const pct = document.createElement("div");
    pct.className = "pct";
    const last = state.progress[course.id] && state.progress[course.id].last;
    pct.textContent = stats.pct
      ? `${stats.pct}% complete${last ? " · continues where you stopped" : ""}`
      : "Start course";
    body.append(h, meta, bar, pct);

    if (!course.root) {
      const warn = document.createElement("div");
      warn.className = "warn";
      warn.textContent = "Folder not located yet — finishes after the first completed download.";
      body.append(warn);
    }

    card.addEventListener("click", () => openCourse(course.id));
    cards.append(card);
  }

  generateThumbs(list);
}

/**
 * Capture one frame per course from its first lecture and cache it as a JPEG
 * data URL. Sequential on purpose: decoding several videos at once is the kind
 * of memory spike that gets a tab killed.
 */
let thumbsBusy = false;
async function generateThumbs(list) {
  if (thumbsBusy) return;
  thumbsBusy = true;
  try {
    for (const course of list) {
      if (course.thumb || !course.root) continue;
      const first = flatVideos(course)[0];
      if (!first) continue;
      const dataUrl = await captureFrame(fileUrl(course.root, first.rel)).catch(() => null);
      if (!dataUrl) continue;

      const stored = await chrome.storage.local.get(COURSES_KEY);
      const courses = stored[COURSES_KEY] || {};
      if (!courses[course.id]) continue;
      courses[course.id].thumb = dataUrl;
      await chrome.storage.local.set({ [COURSES_KEY]: courses });
      state.courses = courses;

      const slot = document.querySelector(`.thumb[data-course="${CSS.escape(course.id)}"]`);
      if (slot) {
        slot.textContent = "";
        const img = document.createElement("img");
        img.src = dataUrl;
        slot.append(img);
      }
    }
  } finally {
    thumbsBusy = false;
  }
}

async function captureFrame(src) {
  // Drawing a file:// video taints the canvas and toDataURL throws. Fetching
  // it into a blob: URL first keeps the frame same-origin and exportable.
  const res = await fetch(src);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blobUrl = URL.createObjectURL(await res.blob());
  try {
    return await captureFromBlob(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function captureFromBlob(src) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.src = src;
    const fail = (why) => {
      v.removeAttribute("src");
      reject(new Error(why));
    };
    const timer = setTimeout(() => fail("thumbnail timed out"), 15000);
    v.addEventListener("error", () => { clearTimeout(timer); fail("video error"); });
    v.addEventListener("loadedmetadata", () => {
      // a few seconds in beats frame 0, which is usually a black fade-in
      v.currentTime = Math.min(5, (v.duration || 10) * 0.1);
    });
    v.addEventListener("seeked", () => {
      clearTimeout(timer);
      const c = document.createElement("canvas");
      c.width = 480;
      c.height = Math.round(480 * (v.videoHeight / v.videoWidth)) || 270;
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      const url = c.toDataURL("image/jpeg", 0.72);
      v.removeAttribute("src");
      resolve(url);
    }, { once: true });
  });
}

// ---------------------------------------------------------------- course view

// Per-section collapse state the user set (by section title), kept across
// re-renders. Cleared when a different course is opened.
const sectionOpen = new Map();

async function openCourse(courseId) {
  const course = state.courses[courseId];
  if (!course) return;
  if (state.courseId !== courseId) sectionOpen.clear();
  state.courseId = courseId;

  $("library").classList.add("hiddenEl");
  $("course").classList.add("active");
  $("back").classList.remove("hiddenEl");
  $("title").textContent = course.title;

  await checkFileAccess(course);
  renderSections();

  // resume exactly where the student stopped, like Udemy's "continue"
  const p = prog(courseId);
  const target = p.last || (flatVideos(course)[0] || {}).rel;
  if (target) play(target, { resume: true });
}

async function checkFileAccess(course) {
  const warn = $("fileAccessWarn");
  if (!course.root) {
    warn.classList.remove("hiddenEl");
    warn.textContent =
      "This course's folder isn't known yet. It is recorded automatically when a download completes.";
    return;
  }
  const probe = flatVideos(course)[0];
  if (!probe) return;
  const url = fileUrl(course.root, probe.rel);
  try {
    // GET, not HEAD: Chromium's file:// handler rejects HEAD outright, which
    // made this probe fail even with file access granted. Abort right after
    // the headers so the video body is never actually read.
    const controller = new AbortController();
    const res = await fetch(url, { signal: controller.signal });
    const ok = res.ok;
    controller.abort();
    if (!ok) throw new Error(`HTTP ${res.status}`);
    warn.classList.add("hiddenEl");
  } catch (err) {
    if (err.name === "AbortError") {
      // aborted after good headers — that IS success
      warn.classList.add("hiddenEl");
      return;
    }
    warn.classList.remove("hiddenEl");
    warn.textContent =
      "Can't read the course files.\n" +
      `Tried: ${url}\n` +
      "If that path is wrong, the course may have been moved — re-download or fix the folder. " +
      "If the path is right, enable “Allow access to file URLs” on brave://extensions and reload.";
  }
}

// Read a local file's duration without playing it (metadata only).
function probeDuration(url) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    const finish = (d) => { try { v.removeAttribute("src"); v.load(); } catch {} resolve(d); };
    v.addEventListener("loadedmetadata", () => finish(isFinite(v.duration) ? v.duration : null), { once: true });
    v.addEventListener("error", () => finish(null), { once: true });
    v.src = url;
  });
}

// Fill in unknown durations from the files on disk, a few at a time, and update
// the rows in place. Cached in progress, so it only probes once per video.
async function probeDurations(course, pending) {
  if (!course.root || !pending.length) return;
  let i = 0, changed = false;
  const worker = async () => {
    while (i < pending.length) {
      const { rel, sub } = pending[i++];
      const d = await probeDuration(fileUrl(course.root, rel));
      if (!d) continue;
      const ip = itemProg(course.id, rel);
      if (!ip.d) { ip.d = d; changed = true; }
      sub.textContent = fmt(d);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (changed) await saveProgress();
}

function renderSections() {
  const course = state.courses[state.courseId];
  const wrap = $("sections");
  wrap.textContent = "";
  const durPending = [];

  course.sections.forEach((section, si) => {
    const det = document.createElement("details");
    det.className = "section";
    const key = section.title;
    const containsPlaying = section.items.some((i) => i.rel === state.playing);
    // remember the user's collapse choice across re-renders; default the first
    // section (and whichever holds the playing video) open on first sight.
    if (!sectionOpen.has(key)) sectionOpen.set(key, si === 0 || containsPlaying);
    if (containsPlaying) sectionOpen.set(key, true); // always reveal what's playing
    det.open = sectionOpen.get(key);
    det.addEventListener("toggle", () => sectionOpen.set(key, det.open));

    const sum = document.createElement("summary");
    const name = document.createElement("span");
    name.textContent = section.title;
    const vids = section.items.filter((i) => i.kind === "video");
    const doneCount = vids.filter((v) => itemProg(course.id, v.rel).done).length;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = `${doneCount}/${vids.length}`;
    sum.append(name, count);
    det.append(sum);

    for (const item of section.items) {
      const row = document.createElement("div");
      const ip = itemProg(course.id, item.rel);
      row.className = "item" + (ip.done ? " done" : "") +
        (item.rel === state.playing ? " current" : "");

      const tick = document.createElement("span");
      tick.className = "tick";
      tick.textContent = ip.done ? "✓" : "";
      tick.title = ip.done ? "Mark as unwatched (resets position)" : "Mark as watched";
      if (item.kind === "video") {
        tick.addEventListener("click", async (e) => {
          // the per-video reset: unticking clears both the check and the
          // resume position, exactly like re-doing a lecture on Udemy
          e.stopPropagation();
          ip.done = !ip.done;
          if (!ip.done) ip.t = 0;
          await saveProgress();
          renderSections();
        });
      }

      const label = document.createElement("div");
      label.className = "label";
      label.textContent = item.name;
      const sub = document.createElement("div");
      sub.className = "sub";
      if (item.kind === "quiz") sub.textContent = "Quiz";
      else if (ip.done) sub.textContent = fmt(ip.d) || "watched";
      else if (ip.t > 1) sub.textContent = `resume at ${fmt(ip.t)}${ip.d ? " / " + fmt(ip.d) : ""}`;
      else if (ip.d) sub.textContent = fmt(ip.d);
      else if (item.kind === "video") { sub.textContent = "…"; durPending.push({ rel: item.rel, sub }); }
      label.append(sub);

      row.append(tick, label);

      // Udemy-style: a 📎 badge on the lecture card, toggling its resources.
      let resWrap = null;
      if (item.resources && item.resources.length) {
        const badge = document.createElement("button");
        badge.className = "resBadge";
        badge.textContent = `📎 ${item.resources.length}`;
        badge.title = "Resources";
        row.append(badge);

        resWrap = document.createElement("div");
        resWrap.className = "resources hiddenEl";
        for (const r of item.resources) {
          const a = document.createElement("a");
          a.className = "res";
          a.href = "#";
          a.textContent = (r.externalUrl ? "🔗 " : "📎 ") + r.name;
          a.title = r.name;
          a.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            chrome.tabs.create({ url: r.externalUrl || fileUrl(course.root, r.rel) });
          });
          resWrap.append(a);
        }
        badge.addEventListener("click", (e) => {
          e.stopPropagation();
          resWrap.classList.toggle("hiddenEl");
        });
      }

      row.addEventListener("click", () =>
        item.kind === "quiz" ? openQuiz(item) : play(item.rel, { resume: true })
      );
      det.append(row);
      if (resWrap) det.append(resWrap);
    }
    wrap.append(det);
  });

  probeDurations(course, durPending); // fill unknown durations from disk, in place
}

// ---------------------------------------------------------------- playback

function findItem(rel) {
  const course = state.courses[state.courseId];
  for (const s of course.sections) {
    const hit = s.items.find((i) => i.rel === rel);
    if (hit) return hit;
  }
  return null;
}

function play(rel, { resume = false } = {}) {
  const course = state.courses[state.courseId];
  if (!course.root) return;
  const item = findItem(rel);
  if (!item || item.kind !== "video") return;

  state.playing = rel;
  nextCancelledFor = null; // fresh video — re-enable the next-up prompt/autoplay
  hideNextPrompt();
  updateNavArrows();
  pokeNav(); // briefly show the side arrows when a lecture starts
  const p = prog(course.id);
  p.last = rel;
  const ip = itemProg(course.id, rel);

  video.src = fileUrl(course.root, rel);
  loadSubtitles(course, item);
  // same file feeds the hover previews; decoded independently of playback
  previewVideo.src = video.src;
  $("seekfill").style.width = "0%";
  $("nowPlaying").textContent = item.name;
  video.playbackRate = state.settings.speed;
  video.volume = state.settings.volume;

  video.addEventListener(
    "loadedmetadata",
    () => {
      if (video.duration && isFinite(video.duration)) ip.d = video.duration;
      if (resume && ip.t > 1 && ip.t < video.duration - 2) video.currentTime = ip.t;
      // the browser resets rate/volume when new media loads — re-apply the saved ones
      video.playbackRate = state.settings.speed;
      video.volume = state.settings.volume;
      video.play().catch(() => {});
    },
    { once: true }
  );

  saveProgress();
  renderSections();
}

/** <track> accepts only WebVTT; container-mode captions are .srt. The whole
 *  conversion is a header plus decimal commas becoming dots in timestamps. */
function srtToVtt(srt) {
  // No literal backslashes near this regex: two generations of patch
  // tooling corrupted them. Char codes are immune.
  const CR = String.fromCharCode(13);
  const d = String.fromCharCode(92) + 'd';  // regex token for a digit
  const stamp = new RegExp('(' + d + '{2}:' + d + '{2}:' + d + '{2}),(' + d + '{3})', 'g');
  const body = String(srt).split(CR).join('').replace(stamp, '$1.$2');
  return 'WEBVTT' + String.fromCharCode(10, 10) + body;
}

// blob URLs of the current lecture's subtitle tracks, revoked on switch
let trackUrls = [];

/**
 * Attach downloaded .vtt files as native subtitle tracks. <track> refuses
 * file:// sources on CORS grounds, so each file is fetched (allowed via the
 * file host permission) and served to the element as a blob URL. Languages
 * that were never downloaded simply fail the fetch and are skipped.
 */
async function loadSubtitles(course, item) {
  for (const url of trackUrls) URL.revokeObjectURL(url);
  trackUrls = [];
  video.querySelectorAll("track").forEach((t) => t.remove());

  const langs = item.captions && item.captions.length ? item.captions : ["en"];
  // strip whatever container extension the file uses (.mp4 browser-mode,
  // .mkv from the Keyframe engine) so sidecar probing works for both
  const base = item.rel.replace(/\.[^./\\]+$/, "");
  let first = true;

  for (const lang of langs) {
    try {
      // we save .srt by default (Keep .vtt leaves .vtt) -- probe .srt first
      let text = null;
      let res = await fetch(fileUrl(course.root, `${base}.${lang}.srt`)).catch(() => null);
      if (res && res.ok) {
        text = srtToVtt(await res.text());
      } else {
        res = await fetch(fileUrl(course.root, `${base}.${lang}.vtt`)).catch(() => null);
        if (res && res.ok) text = await res.text();
      }
      if (!text) continue;
      const blobUrl = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
      trackUrls.push(blobUrl);

      const track = document.createElement("track");
      track.kind = "subtitles";
      track.srclang = lang.split("_")[0];
      track.label = lang;
      track.src = blobUrl;
      if (first) {
        track.default = true; // native CC menu starts on the first available
        first = false;
      }
      video.append(track);
    } catch {
      /* that language wasn't downloaded */
    }
  }
}

function openQuiz(item) {
  const course = state.courses[state.courseId];
  if (!course.root) return;
  chrome.tabs.create({ url: fileUrl(course.root, item.rel) });
}

function neighbour(offset) {
  const vids = flatVideos(state.courses[state.courseId]);
  const idx = vids.findIndex((v) => v.rel === state.playing);
  const next = vids[idx + offset];
  if (next) play(next.rel, { resume: true });
}

function nextVideoItem() {
  if (!state.courseId) return null;
  const vids = flatVideos(state.courses[state.courseId]);
  const idx = vids.findIndex((v) => v.rel === state.playing);
  return idx >= 0 ? vids[idx + 1] || null : null;
}

// Subtitle appearance (size + background), persisted; applied via ::cue.
function applyCaptionStyle() {
  const c = state.settings.caption || {};
  const size = Number(c.size) || 100;
  const bg = c.bg || "semi";
  const bgCss = bg === "box" ? "rgba(0,0,0,.78)" : "transparent";
  const shadow = bg === "box" ? "none" : "0 1px 2px #000, 0 0 5px #000";
  const el = $("capStyle");
  if (el) el.textContent = `video::cue{font-size:${size}%;background:${bgCss};text-shadow:${shadow};}`;
  if ($("capSize")) $("capSize").value = String(size);
  if ($("capBg")) $("capBg").value = bg;
}

// "Next up in Ns" prompt shown over the last 5 seconds (Cancel stops autoplay).
let nextCancelledFor = null;
function hideNextPrompt() { const p = $("nextPrompt"); if (p) p.classList.add("hiddenEl"); }
function maybeNextPrompt() {
  const p = $("nextPrompt");
  if (!p) return;
  const rem = (video.duration || 0) - video.currentTime;
  const nxt = nextVideoItem();
  if (nxt && isFinite(rem) && rem > 0.3 && rem <= 5 && nextCancelledFor !== state.playing) {
    $("nextPromptText").textContent = `Next: ${nxt.name} — ${Math.ceil(rem)}s`;
    p.classList.remove("hiddenEl");
  } else {
    hideNextPrompt();
  }
}

function markTime() {
  if (!state.playing || !state.courseId || !video.duration) return;
  const ip = itemProg(state.courseId, state.playing);
  ip.t = video.currentTime;
  ip.d = video.duration;
  if (video.currentTime / video.duration >= DONE_AT && !ip.done) {
    ip.done = true;
    renderSections();
  }
  saveProgress();
}

// ------------------------------------------------- seek bar with previews

// A second, muted video on the same file renders the hover frames. Its canvas
// is display-only, so file:// tainting is irrelevant here.
const previewVideo = document.createElement("video");
previewVideo.muted = true;
previewVideo.preload = "auto";
let previewPending = null; // last hovered time while a seek is in flight

previewVideo.addEventListener("seeked", () => {
  const c = $("seekcanvas");
  c.getContext("2d").drawImage(previewVideo, 0, 0, c.width, c.height);
  if (previewPending !== null) {
    const t = previewPending;
    previewPending = null;
    previewVideo.currentTime = t; // catch up to where the pointer is now
  }
});

function hoverTime(e) {
  const rect = $("seektrack").getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  return { frac, t: frac * (video.duration || 0), x: e.clientX - rect.left };
}

$("seektrack").addEventListener("mousemove", (e) => {
  if (!video.duration) return;
  const { t, x } = hoverTime(e);
  const box = $("seekpreview");
  box.style.display = "flex";
  box.style.left = `${x + 14}px`; // +14 = seekwrap's left padding
  $("seektime").textContent = fmt(t);
  // one in-flight seek at a time; remember the newest request otherwise
  if (previewVideo.seeking) previewPending = t;
  else previewVideo.currentTime = t;
});
$("seektrack").addEventListener("mouseleave", () => {
  $("seekpreview").style.display = "none";
  previewPending = null;
});
$("seektrack").addEventListener("click", (e) => {
  if (!video.duration) return;
  video.currentTime = hoverTime(e).t;
  video.play().catch(() => {});
});
video.addEventListener("timeupdate", () => {
  if (video.duration) {
    $("seekfill").style.width = `${(100 * video.currentTime) / video.duration}%`;
  }
  maybeNextPrompt();
});

video.addEventListener("ended", () => {
  const ip = itemProg(state.courseId, state.playing);
  ip.done = true;
  ip.t = 0; // next time, start from the top like Udemy does after completion
  saveProgress();
  renderSections();
  const autoplay = nextCancelledFor !== state.playing; // Cancel on the prompt stops it
  hideNextPrompt();
  if (autoplay) neighbour(1);
});
video.addEventListener("pause", markTime);
setInterval(() => {
  if (!video.paused) markTime();
}, 5000);
window.addEventListener("beforeunload", markTime);

$("speed").addEventListener("change", () => {
  state.settings.speed = Number($("speed").value) || 1;
  video.playbackRate = state.settings.speed;
  saveSettings();
});
// persist volume (debounced — volumechange fires rapidly while dragging)
let volTimer = null;
video.addEventListener("volumechange", () => {
  state.settings.volume = video.volume;
  clearTimeout(volTimer);
  volTimer = setTimeout(saveSettings, 400);
});
$("capSize").addEventListener("change", () => {
  state.settings.caption = { ...(state.settings.caption || {}), size: Number($("capSize").value) || 100 };
  applyCaptionStyle();
  saveSettings();
});
$("capBg").addEventListener("change", () => {
  state.settings.caption = { ...(state.settings.caption || {}), bg: $("capBg").value };
  applyCaptionStyle();
  saveSettings();
});
function toggleFullscreen() {
  const el = $("course"); // fullscreen the whole course so the sidebar can open inside it
  if (!el) return;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
}
$("fs").addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () => pokeNav());
// Controls + side arrows + cursor: shown on mouse move, hidden after 4s idle.
let navIdleTimer = null;
function pokeNav() {
  $("course").classList.add("nav-show");
  clearTimeout(navIdleTimer);
  navIdleTimer = setTimeout(() => $("course").classList.remove("nav-show"), 4000);
}
function updateNavArrows() {
  const vids = state.courseId ? flatVideos(state.courses[state.courseId]) : [];
  const idx = vids.findIndex((v) => v.rel === state.playing);
  $("navPrev").classList.toggle("navHidden", !(idx > 0));
  $("navNext").classList.toggle("navHidden", !(idx >= 0 && idx < vids.length - 1));
}
$("navPrev").addEventListener("click", () => neighbour(-1));
$("navNext").addEventListener("click", () => neighbour(1));
$("course").addEventListener("mousemove", pokeNav);
function applyAside() {
  const hidden = !!state.settings.asideHidden;
  $("course").classList.toggle("aside-hidden", hidden);
  $("asideToggle").textContent = hidden ? "«" : "»";
  $("asideToggle").title = hidden ? "Show course content" : "Hide course content";
}
$("asideToggle").addEventListener("click", () => {
  state.settings.asideHidden = !state.settings.asideHidden;
  applyAside();
  saveSettings();
});
$("nextPromptGo").addEventListener("click", () => { hideNextPrompt(); neighbour(1); });
$("nextPromptCancel").addEventListener("click", () => { nextCancelledFor = state.playing; hideNextPrompt(); });
$("prev").addEventListener("click", () => neighbour(-1));
$("next").addEventListener("click", () => neighbour(1));
$("back").addEventListener("click", () => {
  markTime();
  state.courseId = null;
  state.playing = null;
  renderLibrary();
});

// keyboard shortcuts: Space = play/pause, ←/→ = seek 5s (ignored while typing
// in a control so Space doesn't also toggle a <select>).
document.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") return;
  if (!state.playing) return;
  if (e.code === "Space" || e.key === " ") {
    e.preventDefault();
    if (video.paused) video.play().catch(() => {}); else video.pause();
  } else if (e.code === "ArrowLeft") {
    e.preventDefault();
    video.currentTime = Math.max(0, video.currentTime - 5);
  } else if (e.code === "ArrowRight") {
    e.preventDefault();
    video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 5);
  } else if (e.key === "f" || e.key === "F") {
    e.preventDefault();
    toggleFullscreen();
  }
});

// live refresh if a download finishes while this page is open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[COURSES_KEY]) return;
  state.courses = changes[COURSES_KEY].newValue || {};
  if (!state.courseId) renderLibrary();
  else if (state.courses[state.courseId]) checkFileAccess(state.courses[state.courseId]);
});

(async () => {
  await load();
  // restore persisted player settings into the UI + video element
  if ($("speed")) $("speed").value = String(state.settings.speed);
  video.volume = state.settings.volume;
  applyCaptionStyle();
  applyAside();
  renderLibrary();
})();
