// Runs in an offscreen document. Its ONLY job is the work a service worker
// physically cannot do: fetch segments, transmux MPEG-TS to fragmented MP4,
// and mint a blob URL (service workers have no URL.createObjectURL).
//
// Critical constraint: an offscreen document gets chrome.runtime and almost
// nothing else. chrome.storage, chrome.downloads and chrome.notifications are
// all undefined here. So this file never touches job state or saves files --
// it reports over messaging and the service worker owns everything else.

import { fetchWithTimeout, resolveHlsSegments } from "./udemy-api.js";

const RETRIES = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// blob URLs must outlive the download, so they're revoked on request
const held = new Map();

// Decrypted/finished byte buffers awaiting a streamed native write, by jobId.
const outputs = new Map();
const CHUNK = 4 * 1024 * 1024; // 4 MB raw per chunk (~5.3 MB base64 per message)
function serveChunk(msg) {
  const out = outputs.get(msg.bytesId);
  if (!out) return { ok: false, error: "no output buffered for this id" };
  const offset = msg.offset || 0;
  if (offset >= out.length) return { ok: true, b64: "", done: true, next: offset };
  const end = Math.min(offset + CHUNK, out.length);
  return { ok: true, b64: u8ToB64(out.subarray(offset, end)), next: end, done: end >= out.length };
}

// Per-build state, keyed "jobId:index". Module-level flags would make two
// concurrent builds cancel each other.
const builds = new Map();
const keyOf = (jobId, index) => `${jobId}:${index}`;

function report(payload) {
  // fire-and-forget; the worker may be asleep and that's fine
  chrome.runtime.sendMessage({ type: "hls-progress", ...payload }).catch(() => {});
}

async function fetchBytes(url, ctx) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    if (ctx.cancelled) throw new Error("cancelled");
    try {
      const res = await fetchWithTimeout(url, { timeoutMs: 45000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) await sleep(400 * attempt);
    }
  }
  throw new Error(`segment failed after ${RETRIES} tries: ${lastErr.message}`);
}

/**
 * fMP4 needs only init+segments concatenated. MPEG-TS goes through mux.js.
 * Flushing per segment keeps peak memory near one segment plus output, and
 * only the first emitted init segment is kept -- concatenating every flush's
 * init produces a file players reject.
 */
async function buildFile(resolved, onSegment, ctx, sink) {
  let fetched = 0;

  if (resolved.kind === "fmp4") {
    if (resolved.initUrl) await sink(await fetchBytes(resolved.initUrl, ctx));
    for (let i = 0; i < resolved.segments.length; i += 1) {
      const bytes = await fetchBytes(resolved.segments[i], ctx);
      fetched += bytes.byteLength;
      await sink(bytes);
      onSegment(i + 1, fetched);
    }
    return fetched;
  }

  if (!self.muxjs) throw new Error("mux.js failed to load");
  const transmuxer = new self.muxjs.mp4.Transmuxer({ remux: true });
  let haveInit = false;

  // sink() is async but mux.js emits synchronously, so queue the writes
  let chain = Promise.resolve();
  let emitted = 0;
  transmuxer.on("data", (segment) => {
    if (!haveInit && segment.initSegment) {
      const init = new Uint8Array(segment.initSegment);
      emitted += init.byteLength;
      chain = chain.then(() => sink(init));
      haveInit = true;
    }
    const data = new Uint8Array(segment.data);
    emitted += data.byteLength;
    chain = chain.then(() => sink(data));
  });

  for (let i = 0; i < resolved.segments.length; i += 1) {
    const bytes = await fetchBytes(resolved.segments[i], ctx);
    fetched += bytes.byteLength;
    transmuxer.push(bytes);
    transmuxer.flush();
    onSegment(i + 1, fetched);
  }

  await chain;
  if (!emitted) throw new Error("transmuxer produced no output");
  return emitted;
}

