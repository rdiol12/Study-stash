// Stream sniffer — the one-press autonomy path (you opted into this).
//
// Scope, kept deliberately tight:
//   * Only DASH/HLS manifest requests and DRM license requests are recorded.
//     Ordinary page traffic is ignored.
//   * Only the headers needed to re-fetch those (auth / cookie / UA / referer /
//     origin / x-*) are kept — never request bodies, never response bodies.
//   * Records live per-tab in memory, mirrored to chrome.storage.session, and
//     are dropped when the tab closes. Nothing is persisted to disk.
//   * The capture is only ever handed to the LOCAL bridge (native host /
//     127.0.0.1), never anywhere else.
//
// This is what turns "a DRM page you're watching" into the manifest URL +
// license endpoint + headers our own engine needs.

const MANIFEST_RE = /\.(mpd|m3u8)(\?|$)/i;
const LICENSE_RE = /(license|licence|getlicense|get_license|widevine|playready|wvlicense|\/wv\/|acquirelicense|\/cenc|drm[/_])/i;
const KEEP_HEADER = /^(authorization|cookie|user-agent|referer|origin|accept|accept-language|x-)/i;
const SESSION_KEY = "keyframe.sniff";

const perTab = new Map(); // tabId -> { manifests:[{url,type,headers,ts}], licenses:[{url,headers,ts}] }
const MAX = 12;

function slot(tabId) {
  if (!perTab.has(tabId)) perTab.set(tabId, { manifests: [], licenses: [] });
  return perTab.get(tabId);
}

function keepHeaders(requestHeaders) {
  return (requestHeaders || [])
    .filter((h) => KEEP_HEADER.test(h.name))
    .map((h) => `${h.name}: ${h.value}`);
}

function mirror(tabId) {
  const s = perTab.get(tabId);
  if (!s) return;
  const manifest = s.manifests[s.manifests.length - 1] || null;
  const license = s.licenses[s.licenses.length - 1] || null;
  chrome.storage.session.get(SESSION_KEY)
    .then((got) => {
      const all = got[SESSION_KEY] || {};
      all[tabId] = { manifest, license, ts: Date.now() };
      return chrome.storage.session.set({ [SESSION_KEY]: all });
    })
    .catch(() => {});
}

function onRequest(d) {
  if (d.tabId < 0) return;
  if (MANIFEST_RE.test(d.url)) {
    const s = slot(d.tabId);
    if (!s.manifests.some((m) => m.url === d.url)) {
      s.manifests.push({ url: d.url, type: /\.mpd/i.test(d.url) ? "dash" : "hls", headers: [], ts: Date.now() });
      if (s.manifests.length > MAX) s.manifests.shift();
      mirror(d.tabId);
    }
  } else if (d.method === "POST" && LICENSE_RE.test(d.url)) {
    const s = slot(d.tabId);
    if (!s.licenses.some((l) => l.url === d.url)) {
      s.licenses.push({ url: d.url, headers: [], ts: Date.now() });
      if (s.licenses.length > MAX) s.licenses.shift();
      mirror(d.tabId);
    }
  }
}

function onHeaders(d) {
  if (d.tabId < 0) return;
  const s = perTab.get(d.tabId);
  if (!s) return;
  const m = s.manifests.find((x) => x.url === d.url);
  if (m && !m.headers.length) { m.headers = keepHeaders(d.requestHeaders); mirror(d.tabId); }
  const l = s.licenses.find((x) => x.url === d.url);
  if (l && !l.headers.length) { l.headers = keepHeaders(d.requestHeaders); mirror(d.tabId); }
}

export function initSniffer() {
  try {
    chrome.webRequest.onBeforeRequest.addListener(onRequest, { urls: ["<all_urls>"] });
    chrome.webRequest.onSendHeaders.addListener(onHeaders, { urls: ["<all_urls>"] },
      ["requestHeaders", "extraHeaders"]);
    chrome.tabs.onRemoved.addListener((tabId) => {
      perTab.delete(tabId);
      chrome.storage.session.get(SESSION_KEY)
        .then((got) => { const a = got[SESSION_KEY] || {}; delete a[tabId]; return chrome.storage.session.set({ [SESSION_KEY]: a }); })
        .catch(() => {});
    });
  } catch (err) {
    console.warn("sniffer init failed:", err && err.message);
  }
}

/** Best stream for a tab: newest manifest + newest license seen. Falls back to
 *  the session mirror after a service-worker recycle. */
export async function streamForTab(tabId) {
  let s = perTab.get(tabId);
  if (!s || !s.manifests.length) {
    const got = await chrome.storage.session.get(SESSION_KEY).catch(() => ({}));
    const e = (got[SESSION_KEY] || {})[tabId];
    if (!e || !e.manifest) return null;
    return pack(e.manifest, e.license);
  }
  return pack(s.manifests[s.manifests.length - 1], s.licenses[s.licenses.length - 1] || null);
}

function pack(manifest, license) {
  return {
    url: manifest.url,
    type: manifest.type || "auto",
    headers: manifest.headers || [],
    license_url: license ? license.url : undefined,
    license_headers: license ? license.headers : [],
    drm: license ? "widevine" : undefined,
  };
}

export async function hasStream(tabId) {
  const s = await streamForTab(tabId);
  return !!(s && s.url);
}
