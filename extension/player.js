// Course library + player. Mimics Udemy's layout: curriculum sidebar with
// collapsible sections, a tick per watched lecture, resume at the saved
// position, and per-video reset by unticking.
//
// Videos play over file:// built from the course's absolute root, which the
// background worker derives when a download completes. That requires the
// "Allow access to file URLs" toggle on brave://extensions — checked at
// runtime with a real fetch, not assumed.
//
// The library itself comes from disk (library.js): every folder in a library
// root is a course and every loose video/audio file a one-item course, with
// saved Udemy manifests matched onto the files actually there.

import { nativeScan } from "./native.js";
import {
  libraryRoots, resolveLibrary, scanViaFileUrls, progressKey, normPath,
} from "./library.js";

const COURSES_KEY = "courses";
const PROGRESS_KEY = "playerProgress";
const SETTINGS_KEY = "playerSettings"; // speed/volume, persisted across videos + reloads
const DONE_AT = 0.95; // Udemy ticks a lecture near the end, not only at 100%

const $ = (id) => document.getElementById(id);
const video = $("video");

const state = {
  stored: {},  // saved manifests, as chrome.storage holds them
  courses: {}, // what the library shows: stored + scanned, matched to disk
  progress: {},
  settings: { speed: 1, volume: 1 },
  nativeTarget: "",
  courseId: null,
  playing: null, // progress key of the current item
  saveTimer: null,
};

// ---------------------------------------------------------------- storage

async function load() {
  const stored = await chrome.storage.local.get([COURSES_KEY, PROGRESS_KEY, SETTINGS_KEY, "nativeTarget"]);
  state.stored = stored[COURSES_KEY] || {};
  state.courses = state.stored;
  state.progress = migrateProgress(stored[PROGRESS_KEY] || {});
  state.settings = { speed: 1, volume: 1, ...(stored[SETTINGS_KEY] || {}) };
  state.nativeTarget = stored.nativeTarget || "";
}

/** Progress used to be keyed by exact relative path, which broke when files
 *  were renamed ("001. Intro" -> "1. Intro"). Re-key it by progressKey(), which
 *  ignores padding and extensions; idempotent, so it is safe on every load. */
function migrateProgress(progress) {
  for (const p of Object.values(progress)) {
    const items = {};
    for (const [rel, ip] of Object.entries(p.items || {})) {
      const key = progressKey(rel);
      const prev = items[key];
      // two old paths collapsing onto one key: keep the furthest-along entry
      if (!prev || ip.done || (!prev.done && ip.t > prev.t)) items[key] = ip;
    }
    p.items = items;
    if (p.last) p.last = progressKey(p.last);
  }
  return progress;
}

// ---------------------------------------------------------------- disk scan

let scanBusy = null;
let lastScan = 0;

/** Re-read the library roots and rebuild state.courses. Falls back to the
 *  saved manifests alone when no root can be listed. */
function rescan() {
  if (scanBusy) return scanBusy;
  scanBusy = (async () => {
    const roots = libraryRoots(state.stored, state.nativeTarget);
    const scans = [];
    for (const root of roots) {
      const entries = await scanRoot(root);
      if (entries) scans.push({ root, entries });
    }
    state.courses = resolveLibrary(state.stored, scans);
    lastScan = Date.now();
  })().finally(() => { scanBusy = null; });
  return scanBusy;
}