/** Build one lecture and hand back a blob URL for the worker to download. */
async function build(msg) {
  const { jobId, index, masterUrl, maxHeight } = msg;
  const key = keyOf(jobId, index);
  const ctx = { cancelled: false };
  builds.set(key, ctx);
  try {
    report({ jobId, index, stage: "resolving playlist", segDone: 0, segTotal: 0, bytes: 0 });
    const resolved = await resolveHlsSegments(masterUrl, maxHeight || Infinity);
    report({
      jobId, index, stage: "fetching", segDone: 0,
      segTotal: resolved.segments.length, height: resolved.height, bytes: 0,
    });

    let last = 0;
    const onSeg = (segDone, bytes) => {
      const now = Date.now();
      if (segDone === resolved.segments.length || now - last > 700) {
        last = now;
        report({
          jobId, index, stage: "fetching", segDone,
          segTotal: resolved.segments.length, height: resolved.height, bytes,
        });
      }
    };

    // FSA writes are deliberately gone: a stale directory handle passes the
    // permission check in this context and then every operation dies with
    // NotFoundError. The native helper owns final placement instead.
    // Fallback: buffer and hand a blob URL to the service worker.
    const parts = [];
    const size = await buildFile(resolved, onSeg, ctx, (u8) => { parts.push(u8); });
    const out = concatU8(parts);
    // keep the bytes so the SW can stream them to the native helper (direct disk
    // write — no chrome.downloads, no Save As); blobUrl stays as a fallback.
    outputs.set(key, out);
    const url = URL.createObjectURL(new Blob([out], { type: "video/mp4" }));
    held.set(url, true);
    return { ok: true, blobUrl: url, bytesId: key, size, height: resolved.height };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    builds.delete(key);
  }
}

// --------------------------------------------------------------- Widevine DRM
// Standalone pipeline: parse MPD -> CDM keys -> fetch+assemble each track ->
// CENC-decrypt -> mux -> blob URL. All in-page, no native host.

