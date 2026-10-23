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
    const url = URL.createObjectURL(new Blob(parts, { type: "video/mp4" }));
    held.set(url, true);
    return { ok: true, blobUrl: url, size, height: resolved.height };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    builds.delete(key);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.target !== "offscreen") return false;

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
