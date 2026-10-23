// Forces the filename of downloads this extension starts.
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
    const url = item.finalUrl || item.url;
    const want = pending.get(url);
    if (want) {
      pending.delete(url);
      suggest({ filename: want, conflictAction: "overwrite" });
    } else {
      // not ours — leave the browser's choice untouched
      suggest();
    }
  });
}