async function scanRoot(root) {
  try {
    return (await nativeScan(root)).entries;
  } catch {
    // no helper, or one older than the "scan" op: read file:// listings instead
    try { return await scanViaFileUrls(root, fileUrl); } catch { return null; }
  }
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

function itemProg(courseId, key) {
  const p = prog(courseId);
  if (!p.items[key]) p.items[key] = { t: 0, d: 0, done: false };
  return p.items[key];
}

/** Progress key of a sidebar item (scanned items carry one; saved ones derive it). */
const keyOf = (item) => item.key || progressKey(item.rel);

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

const isMedia = (i) => i.kind === "video" || i.kind === "audio";

/** Lectures that can actually play: on disk (when the folder was scanned) and
 *  in a format the browser handles. Drives progress, Prev/Next and autoplay. */
function flatVideos(course) {
  return course.sections.flatMap((s) => s.items).filter((i) => isMedia(i) && !i.missing && !i.needsConvert);
}

function courseStats(course) {
  const vids = flatVideos(course);
  const p = state.progress[course.id];
  const done = vids.filter((v) => p && p.items[keyOf(v)] && p.items[keyOf(v)].done).length;
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
  // most recently watched first, then newest downloads, then by name
  const lastAt = (c) => (state.progress[c.id] && state.progress[c.id].at) || 0;
  const list = Object.values(state.courses).sort((a, b) =>
    lastAt(b) - lastAt(a) || (b.savedAt || 0) - (a.savedAt || 0) || a.title.localeCompare(b.title));

  if (!list.length) {
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "Nothing here yet. Download a course from the extension popup, " +
      "or put course folders, videos or audio files in your courses folder.";
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
    if (thumbCache.has(course.id)) {
      thumb.append(thumbCache.get(course.id));
    } else if (course.thumb) {
      // data-URL thumbnail saved by older versions
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
    const first = flatVideos(course)[0];
    meta.textContent = course.single
      ? (first && first.kind === "audio" ? "Audio" : "Video")
      : `${course.sections.length} sections · ${stats.total} lectures`;
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
      : course.single ? (last ? "Continue" : "Play") : "Start course";
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

  // before the first scan the saved paths may be stale (renamed files), so
  // wait for it rather than probe files that aren't there
  if (lastScan) generateThumbs(list);
}

/**
 * Draw one frame per course from its first lecture onto a <canvas> for the
 * card. The video only loads metadata plus the frames around the seek point,
 * so a 4 GB movie costs about as much as a short lecture. A file:// frame
 * taints the canvas, which is fine for display; it just can't be exported, so
 * the canvases are cached for the page's lifetime instead of in storage.
 * Sequential on purpose: decoding several videos at once is the kind of memory
 * spike that gets a tab killed.
 */
const thumbCache = new Map(); // courseId -> canvas
let thumbsBusy = false;
let thumbsAgain = null; // newest list asked for while a run was in progress
async function generateThumbs(list) {
  if (thumbsBusy) {
    thumbsAgain = list;
    return;
  }
  thumbsBusy = true;
  try {
    for (const course of list) {
      if (thumbCache.has(course.id) || course.thumb || !course.root) continue;
      const first = flatVideos(course).find((i) => i.kind === "video");
      if (!first) continue;
      const canvas = await captureFrame(fileUrl(course.root, first.rel)).catch(() => null);
      if (!canvas) continue;
      thumbCache.set(course.id, canvas);

      const slot = document.querySelector(`.thumb[data-course="${CSS.escape(course.id)}"]`);
      if (slot) {
        slot.textContent = "";
        slot.append(canvas);
      }
    }
  } finally {
    thumbsBusy = false;
    if (thumbsAgain) {
      const next = thumbsAgain;
      thumbsAgain = null;
      generateThumbs(next);
    }
  }
}

function captureFrame(src) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "metadata";
    const done = (fn, arg) => {
      clearTimeout(timer);
      v.removeAttribute("src");
      v.load(); // drop the decoder and any buffered data now, not at GC
      fn(arg);
    };
    const timer = setTimeout(() => done(reject, new Error("thumbnail timed out")), 15000);
    v.addEventListener("error", () => done(reject, new Error("video error")), { once: true });
    v.addEventListener("loadedmetadata", () => {
      if (!v.videoWidth) return done(reject, new Error("no video track"));
      // a few seconds in beats frame 0, which is usually a black fade-in
      v.currentTime = Math.min(5, (v.duration || 10) * 0.1);
    }, { once: true });
    v.addEventListener("seeked", () => {
      const c = document.createElement("canvas");
      c.width = 480;
      c.height = Math.round(480 * (v.videoHeight / v.videoWidth)) || 270;
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      done(resolve, c);
    }, { once: true });
    v.src = src;
  });
}

