// Builds the player's library from what is actually on disk.
//
// Every folder inside a library root is a course (subfolders = sections, media
// files = lectures), and a loose video or audio file is a one-item course. A
// Udemy download keeps its saved manifest (titles, quizzes, DRM flags), but each
// lecture is matched to its file on disk by number + title, so renames such as
// "001. Intro" -> "1. Intro" or a moved course folder don't break playback.
//
// Kept free of DOM and chrome.* calls apart from the scanners at the bottom, so
// the matching logic can be exercised with plain node.

export const VIDEO_EXT = ["mp4", "m4v", "mkv", "webm", "mov", "ogv"];
export const AUDIO_EXT = ["mp3", "m4a", "aac", "flac", "opus", "ogg", "oga", "wav"];
// Containers Chromium can't play at all; listed so the user sees them, with a note.
export const CONVERT_EXT = ["avi", "wmv", "flv", "mpg", "mpeg", "ts", "m2ts", "mts", "3gp", "vob", "divx", "rm", "rmvb", "asf"];
const SUB_EXT = ["srt", "vtt"];
const PAGE_EXT = ["html", "htm"];
const STRIP_EXT = new Set([...VIDEO_EXT, ...AUDIO_EXT, ...CONVERT_EXT, ...PAGE_EXT]);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export const naturalCompare = (a, b) => collator.compare(a, b);

