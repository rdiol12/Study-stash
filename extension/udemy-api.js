// Talks to Udemy's API with the browser's own session cookies. No token, no
// container. Used by local mode; mirrors the endpoints constants.py uses.

const api = (portal) => `https://${portal}.udemy.com/api-2.0`;

/**
 * fetch with a hard deadline. A bare fetch on a stalled connection never
 * settles, which turns one bad DNS lookup into a job that hangs forever with
 * no error to report.
 */
export async function fetchWithTimeout(url, { timeoutMs = 30000, ...opts } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { credentials: "include", ...opts, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`timed out after ${timeoutMs / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url) {
  const res = await fetchWithTimeout(url, {
    timeoutMs: 30000,
    headers: { Accept: "application/json, text/plain, */*" },
  });
  if (res.status === 403 || res.status === 401) {
    throw new Error("Udemy rejected the request — sign in to Udemy in this browser.");
  }
  if (!res.ok) {
    // name the endpoint and echo the body: "HTTP 500" alone is undiagnosable
    let detail = "";
    try {
      detail = (await res.text()).replace(/\s+/g, " ").slice(0, 180);
    } catch {
      /* body unreadable */
    }
    const where = new URL(url).pathname.replace("/api-2.0", "");
    throw new Error(`Udemy ${res.status} on ${where}${detail ? ` — ${detail}` : ""}`);
  }
  return res.json();
}

/** Mint a fresh per-asset Widevine license token. The bulk curriculum token is
 *  short-lived (its JWT exp is ~5 min), so a big course outruns it; fetching the
 *  single asset right before each download returns a token valid right now. */
export async function freshLicenseToken(portal, assetId) {
  if (!assetId) return null;
  const url = `${api(portal)}/assets/${assetId}/?fields[asset]=media_license_token`;
  try { const data = await getJson(url); return (data && data.media_license_token) || null; }
  catch { return null; }
}

/** Windows-safe filename, matching what main.py's sanitize_filename produces. */
export function sanitize(name) {
  // Char codes instead of a regex class: the escaping for backslash and pipe
  // is error-prone to edit, and silently dropping spaces mangles every title.
  // 60 < | 62 > | 58 : | 34 " | 47 / | 92 \ | 124 | | 63 ? | 42 *
  const ILLEGAL = new Set([60, 62, 58, 34, 47, 92, 124, 63, 42]);
  let out = "";
  for (const ch of String(name || "")) {
    const code = ch.codePointAt(0);
    if (ILLEGAL.has(code) || code < 32) continue;
    out += ch;
  }
  return out.replace(/\s+/g, " ").replace(/[. ]+$/, "").trim().slice(0, 150) || "untitled";
}

const pad = (n, width) => String(n).padStart(width, "0");

/** Resolve a course slug to its numeric id via the user's enrolment list. */
export async function findCourse(portal, slug) {
  // main.py:883 accepts a numeric id in the URL, which skips lookup entirely
  // and survives instructors renaming a course.
  if (/^\d+$/.test(slug)) {
    return { id: Number(slug), title: `course-${slug}`, slug };
  }

  const base = `${api(portal)}/users/me/subscribed-courses?fields[course]=id,title,published_title`;
  const attempts = [
    `${base}&page_size=100&search=${encodeURIComponent(slug.replace(/-/g, " "))}`,
    // the plain listing is what main.py uses, so fall back to it if the
    // search variant errors
    `${base}&page_size=1000&ordering=-last_accessed`,
  ];

  const problems = [];
  for (const url of attempts) {
    let data;
    try {
      data = await getJson(url);
    } catch (err) {
      problems.push(err.message);
      continue;
    }
    const hit = (data.results || []).find((c) => c.published_title === slug);
    if (hit) return { id: hit.id, title: hit.title, slug: hit.published_title };
  }

  if (problems.length === attempts.length) {
    throw new Error(`Course lookup failed. ${problems[0]}`);
  }
  throw new Error(
    "That course isn't in your enrolled list. If it was renamed, put its numeric course id in the URL instead."
  );
}

// Mirrors CURRICULUM_ITEMS_PARAMS in constants.py. The quiz/practice field
// specs matter: the curriculum contains those item types, and omitting their
// fields makes the endpoint 500 rather than just skipping them.
const CURRICULUM_FIELDS = [
  "fields[lecture]=title,object_index,asset,supplementary_assets",
  "fields[quiz]=title,object_index,type,description,pass_percent",
  "fields[practice]=title,object_index",
  "fields[chapter]=title,object_index",
  "fields[asset]=title,filename,asset_type,status,media_sources,captions," +
    "download_urls,external_url,course_is_drmed,stream_urls,media_license_token",
  "caching_intent=true",
  "page_size=100",
].join("&");

/** All assessments for one quiz — the exact field set constants.py uses, so
 *  the result plugs straight into upstream's quiz_template.html. */
export async function fetchQuizAssessments(portal, quizId) {
  let url =
    `${api(portal)}/quizzes/${quizId}/assessments/?page_size=250` +
    `&fields[assessment]=id,assessment_type,prompt,correct_response,section,` +
    `question_plain,related_lectures`;
  const out = [];
  while (url) {
    const data = await getJson(url);
    out.push(...(data.results || []));
    url = data.next || null;
  }
  return out;
}

export async function fetchCurriculum(portal, courseId, onPage) {
  let url = `${api(portal)}/courses/${courseId}/subscriber-curriculum-items/?${CURRICULUM_FIELDS}`;
  const items = [];
  let page = 0;
  while (url) {
    const data = await getJson(url);
    items.push(...(data.results || []));
    page += 1;
    if (onPage) onPage(items.length, data.count || 0, page);
    url = data.next || null;
  }
  return items;
}

/**
 * Pick the best progressive MP4. DASH/HLS are deliberately ignored: a single
 * file needs no muxing, which is the whole reason local mode can exist without
 * ffmpeg. The cost is that progressive usually tops out below the HLS ladder.
 */
/**
 * Collect every video rendition. main.py:1104 reads stream_urls for
 * non-encrypted lectures and treats media_sources as the DASH/encrypted
 * variant -- looking only at media_sources finds nothing on a normal course.
 * Each entry carries `label` ("720", "1080", "audio") and `file`.
 */
function videoSources(asset) {
  const lists = [
    (asset.stream_urls && asset.stream_urls.Video) || [],
    asset.media_sources || [],
    (asset.download_urls && asset.download_urls.Video) || [],
  ];
  const out = [];
  const seen = new Set();

  for (const list of lists) {
    for (const src of list) {
      const url = src.file || src.src || "";
      const label = String(src.label || "");
      if (!url || seen.has(url) || label.toLowerCase() === "audio") continue;
      seen.add(url);
      out.push({
        url,
        height: parseInt(label, 10) || 0,
        hls: src.type === "application/x-mpegURL" || url.includes(".m3u8"),
        dash: url.includes(".mpd"),
      });
    }
  }
  return out;
}

function pickProgressive(asset, quality = "best") {
  const out = videoSources(asset).filter((s) => !s.hls && !s.dash);
  out.sort((a, b) => b.height - a.height);
  const cap = Number(quality);
  if (cap) {
    const atOrBelow = out.find((s) => (s.height || 0) <= cap);
    if (atOrBelow) return atOrBelow; // best that fits the cap
    return out[out.length - 1] || null; // nothing that small; take the lowest
  }
  return out[0] || null; // "best"
}

function pickHls(asset) {
  const out = videoSources(asset).filter((s) => s.hls);
  out.sort((a, b) => b.height - a.height);
  return out.length ? out[0].url : null;
}

/** The DASH (.mpd) manifest for an encrypted lecture — what the Keyframe bridge
 *  decrypts. Udemy exposes it in media_sources even when there is no
 *  progressive/stream_urls source (i.e. the lecture is DRM'd). */
function pickDash(asset) {
  const out = videoSources(asset).filter((s) => s.dash);
  return out.length ? out[0].url : null;
}

/**
 * Inspect an HLS master playlist to decide whether 1080p is reachable without
 * a muxer. Concatenating fMP4 segments onto their init segment produces a
 * valid file; MPEG-TS with a separate audio rendition does not.
 */
/** Parse #EXT-X-STREAM-INF entries out of a master playlist, tallest first. */
function parseVariants(text, masterUrl) {
  const lines = text.split("\n");
  const variants = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const dims = /RESOLUTION=(\d+)x(\d+)/.exec(lines[i]);
    const codecs = /CODECS="([^"]+)"/.exec(lines[i]);
    const next = (lines[i + 1] || "").trim();
    if (!next || next.startsWith("#")) continue;
    variants.push({
      width: dims ? Number(dims[1]) : 0,
      // Udemy's ladder reports RESOLUTION as WIDTHxHEIGHT; take the smaller
      // side as the vertical resolution so a rotated label can't mislead
      height: dims ? Math.min(Number(dims[1]), Number(dims[2])) : 0,
      codecs: codecs ? codecs[1] : "",
      url: new URL(next, masterUrl).href,
    });
  }
  variants.sort((a, b) => b.height - a.height);
  return variants;
}

/**
 * Resolve a master playlist to a concrete segment list for the tallest
 * variant at or below maxHeight.
 */
export async function resolveHlsSegments(masterUrl, maxHeight = Infinity) {
  const masterText = await (await fetchWithTimeout(masterUrl, { timeoutMs: 25000 })).text();
  const variants = parseVariants(masterText, masterUrl);
  const best = variants.find((v) => v.height <= maxHeight) || variants[0];
  if (!best) throw new Error("no variants in master playlist");

  const mediaUrl = best.url;
  const media = await (await fetchWithTimeout(mediaUrl, { timeoutMs: 25000 })).text();
  const initMatch = /#EXT-X-MAP:[^\n]*URI="([^"]+)"/i.exec(media);
  const segments = media
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((u) => new URL(u, mediaUrl).href);

  return {
    height: best.height,
    codecs: best.codecs,
    kind: initMatch ? "fmp4" : "mpegts",
    initUrl: initMatch ? new URL(initMatch[1], mediaUrl).href : null,
    segments,
  };
}

export async function probeHls(masterUrl) {
  const res = await fetchWithTimeout(masterUrl, { timeoutMs: 25000 });
  if (!res.ok) throw new Error(`master playlist returned HTTP ${res.status}`);
  const text = await res.text();

  const variants = parseVariants(text, masterUrl);

  const separateAudio = /#EXT-X-MEDIA:[^\n]*TYPE=AUDIO/i.test(text);
  const best = variants[0] || null;

  let segmentKind = "unknown";
  let initSegment = false;
  let segmentCount = 0;

  if (best) {
    const media = await (await fetchWithTimeout(best.url, { timeoutMs: 25000 })).text();
    initSegment = /#EXT-X-MAP:/i.test(media);
    const segments = media.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    segmentCount = segments.length;
    const first = segments[0] || "";
    if (initSegment || /\.m4s|\.mp4/i.test(first)) segmentKind = "fmp4";
    else if (/\.ts/i.test(first)) segmentKind = "mpegts";
  }

  return {
    variants: variants.map((v) => ({ height: v.height, codecs: v.codecs })),
    bestHeight: best ? best.height : 0,
    separateAudio,
    segmentKind,
    initSegment,
    segmentCount,
    // the whole question: can we just concatenate?
    concatenable: segmentKind === "fmp4" && !separateAudio,
  };
}

function captionsOf(asset) {
  const seen = new Set();
  const out = [];
  for (const cap of asset.captions || []) {
    const lang = cap.locale_id || cap.language || "en";
    if (!cap.url || seen.has(lang)) continue;
    seen.add(lang);
    out.push({ lang, url: cap.url });
  }
  return out;
}

function assetsOf(item) {
  const out = [];
  for (const sup of item.supplementary_assets || []) {
    const urls = sup.download_urls || {};
    const list = urls.File || urls.E_Book || urls.Presentation || urls.Audio || [];
    const first = list[0];
    if (first && first.file) {
      out.push({ name: sanitize(sup.filename || sup.title), url: first.file });
    } else if (sup.external_url) {
      out.push({ name: sanitize(sup.title) + ".url", externalUrl: sup.external_url });
    }
  }
  return out;
}

/**
 * Flatten the curriculum into the same folder shape main.py produces:
 *   <Course>/<02d - Chapter>/<03d Lecture>.mp4
 */
export function buildPlan(items, courseTitle, opts = {}) {
  // opts: { idAsName, courseId, continueNumbers (default true), quality }
  const continueNumbers = opts.continueNumbers !== false;
  const quality = opts.quality || "best";
  const chapters = [];
  let chapter = null;
  let counter = 0;

  for (const item of items) {
    if (item._class === "chapter") {
      chapter = {
        title: `${pad(item.object_index, 2)} - ${sanitize(item.title)}`,
        lectures: [],
      };
      chapters.push(chapter);
      if (!continueNumbers) counter = 0; // restart numbering within each chapter
      continue;
    }
    if (item._class !== "lecture" && item._class !== "quiz") continue;

    if (!chapter) {
      chapter = { title: "01 - Course content", lectures: [] };
      chapters.push(chapter);
    }

    counter += 1;

    if (item._class === "quiz") {
      chapter.lectures.push({
        name: `${counter}. ${sanitize(item.title)}`,
        kind: "quiz",
        quizId: item.id,
        // coding-exercise uses a different player upstream; not supported here
        quizType: item.type,
        quizTitle: item.title,
        quizDescription: item.description || "",
        passPercent: item.pass_percent ?? null,
      });
      continue;
    }
    const asset = item.asset || {};
    const name = `${counter}. ${sanitize(item.title)}`;

    if ((asset.asset_type || "").toLowerCase() !== "video") {
      chapter.lectures.push({ name, kind: "non-video", assets: assetsOf(item) });
      continue;
    }

    const best = pickProgressive(asset, quality);
    // main.py:1105 treats the presence of stream_urls as "not encrypted".
    // Deriving DRM from "no progressive source" was wrong: it flagged all 89
    // lectures the moment the source lookup itself was broken.
    const streams = (asset.stream_urls && asset.stream_urls.Video) || null;
    chapter.lectures.push({
      name,
      kind: "video",
      drm: !streams,
      url: best ? best.url : null,
      height: best ? best.height : null,
      // kept so local mode can probe (and later fetch) the higher HLS ladder
      hlsUrl: pickHls(asset),
      // DASH manifest for DRM lectures, decrypted in-browser by the standalone CDM.
      dashUrl: pickDash(asset),
      // Widevine license token — the license request goes to Udemy's own endpoint.
      // The bulk curriculum token is often stale; assetId lets us mint a fresh one.
      licenseToken: asset.media_license_token || null,
      assetId: asset.id || null,
      captions: captionsOf(asset),
      assets: assetsOf(item),
    });
  }

  const videos = chapters.flatMap((c) => c.lectures.filter((l) => l.kind === "video"));
  return {
    courseTitle: sanitize(courseTitle),
    chapters,
    stats: {
      chapters: chapters.length,
      videos: videos.length,
      downloadable: videos.filter((l) => !l.drm).length,
      drm: videos.filter((l) => l.drm).length,
      maxHeight: Math.max(0, ...videos.map((l) => l.height || 0)),
    },
  };
}