// ---------------------------------------------------------------- course view

// Per-section collapse state the user set (by section title), kept across
// re-renders. Cleared when a different course is opened.
const sectionOpen = new Map();

let revealPlaying = false; // set by play() when switching lectures within a course

/** Open/closed state of each section, saved per course so it survives
 *  reopening the course and reloads (keyed by section title). */
function sectionState(courseId) {
  const p = prog(courseId);
  if (!p.sections) p.sections = {};
  return p.sections;
}

async function openCourse(courseId) {
  const course = state.courses[courseId];
  if (!course) return;
  if (state.courseId !== courseId) sectionOpen.clear();
  state.courseId = courseId;

  $("library").classList.add("hiddenEl");
  $("course").classList.add("active");
  $("back").classList.remove("hiddenEl");
  $("title").textContent = course.title;

  state.singleAsideShown = false;
  applyAside();
  for (const id of ["prev", "next"]) $(id).classList.toggle("hiddenEl", !!course.single);
  await checkFileAccess(course);
  renderSections();

  // resume exactly where the student stopped, like Udemy's "continue"
  const p = prog(courseId);
  const vids = flatVideos(course);
  const target = (p.last && vids.some((v) => keyOf(v) === p.last)) ? p.last : vids[0] && keyOf(vids[0]);
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
  if (!probe) {
    warn.classList.add("hiddenEl");
    return;
  }
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
// the rows in place. Cached in progress, so it only probes once per video;
// `probing` keeps a re-render from queueing the same file again mid-probe.
const probing = new Set();
async function probeDurations(course, pending) {
  pending = pending.filter((p) => !probing.has(`${course.id}|${p.key}`));
  if (!course.root || !pending.length) return;
  for (const p of pending) probing.add(`${course.id}|${p.key}`);
  let i = 0, changed = false;
  const worker = async () => {
    while (i < pending.length) {
      const { rel, key } = pending[i++];
      const d = await probeDuration(fileUrl(course.root, rel));
      probing.delete(`${course.id}|${key}`);
      if (!d) continue;
      const ip = itemProg(course.id, key);
      if (!ip.d) { ip.d = d; changed = true; }
      // the row may have been re-rendered since; update whichever is current
      const sub = document.querySelector(`.item[data-key="${CSS.escape(key)}"] .sub`);
      if (sub && sub.textContent === "…") sub.textContent = fmt(d);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (changed) await saveProgress();
}

// resource lists the user opened, by item key; survives re-renders
const resOpen = new Set();

function renderSections() {
  const course = state.courses[state.courseId];
  const wrap = $("sections");
  wrap.textContent = "";
  const durPending = [];

  course.sections.forEach((section, si) => {
    const det = document.createElement("details");
    det.className = "section";
    const key = section.title;
    const containsPlaying = section.items.some((i) => keyOf(i) === state.playing);
    // remember the user's collapse choice across re-renders; default the first
    // section (and whichever holds the playing video) open on first sight.
    const saved = sectionState(course.id);
    if (!sectionOpen.has(key)) sectionOpen.set(key, key in saved ? saved[key] : si === 0 || containsPlaying);
    if (containsPlaying && revealPlaying && saved[key] === false) {
      saved[key] = true;
      saveProgress();
    }
    // reveal the section a lecture switch landed in (Next, autoplay, a click);
    // on reopening a course the remembered state wins instead
    if (containsPlaying && revealPlaying) sectionOpen.set(key, true);
    det.open = sectionOpen.get(key);
    det.addEventListener("toggle", () => {
      sectionOpen.set(key, det.open);
      if (saved[key] !== det.open) {
        saved[key] = det.open;
        saveProgress();
      }
    });

    const sum = document.createElement("summary");
    const name = document.createElement("span");
    name.textContent = section.title;
    const vids = section.items.filter((i) => isMedia(i) && !i.missing && !i.needsConvert);
    const doneCount = vids.filter((v) => itemProg(course.id, keyOf(v)).done).length;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = `${doneCount}/${vids.length}`;
    sum.append(name, count);
    det.append(sum);

    for (const item of section.items) {
      const row = document.createElement("div");
      const key = keyOf(item);
      const ip = itemProg(course.id, key);
      const playable = isMedia(item) && !item.missing && !item.needsConvert;
      row.className = "item" + (ip.done ? " done" : "") + (item.missing ? " drm" : "") +
        (key === state.playing ? " current" : "");
      row.dataset.key = key;

      const tick = document.createElement("span");
      tick.className = "tick";
      tick.textContent = ip.done ? "✓" : "";
      tick.title = ip.done ? "Mark as unwatched (resets position)" : "Mark as watched";
      if (playable) {
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
      if (item.missing) sub.textContent = item.drm ? "Protected — watch on Udemy" : "Not downloaded";
      else if (item.kind === "quiz") sub.textContent = "Quiz";
      else if (item.kind === "page") sub.textContent = "Page";
      else if (item.kind === "file") sub.textContent = "File";
      else if (item.needsConvert) sub.textContent = "Can't play in the browser — needs converting";
      else if (ip.done) sub.textContent = fmt(ip.d) || "watched";
      else if (ip.t > 1) sub.textContent = `resume at ${fmt(ip.t)}${ip.d ? " / " + fmt(ip.d) : ""}`;
      else if (ip.d) sub.textContent = fmt(ip.d);
      else { sub.textContent = "…"; durPending.push({ rel: item.rel, key }); }
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
        resWrap.className = "resources" + (resOpen.has(key) ? "" : " hiddenEl");
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
          const hidden = resWrap.classList.toggle("hiddenEl");
          if (hidden) resOpen.delete(key); else resOpen.add(key);
        });
      }

      if (!item.missing) {
        row.addEventListener("click", () =>
          isMedia(item) ? play(key, { resume: true }) : openQuiz(item)
        );
      }
      det.append(row);
      if (resWrap) det.append(resWrap);
    }
    wrap.append(det);
  });

  revealPlaying = false;
  probeDurations(course, durPending); // fill unknown durations from disk, in place
}

// ---------------------------------------------------------------- playback

function findItem(key) {
  const course = state.courses[state.courseId];
  for (const s of course.sections) {
    const hit = s.items.find((i) => keyOf(i) === key);
    if (hit) return hit;
  }
  return null;
}

function play(key, { resume = false } = {}) {
  const course = state.courses[state.courseId];
  if (!course.root) return;
  const item = findItem(key);
  if (!item || !isMedia(item) || item.missing) return;

  markTime(); // the lecture being left: save its position before the src swap
  revealPlaying = !!state.playing && state.playing !== key;
  state.playing = key;
  nextCancelledFor = null; // fresh video — re-enable the next-up prompt/autoplay
  hideNextPrompt();
  updateNavArrows();
  pokeNav(); // briefly show the side arrows when a lecture starts
  $("nowPlaying").textContent = item.name;

  if (item.needsConvert) {
    stopVideo();
    showVideoMsg(`“${item.name}” is in a format the browser can't play (.${item.rel.split(".").pop()}).\n` +
      "Convert it to .mp4 (H.264 + AAC) to watch it here.");
    renderSections();
    return;
  }
  hideVideoMsg();

  const p = prog(course.id);
  p.last = key;
  p.at = Date.now(); // library sorts by this
  const ip = itemProg(course.id, key);

  video.src = fileUrl(course.root, item.rel);
  loadSubtitles(course, item);
  // same file feeds the hover previews; decoded independently of playback
  previewVideo.src = video.src;
  $("seekfill").style.width = "0%";
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

  // strip whatever container extension the file uses (.mp4 browser-mode,
  // .mkv from the Keyframe engine) so sidecar probing works for both
  const base = item.rel.replace(/\.[^./\\]+$/, "");
  // A scanned folder already says which caption files sit beside the video;
  // otherwise probe the languages the manifest knows about.
  const candidates = item.subs
    ? item.subs.map((sub) => ({ lang: sub.lang, rels: [sub.rel] }))
    : (item.captions && item.captions.length ? item.captions : ["en"])
      // we save .srt by default (Keep .vtt leaves .vtt) -- probe .srt first
      .map((lang) => ({ lang, rels: [`${base}.${lang}.srt`, `${base}.${lang}.vtt`] }));
  let first = true;

  for (const { lang, rels } of candidates) {
    try {
      let text = null;
      for (const rel of rels) {
        const res = await fetch(fileUrl(course.root, rel)).catch(() => null);
        if (!res || !res.ok) continue;
        const raw = await res.text();
        text = /\.srt$/i.test(rel) ? srtToVtt(raw) : raw;
        break;
      }
      if (!text) continue;
      if (state.playing !== keyOf(item)) return; // switched lecture meanwhile
      const blobUrl = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
      trackUrls.push(blobUrl);

      const track = document.createElement("track");
      track.kind = "subtitles";
      track.srclang = (lang || "und").split("_")[0];
      track.label = lang || "Subtitles";
      track.src = blobUrl;
      if (first) {
        track.default = true; // native CC menu starts on the first available
        first = false;
      }
      // cues arrive after the track loads; a lecture opened mid-hover needs the lift too
      track.addEventListener("load", applyCaptionLift, { once: true });
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
  const idx = vids.findIndex((v) => keyOf(v) === state.playing);
  const next = vids[idx + offset];
  if (next) play(keyOf(next), { resume: true });
}

function nextVideoItem() {
  if (!state.courseId) return null;
  const vids = flatVideos(state.courses[state.courseId]);
  const idx = vids.findIndex((v) => keyOf(v) === state.playing);
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

// ------------------------------------------------- unplayable / missing files

function stopVideo() {
  video.pause();
  video.removeAttribute("src");
  video.load();
  previewVideo.removeAttribute("src");
}
function showVideoMsg(text) {
  $("videoMsg").textContent = text;
  $("videoMsg").classList.remove("hiddenEl");
}
function hideVideoMsg() {
  $("videoMsg").classList.add("hiddenEl");
}

// A black, silent player says nothing; spell out whether the file is gone or
// just in a codec Chromium lacks (HEVC, AC3/DTS audio, ...).
video.addEventListener("error", async () => {
  const src = video.currentSrc || video.src;
  if (!src || !state.playing) return;
  const item = findItem(state.playing);
  const name = item ? item.name : "This file";
  let exists = false;
  try {
    const controller = new AbortController();
    const res = await fetch(src, { signal: controller.signal });
    exists = res.ok;
    controller.abort(); // headers are enough; never read the body
  } catch (err) {
    exists = err.name === "AbortError";
  }
  if (src !== (video.currentSrc || video.src)) return; // moved on meanwhile
  showVideoMsg(exists
    ? `“${name}” uses a video or audio format the browser can't play.\n` +
      "Convert it to .mp4 (H.264 + AAC) to watch it here."
    : `“${name}” isn't on disk any more.\n${decodeURIComponent(src.replace(/^file:\/\/\//, ""))}`);
});
setInterval(() => {
  if (!video.paused) markTime();
}, 5000);
window.addEventListener("beforeunload", markTime);

$("speed").addEventListener("change", () => {
  state.settings.speed = Number($("speed").value) || 1;
  video.playbackRate = state.settings.speed;
  saveSettings();
});
// Give keyboard focus back to the page after picking from a dropdown;
// otherwise Space/arrows keep changing the <select> instead of the video.
for (const id of ["speed", "capSize", "capBg"]) {
  $(id).addEventListener("change", () => $(id).blur());
}
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
  // In fullscreen the browser's own control bar follows ours: on its own it
  // stayed up (always, while paused) after ours had faded, blocking the view.
  // Windowed, the attribute is left alone: the browser hides that bar itself
  // on idle, and re-setting `controls` (even to the same value) brings it
  // back and keeps it up until the mouse moves again.
  if (!video.controls) video.controls = true;
  updateCaptionLift();
  clearTimeout(navIdleTimer);
  navIdleTimer = setTimeout(() => {
    $("course").classList.remove("nav-show");
    if (document.fullscreenElement) video.controls = false;
    updateCaptionLift();
  }, 4000);
}
// The browser's bar is up whenever ours is (mouse moved recently), and,
// windowed, the whole time the video is paused. Windowed, the browser also
// drops its bar the moment the mouse leaves the video, so the cues follow
// right away instead of waiting out the idle timer.
let mouseOverVideo = false;
function updateCaptionLift() {
  const navShown = $("course").classList.contains("nav-show");
  const fs = !!document.fullscreenElement;
  liftCaptions((navShown && (fs || mouseOverVideo)) || (!fs && video.paused));
}
video.addEventListener("play", updateCaptionLift);
video.addEventListener("pause", updateCaptionLift);
video.addEventListener("mouseleave", () => {
  mouseOverVideo = false;
  updateCaptionLift();
});

// The control bars (the browser's, and in fullscreen ours too) overlay the
// bottom of the video, right where subtitles sit, so while they're showing the
// cues move up a few lines (like YouTube does); "auto" puts them back.
const CAPTION_LIFT_LINE = -4; // lines from the bottom; auto is effectively -1
let captionsLifted = false;
function liftCaptions(lift) {
  if (lift === captionsLifted) return;
  captionsLifted = lift;
  applyCaptionLift();
}
function applyCaptionLift() {
  for (const track of video.textTracks) {
    if (!track.cues) continue;
    for (const cue of track.cues) cue.line = captionsLifted ? CAPTION_LIFT_LINE : "auto";
    // Chromium doesn't re-lay out a cue already on screen when its line
    // changes; flipping the mode makes it redraw at the new place.
    if (track.mode === "showing") {
      track.mode = "hidden";
      track.mode = "showing";
    }
  }
}
function updateNavArrows() {
  const vids = state.courseId ? flatVideos(state.courses[state.courseId]) : [];
  const idx = vids.findIndex((v) => keyOf(v) === state.playing);
  $("navPrev").classList.toggle("navHidden", !(idx > 0));
  $("navNext").classList.toggle("navHidden", !(idx >= 0 && idx < vids.length - 1));
}
$("navPrev").addEventListener("click", () => neighbour(-1));
$("navNext").addEventListener("click", () => neighbour(1));
$("course").addEventListener("mousemove", (e) => {
  mouseOverVideo = e.target === video;
  pokeNav();
});
// A single movie has nothing to navigate, so its sidebar starts hidden without
// touching the saved preference for real courses.
function applyAside() {
  const course = state.courseId && state.courses[state.courseId];
  const hidden = course && course.single ? !state.singleAsideShown : !!state.settings.asideHidden;
  $("course").classList.toggle("aside-hidden", hidden);
  $("asideToggle").textContent = hidden ? "«" : "»";
  $("asideToggle").title = hidden ? "Show course content" : "Hide course content";
}
function toggleAside() {
  const course = state.courseId && state.courses[state.courseId];
  if (course && course.single) {
    state.singleAsideShown = !state.singleAsideShown;
    applyAside();
    return;
  }
  state.settings.asideHidden = !state.settings.asideHidden;
  applyAside();
  saveSettings();
}
$("asideToggle").addEventListener("click", toggleAside);

// Fill (crop to the area, no bars) or Fit (whole picture, bars if needed).
function applyFit() {
  const fit = state.settings.fit === "fit";
  $("course").classList.toggle("fit-contain", fit);
  $("fit").textContent = fit ? "Fit" : "Fill";
}
function toggleFit() {
  state.settings.fit = state.settings.fit === "fit" ? "fill" : "fit";
  applyFit();
  saveSettings();
}
$("fit").addEventListener("click", () => { toggleFit(); $("fit").blur(); });
$("nextPromptGo").addEventListener("click", () => { hideNextPrompt(); neighbour(1); });
$("nextPromptCancel").addEventListener("click", () => { nextCancelledFor = state.playing; hideNextPrompt(); });
$("prev").addEventListener("click", () => neighbour(-1));
$("next").addEventListener("click", () => neighbour(1));
$("back").addEventListener("click", () => {
  markTime();
  state.courseId = null;
  state.playing = null;
  hideVideoMsg();
  applyAside();
  renderLibrary();
});
// Play/pause from a click or Space, with the centered icon other players flash:
// it shows what just happened (▶ resumed, ❚❚ paused), then grows and fades.
const PLAY_SVG = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
function togglePlay() {
  if (video.paused) video.play().catch(() => {}); else video.pause();
  flashPlayState();
}
function flashPlayState() {
  const flash = $("playFlash");
  flash.innerHTML = video.paused ? PAUSE_SVG : PLAY_SVG;
  flash.classList.remove("show");
  void flash.offsetWidth; // restart the animation on quick repeat toggles
  flash.classList.add("show");
}

// Click the picture to play/pause, double-click for fullscreen (the native
// fullscreen button is hidden via controlsList, so this uses ours). The single
// click waits out the double-click window so a double-click doesn't also
// pause and resume the video.
const DBLCLICK_MS = 250;
let clickTimer = null;
const onControlBar = (e) => e.offsetY > video.clientHeight - 48; // native bar handles these
video.addEventListener("click", (e) => {
  if (onControlBar(e)) return;
  clearTimeout(clickTimer);
  if (e.detail > 1) return; // second click of a double-click
  clickTimer = setTimeout(() => {
    if (!video.currentSrc) return;
    togglePlay();
  }, DBLCLICK_MS);
});
video.addEventListener("dblclick", (e) => {
  clearTimeout(clickTimer);
  if (onControlBar(e)) return;
  toggleFullscreen();
});

// keyboard shortcuts: Space = play/pause, ←/→ = seek 5s (ignored while typing
// in a control so Space doesn't also toggle a <select>).
document.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") return;
  // leave browser shortcuts alone: Ctrl+F is Find, not fullscreen
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!state.playing) return;
  if (e.code === "Space" || e.key === " ") {
    e.preventDefault();
    // With the <video> itself focused (it is, after any click on it), Chromium's
    // own controls already toggle on Space before this runs; toggling again
    // would pause and resume. Then only draw the icon, once the state settled.
    if (e.target === video) setTimeout(flashPlayState, 0);
    else togglePlay();
  } else if (e.code === "ArrowLeft") {
    e.preventDefault();
    video.currentTime = Math.max(0, video.currentTime - 5);
  } else if (e.code === "ArrowRight") {
    e.preventDefault();
    video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 5);
  } else if (e.key === "f" || e.key === "F") {
    e.preventDefault();
    toggleFullscreen();
  } else if (e.key === "s" || e.key === "S") {
    e.preventDefault();
    toggleAside();
  } else if (e.key === "z" || e.key === "Z") {
    e.preventDefault();
    toggleFit();
  }
});