export function extOf(name) {
  const m = /\.([^./\\]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

/** "video" | "audio" | "convert" | null */
export function mediaKind(name) {
  const ext = extOf(name);
  if (VIDEO_EXT.includes(ext)) return "video";
  if (AUDIO_EXT.includes(ext)) return "audio";
  if (CONVERT_EXT.includes(ext)) return "convert";
  return null;
}

/** Drop a media/page extension only — "Intro to Node.js" keeps its ".js". */
export function stripExt(name) {
  return STRIP_EXT.has(extOf(name)) ? name.replace(/\.[^.]+$/, "") : name;
}

export function normPath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

export function baseName(p) {
  const n = normPath(p);
  return n.slice(n.lastIndexOf("/") + 1);
}

export function dirName(p) {
  const n = normPath(p);
  const i = n.lastIndexOf("/");
  return i < 0 ? "" : n.slice(0, i);
}

/** One path segment, normalised for matching: no extension, no zero padding
 *  on the leading number, case and spacing folded. */
export function normPart(s) {
  return stripExt(String(s))
    .replace(/^\s*0+(\d)/, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Stable progress key for a course-relative path. Idempotent, so already
 *  migrated keys map to themselves. */
export function progressKey(rel) {
  return normPath(rel).split("/").filter(Boolean).map(normPart).join("/");
}

const samePath = (a, b) => normPath(a).toLowerCase() === normPath(b).toLowerCase();

// ------------------------------------------------------------ course building

/** Index one course folder's files: media by key, captions and leftovers. */
function indexFiles(files) {
  const media = new Map(); // progressKey -> rel
  const pages = new Map();
  const subs = [];
  const other = [];
  for (const rel of files) {
    const ext = extOf(rel);
    if (mediaKind(rel)) media.set(progressKey(rel), rel);
    else if (PAGE_EXT.includes(ext)) pages.set(progressKey(rel), rel);
    else if (SUB_EXT.includes(ext)) subs.push(rel);
    else other.push(rel);
  }
  return { media, pages, subs, other };
}

/** Captions sit next to the video: "<stem>.<lang>.srt" or "<stem>.srt". */
function subsFor(rel, subs) {
  const dir = dirName(rel);
  const stem = stripExt(baseName(rel)).toLowerCase();
  const out = [];
  for (const s of subs) {
    if (dirName(s) !== dir) continue;
    const sStem = baseName(s).replace(/\.[^.]+$/, "");
    if (sStem.toLowerCase() === stem) out.push({ lang: "", rel: s });
    else if (sStem.toLowerCase().startsWith(stem + ".")) {
      const lang = sStem.slice(stem.length + 1);
      if (lang && !lang.includes(".")) out.push({ lang, rel: s });
    }
  }
  return out.sort((a, b) => naturalCompare(a.lang, b.lang));
}

/** Attachments are saved as "<lecture> - <file name>" beside the lecture. */
function resourcesFor(rel, other, used) {
  const dir = dirName(rel);
  const prefix = stripExt(baseName(rel)).toLowerCase() + " - ";
  const out = [];
  for (const o of other) {
    if (used.has(o) || dirName(o) !== dir) continue;
    const b = baseName(o);
    if (b.toLowerCase().startsWith(prefix)) {
      out.push({ name: b.slice(prefix.length), rel: o });
      used.add(o);
    }
  }
  return out;
}

function mediaItem(rel, idx, used) {
  const kind = mediaKind(rel);
  const parts = normPath(rel).split("/");
  // files nested below the section folder keep their sub-path in the label
  const label = parts.slice(1, -1).concat(stripExt(parts[parts.length - 1]));
  return {
    name: (parts.length > 2 ? label.join(" / ") : stripExt(parts[parts.length - 1])),
    kind: kind === "audio" ? "audio" : "video",
    needsConvert: kind === "convert",
    rel,
    key: progressKey(rel),
    subs: subsFor(rel, idx.subs),
    resources: resourcesFor(rel, idx.other, used),
  };
}

const sectionOf = (rel) => {
  const parts = normPath(rel).split("/");
  return parts.length > 1 ? parts[0] : "";
};

/** A course built purely from a folder's contents. */
export function buildFolderCourse({ id, title, root, files }) {
  const idx = indexFiles(files);
  const used = new Set();
  const bySection = new Map();
  const push = (sec, item) => {
    if (!bySection.has(sec)) bySection.set(sec, []);
    bySection.get(sec).push(item);
  };
  for (const rel of [...idx.media.values()].sort(naturalCompare)) push(sectionOf(rel), mediaItem(rel, idx, used));
  for (const rel of [...idx.pages.values()].sort(naturalCompare)) {
    push(sectionOf(rel), { name: stripExt(baseName(rel)), kind: "page", rel, key: progressKey(rel) });
  }
  for (const rel of idx.other.filter((o) => !used.has(o)).sort(naturalCompare)) {
    push(sectionOf(rel), { name: baseName(rel), kind: "file", rel, key: progressKey(rel) });
  }

  const sections = [...bySection.keys()]
    .sort((a, b) => (a === "" ? -1 : b === "" ? 1 : naturalCompare(a, b)))
    .map((sec) => ({
      title: sec || (bySection.size > 1 ? "Files" : title),
      items: bySection.get(sec).sort((a, b) => naturalCompare(baseName(a.rel), baseName(b.rel))),
    }));
  const playable = sections.flatMap((s) => s.items).filter((i) => i.kind === "video" || i.kind === "audio");
  return { id, title, root, source: "folder", sections, single: playable.length === 1 && sections.length === 1 };
}

/** A saved Udemy manifest, re-pointed at the files really on disk. Lectures
 *  with no file are kept but flagged `missing` so the sidebar can say so. */
export function resolveManifest(course, root, files) {
  const idx = indexFiles(files);
  const used = new Set();
  const matched = new Set();
  const sections = course.sections.map((s) => ({
    ...s,
    items: s.items.map((item) => {
      const key = progressKey(item.rel);
      const pool = item.kind === "quiz" ? idx.pages : idx.media;
      const rel = pool.get(key);
      if (!rel) return { ...item, key, missing: true };
      matched.add(rel);
      const resolved = { ...item, key, rel, missing: false };
      if (item.kind !== "quiz") {
        resolved.subs = subsFor(rel, idx.subs);
        resolved.needsConvert = mediaKind(rel) === "convert";
        const found = resourcesFor(rel, idx.other, used);
        resolved.resources = (item.resources || []).filter((r) => r.externalUrl).concat(found);
      }
      return resolved;
    }),
  }));

  // media the user dropped in beside the download joins its section (or a new one)
  for (const rel of [...idx.media.values()].sort(naturalCompare)) {
    if (matched.has(rel)) continue;
    const sec = sectionOf(rel);
    let target = sections.find((s) => normPart(s.title) === normPart(sec));
    if (!target) {
      target = { title: sec || "Other files", items: [] };
      sections.push(target);
    }
    target.items.push(mediaItem(rel, idx, used));
  }
  return { ...course, root, sections, scanned: true };
}

/**
 * Merge saved courses with scanned library roots.
 *  stored: { id: course } from chrome.storage
 *  scans:  [{ root, entries: [{ rel, dir?, size? }] }] — unscannable roots omitted
 * Returns { id: course } for the player.
 */
export function resolveLibrary(stored, scans) {
  const folders = []; // { path, name, files: [rel within the folder] }
  const loose = [];   // { root, rel, subs: sibling caption files }
  for (const { root, entries } of scans) {
    const topSubs = entries.filter((e) => !e.dir && !e.rel.includes("/") && SUB_EXT.includes(extOf(e.rel)));
    const byTop = new Map();
    for (const e of entries) {
      const parts = normPath(e.rel).split("/");
      if (parts.length === 1) {
        if (e.dir) byTop.set(parts[0], byTop.get(parts[0]) || []);
        else if (mediaKind(parts[0])) {
          const stem = stripExt(parts[0]).toLowerCase() + ".";
          const subs = topSubs.map((t) => t.rel).filter((t) => t.toLowerCase().startsWith(stem));
          loose.push({ root, rel: parts[0], subs });
        }
        continue;
      }
      if (e.dir) continue;
      if (!byTop.has(parts[0])) byTop.set(parts[0], []);
      byTop.get(parts[0]).push(parts.slice(1).join("/"));
    }
    for (const [name, files] of byTop) folders.push({ path: `${normPath(root)}/${name}`, name, files, root });
  }
  const scannedRoots = scans.map((s) => normPath(s.root));
  const underScan = (p) => scannedRoots.some((r) => samePath(dirName(p), r));

  const out = {};
  const usedFolders = new Set();
  for (const course of Object.values(stored)) {
    if (course.source === "keyframe") {
      out[course.id] = course; // single-file cards from that engine: as saved
      continue;
    }
    let folder = course.root ? folders.find((f) => samePath(f.path, course.root)) : null;
    // moved/renamed folder, or a download whose root isn't recorded yet: by title
    if (!folder) folder = folders.find((f) => !usedFolders.has(f) && normPart(f.name) === normPart(course.title));
    if (folder) {
      usedFolders.add(folder);
      out[course.id] = resolveManifest(course, folder.path, folder.files);
    } else if (!course.root || !underScan(course.root)) {
      out[course.id] = course; // nothing on disk to compare with yet
    }
    // else: its folder was deleted, so it leaves the library (progress is kept)
  }

  for (const f of folders) {
    if (usedFolders.has(f)) continue;
    if (!f.files.some((rel) => mediaKind(rel))) continue; // not a course
    const id = out[f.name] ? `folder:${f.path}` : f.name;
    out[id] = buildFolderCourse({ id, title: f.name, root: f.path, files: f.files });
  }
  for (const { root, rel, subs } of loose) {
    const title = stripExt(rel);
    const id = `file:${normPath(root)}/${rel}`;
    out[id] = buildFolderCourse({ id, title, root: normPath(root), files: [rel, ...subs] });
  }
  return out;
}

/** Folders to scan: the helper's target plus the parent of every course root. */
export function libraryRoots(stored, nativeTarget) {
  const roots = [];
  const add = (p) => {
    if (p && !roots.some((r) => samePath(r, p))) roots.push(normPath(p));
  };
  if (nativeTarget) add(nativeTarget);
  for (const c of Object.values(stored)) {
    if (c.root && c.source !== "keyframe") add(dirName(c.root));
  }
  return roots;
}

// ------------------------------------------------------------ scanning

/** Same-shape listing as the helper's "scan", read from Chromium's file://
 *  directory pages. Fallback for when the helper isn't installed or is older. */
export async function scanViaFileUrls(root, toUrl, maxDepth = 4, maxEntries = 20000) {
  const entries = [];
  const walk = async (rel, depth) => {
    const res = await fetch(toUrl(root, rel) + "/");
    // Chromium answers a directory with status 0 (no headers), a file with 200
    if (!res.ok && res.status !== 0) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const rows = [...html.matchAll(/addRow\((.*?)\);/g)];
    for (const m of rows) {
      if (entries.length >= maxEntries) return;
      let args;
      try { args = JSON.parse(`[${m[1]}]`); } catch { continue; }
      const [name, , isDir, size] = args;
      if (!name || name === ".." || name.startsWith(".") || name.startsWith("$")) continue;
      const sub = rel ? `${rel}/${name}` : name;
      if (isDir) {
        entries.push({ rel: sub, dir: true });
        if (depth < maxDepth) await walk(sub, depth + 1).catch(() => {});
      } else {
        entries.push({ rel: sub, size });
      }
    }
  };
  await walk("", 1);
  return entries;
}