function headersObj(headers) {
  const out = {};
  for (const h of headers || []) { const i = h.indexOf(":"); if (i > 0) out[h.slice(0, i).trim()] = h.slice(i + 1).trim(); }
  return out;
}
async function fetchBytesH(url, ctx, hdrs) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    if (ctx.cancelled) throw new Error("cancelled");
    try {
      const res = await fetch(url, { headers: hdrs || {}, credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) { lastErr = err; if (attempt < RETRIES) await sleep(400 * attempt); }
  }
  throw new Error(`fetch failed after ${RETRIES} tries: ${lastErr.message}`);
}
function concatU8(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function u8ToB64(u8) { let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }

// Step 1 (offscreen, has DOMParser): fetch + parse the MPD -> PSSH + track URLs.
// The license request itself is done by the service worker (cookies), not here.
async function drmParse(msg) {
  if (!self.DASH) throw new Error("DASH module not loaded");
  const mpdText = await (await fetch(msg.mpdUrl, { credentials: "include" })).text();
  const man = self.DASH.parseMPD(mpdText, msg.mpdUrl, msg.maxHeight ? String(msg.maxHeight) : "best");
  if (!man.psshInit) return { ok: false, error: "no Widevine PSSH found in the manifest" };
  return { ok: true, psshInit: u8ToB64(man.psshInit), licenseUrl: man.licenseUrl, video: man.video, audio: man.audio };
}

// Step 3 (offscreen): download the tracks, CENC/CBCS-decrypt with the keys the
// service worker obtained, mux, and hand back a blob URL.
async function drmDecrypt(msg) {
  const { jobId, index, video, audio, keysByKid } = msg;
  const key = keyOf(jobId, index); const ctx = { cancelled: false };
  builds.set(key, ctx);
  try {
    for (const m of ["CENC", "REMUX"]) if (!self[m]) throw new Error(`${m} module not loaded`);
    const tracks = [["video", video], ["audio", audio]].filter(([, t]) => t);
    const totalSegs = tracks.reduce((a, [, t]) => a + (t.init ? 1 : 0) + t.segments.length, 0);
    let done = 0, bytes = 0, warning = null; const decrypted = {};
    for (const [name, tr] of tracks) {
      const parts = []; const urls = (tr.init ? [tr.init] : []).concat(tr.segments);
      for (const u of urls) {
        const b = await fetchBytesH(u, ctx, {}); parts.push(b); bytes += b.length; done += 1;
        report({ jobId, index, stage: `downloading ${name}`, segDone: done, segTotal: totalSegs, bytes });
      }
      report({ jobId, index, stage: `decrypting ${name}`, segDone: done, segTotal: totalSegs, bytes });
      try {
        decrypted[name] = await self.CENC.decryptCENC(concatU8(parts), keysByKid);
      } catch (err) {
        if (name === "video") throw err;
        warning = `audio track skipped (${err.message})`; decrypted.audio = null;
      }
    }
    report({ jobId, index, stage: "muxing", segDone: totalSegs, segTotal: totalSegs, bytes });
    const out = decrypted.audio ? await self.REMUX.remux(decrypted.video, decrypted.audio) : decrypted.video;
    // keep the bytes so the SW can stream them to the native helper (direct disk
    // write — no chrome.downloads, no Save As). blobUrl stays as a fallback.
    outputs.set(jobId, out);
    const url = URL.createObjectURL(new Blob([out], { type: "video/mp4" }));
    held.set(url, true);
    return { ok: true, blobUrl: url, bytesId: jobId, size: out.length, height: video.height, warning };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    builds.delete(key);
  }
}

async function drmBuild(msg) {
  const { jobId, index, mpdUrl, headers, licenseUrl, licenseHeaders, wvd, maxHeight } = msg;
  const key = keyOf(jobId, index);
  const ctx = { cancelled: false };
  builds.set(key, ctx);
  try {
    for (const m of ["WVCDM", "CENC", "DASH", "REMUX"]) if (!self[m]) throw new Error(`${m} module not loaded`);
    const hdrs = headersObj(headers);
    report({ jobId, index, stage: "parsing manifest", segDone: 0, segTotal: 0, bytes: 0 });
    const mpdText = await (await fetch(mpdUrl, { headers: hdrs, credentials: "include" })).text();
    const man = self.DASH.parseMPD(mpdText, mpdUrl, maxHeight ? String(maxHeight) : "best");
    if (!man.psshInit) throw new Error("no Widevine PSSH found in the manifest");
    const licUrl = licenseUrl || man.licenseUrl;
    if (!licUrl) throw new Error("no license URL (not in manifest and none supplied)");

    report({ jobId, index, stage: "getting keys", segDone: 0, segTotal: 0, bytes: 0 });
    const { keys } = await self.WVCDM.widevineKeys({
      wvd: self.DASH.b64ToU8(wvd), initData: man.psshInit,
      licenseUrl: licUrl, licenseHeaders: headersObj(licenseHeaders || headers),
    });
    if (!keys.length) throw new Error("license returned no content keys");
    const keysByKid = {}; for (const k of keys) keysByKid[k.kid] = k.key;

    const tracks = [["video", man.video], ["audio", man.audio]].filter(([, t]) => t);
    const totalSegs = tracks.reduce((a, [, t]) => a + (t.init ? 1 : 0) + t.segments.length, 0);
    let done = 0, bytes = 0, warning = null; const decrypted = {};
    for (const [name, tr] of tracks) {
      const parts = [];
      const urls = (tr.init ? [tr.init] : []).concat(tr.segments);
      for (const u of urls) {
        const b = await fetchBytesH(u, ctx, hdrs); parts.push(b); bytes += b.length; done += 1;
        report({ jobId, index, stage: `downloading ${name}`, segDone: done, segTotal: totalSegs, bytes });
      }
      report({ jobId, index, stage: `decrypting ${name}`, segDone: done, segTotal: totalSegs, bytes });
      try {
        decrypted[name] = await self.CENC.decryptCENC(concatU8(parts), keysByKid);
      } catch (err) {
        if (name === "video") throw err;           // video is essential
        warning = `audio track skipped (${err.message})`;  // e.g. WebM/Opus
        decrypted.audio = null;
      }
    }
    report({ jobId, index, stage: "muxing", segDone: totalSegs, segTotal: totalSegs, bytes });
    const out = decrypted.audio ? await self.REMUX.remux(decrypted.video, decrypted.audio) : decrypted.video;
    const url = URL.createObjectURL(new Blob([out], { type: "video/mp4" }));
    held.set(url, true);
    return { ok: true, blobUrl: url, size: out.length, height: man.video.height, warning };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    builds.delete(key);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.target !== "offscreen") return false;

  if (msg.type === "drm-build") {
    drmBuild(msg).then(reply);
    return true;
  }
  if (msg.type === "drm-parse") {
    drmParse(msg).then(reply).catch((e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "drm-decrypt") {
    drmDecrypt(msg).then(reply);
    return true;
  }
  if (msg.type === "bytes-chunk") { reply(serveChunk(msg)); return false; }
  if (msg.type === "bytes-free") { outputs.delete(msg.bytesId); reply({ ok: true }); return false; }

  if (msg.type === "hls-ping") {
    reply({
      ok: true,
      building: builds.size,
      muxjs: typeof self.muxjs,
      // proof of the constraint that broke the previous design
      hasStorage: typeof chrome.storage !== "undefined",
      hasDownloads: typeof chrome.downloads !== "undefined",
    });
    return true;
  }

  if (msg.type === "hls-build") {
    build(msg).then(reply);
    return true; // async reply
  }

  if (msg.type === "hls-revoke") {
    if (held.has(msg.blobUrl)) {
      URL.revokeObjectURL(msg.blobUrl);
      held.delete(msg.blobUrl);
    }
    reply({ ok: true });
    return true;
  }

  if (msg.type === "hls-cancel") {
    // cancel one build, or all of them when no index is given
    let n = 0;
    for (const [k, ctx] of builds) {
      if (msg.index === undefined || k === keyOf(msg.jobId, msg.index)) {
        ctx.cancelled = true;
        n += 1;
      }
    }
    reply({ ok: true, cancelled: n });
    return true;
  }

  return false;
});