/** Re-scan the disk and redraw whichever view is open. */
async function refreshLibrary() {
  const open = state.courseId && state.courses[state.courseId];
  await rescan();
  // the open course's folder vanished mid-session: keep showing what we had
  if (open && !state.courses[state.courseId]) state.courses[state.courseId] = open;
  if (!state.courseId) {
    renderLibrary();
  } else if (state.courses[state.courseId]) {
    checkFileAccess(state.courses[state.courseId]);
    renderSections();
    updateNavArrows();
  }
}

// live refresh if a download finishes while this page is open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.nativeTarget) state.nativeTarget = changes.nativeTarget.newValue || "";
  if (!changes[COURSES_KEY] && !changes.nativeTarget) return;
  if (changes[COURSES_KEY]) state.stored = changes[COURSES_KEY].newValue || {};
  refreshLibrary();
});

// pick up folders and files added or removed while the tab was in the background
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - lastScan > 10000) refreshLibrary();
});

(async () => {
  await load();
  // restore persisted player settings into the UI + video element
  if ($("speed")) $("speed").value = String(state.settings.speed);
  video.volume = state.settings.volume;
  applyCaptionStyle();
  applyAside();
  applyFit();
  renderLibrary(); // saved courses straight away, then what's actually on disk
  refreshLibrary();
})();
