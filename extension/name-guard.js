// Forces the filename of downloads this extension starts, and only those.
//
// Why it exists: chrome.downloads.download() accepted our full relative path
// without error, then saved blob downloads as "<uuid>.mp4" anyway — measured,
// entries recorded sent-vs-got. onDeterminingFilename runs at the moment the
// browser decides the name and its suggestion wins over the default, so the
// path is enforced here rather than merely requested at download() time.

const pending = new Map(); // url -> relative path

export function registerDownloadName(url, path) {
  pending.set(url, path);
  // self-expire: if determination never fires, don't leak forever
  setTimeout(() => pending.delete(url), 10 * 60 * 1000);
}

let installed = false;

export function installNameGuard() {
  if (installed || !chrome.downloads || !chrome.downloads.onDeterminingFilename) return;
  installed = true;
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    // Only downloads this extension started are ours to name. Anything the
    // user starts (any site, any blob/data export) keeps the browser's own
    // name and default download folder. byExtensionId is how Chromium marks
    // the origin; if a browser leaves it unset we still only rename URLs we
    // registered ourselves.
    const byOther = item.byExtensionId !== undefined && item.byExtensionId !== chrome.runtime.id;
    if (byOther || item.byExtensionId === undefined && !isPending(item)) {
      suggest();
      return;
    }
    // Match on both fields: blob/data downloads can report the lookup key under
    // either item.url or item.finalUrl, and a miss here is what makes Brave fall
    // back to the Save As chooser.
    const want = pending.get(item.url) || pending.get(item.finalUrl);
    if (want) {
      pending.delete(item.url);
      pending.delete(item.finalUrl);
      suggest({ filename: want, conflictAction: "overwrite" });
      return;
    }
    const u = item.finalUrl || item.url || "";
    if (/^(blob|data):/i.test(u)) {
      // One of ours whose registration was lost: a blob/data URL has no
      // inferable name, so Brave would prompt. Give it a safe fallback name
      // instead of ever showing the chooser.
      const ext = /subrip|\.srt/i.test(u) ? "srt" : "mp4";
      suggest({ filename: `keyframe-download-${Date.now()}.${ext}`, conflictAction: "uniquify" });
      return;
    }
    suggest();
  });
}

function isPending(item) {
  return pending.has(item.url) || pending.has(item.finalUrl);
}
