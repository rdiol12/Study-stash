// Talks to the local helper registered via native messaging.
//
// It exists to escape one hard limit: chrome.downloads can only write beneath
// the browser's download folder. The helper moves finished courses anywhere on
// disk, so downloads still run in the background with no tab open.
//
// Only paths cross this channel, never file contents -- native messaging is a
// length-prefixed JSON pipe, and pushing video through it as base64 would be
// both slow and pointless when the file is already on disk.

const HOST = "com.udemy_bridge.host";

function call(payload, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("the helper did not respond — is it installed?"));
    }, timeoutMs);

    try {
      chrome.runtime.sendNativeMessage(HOST, payload, (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message || "helper unavailable"));
          return;
        }
        if (!res) {
          reject(new Error("empty reply from the helper"));
          return;
        }
        if (!res.ok) {
          reject(new Error(res.error || "helper reported an error"));
          return;
        }
        resolve(res);
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

export async function nativePing() {
  return call({ op: "ping" }, 4000);
}

export async function nativeAvailable() {
  try {
    await nativePing();
    return true;
  } catch {
    return false;
  }
}

export const nativeDrives = () => call({ op: "drives" }, 15000);
export const nativeList = (path) => call({ op: "list", path }, 20000);
export const nativeMkdir = (path) => call({ op: "mkdir", path }, 20000);

/** Self-update of the git-cloned install (see native/updater.py). */
export const nativeUpdateCheck = () => call({ op: "update-check" }, 90000);
export const nativeUpdateApply = () => call({ op: "update-apply" }, 3 * 60 * 1000);

/** Merge-move a finished course tree to its final home. Generous timeout:
 *  moving across drives copies the bytes. */
export const nativeMove = (from, to) => call({ op: "move", from, to }, 30 * 60 * 1000);

/** Which of these absolute paths already exist as non-empty files.
 *  Returns a { path: size|false } map; {} if the helper is unavailable. */
export async function nativeExists(paths) {
  try { const r = await call({ op: "exists", paths }, 20000); return (r && r.present) || {}; }
  catch { return {}; }
}

/**
 * Stream a file to disk through a persistent native-messaging port, writing it
 * straight to `path` — no chrome.downloads, so Brave never shows a Save As
 * dialog. `getNextChunk()` returns the next base64 chunk, or null when done.
 */
export function nativeWriteFile(path, getNextChunk, id = `w${Date.now()}-${Math.floor(Math.random() * 1e6)}`) {
  return new Promise((resolve, reject) => {
    let port;
    try { port = chrome.runtime.connectNative(HOST); } catch (err) { reject(err); return; }
    let done = false;
    let pending = null;
    const finish = (fn, arg) => { if (done) return; done = true; try { port.disconnect(); } catch { /* already gone */ } fn(arg); };
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      finish(reject, new Error((err && err.message) || "the helper disconnected — is it installed?"));
    });
    port.onMessage.addListener((msg) => { const p = pending; pending = null; if (p) p(msg); });
    const send = (m) => new Promise((res, rej) => { pending = res; try { port.postMessage(m); } catch (err) { rej(err); } });
    (async () => {
      let r = await send({ op: "write-begin", id, path });
      if (!r || !r.ok) throw new Error((r && r.error) || "write-begin failed");
      for (;;) {
        const b64 = await getNextChunk();
        if (!b64) break;
        r = await send({ op: "write-chunk", id, b64 });
        if (!r || !r.ok) throw new Error((r && r.error) || "write-chunk failed");
      }
      r = await send({ op: "write-end", id });
      if (!r || !r.ok) throw new Error((r && r.error) || "write-end failed");
      finish(resolve, r);
    })().catch((err) => finish(reject, err instanceof Error ? err : new Error(String(err))));
  });
}
