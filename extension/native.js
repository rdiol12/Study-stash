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

/** Merge-move a finished course tree to its final home. Generous timeout:
 *  moving across drives copies the bytes. */
export const nativeMove = (from, to) => call({ op: "move", from, to }, 30 * 60 * 1000);
