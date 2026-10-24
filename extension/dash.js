// DASH MPD parsing in JS — faithful port of native_engine.parse_mpd.
// Returns per-track init+segment URLs, the Widevine PSSH init_data, and (if
// present) the license URL. Uses DOMParser (available in the offscreen document).
(function (root) {
  "use strict";
  const WV_SYSTEM_ID = "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed";
  const u32 = (b, o) => (b[o] * 2 ** 24) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];

  function b64ToU8(b64) {
    const bin = atob(b64); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  const tag = (el) => el.localName || el.tagName.split(":").pop();
  const urljoin = (base, rel) => { try { return new URL(rel, base).href; } catch { return rel; } };
  const elems = (el) => Array.from(el.childNodes || []).filter((n) => n.nodeType === 1);

  function iso8601(text) {
    if (!text) return 0;
    const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/.exec(text.trim());
    if (!m) return 0;
    const [d, h, mi, s] = m.slice(1).map((x) => (x ? parseFloat(x) : 0));
    return d * 86400 + h * 3600 + mi * 60 + s;
  }
  function maxHeight(q) {
    if (!q || ["best", "auto", "max", ""].includes(String(q).toLowerCase())) return null;
    const m = /(\d{3,4})/.exec(String(q)); return m ? parseInt(m[1]) : null;
  }
  function children(el, name) { return elems(el).filter((c) => tag(c) === name); }
  function child(el, name) { return children(el, name)[0] || null; }

  function sub(t, repId, bw, number, time) {
    let out = t.replaceAll("$RepresentationID$", repId).replaceAll("$Bandwidth$", String(bw));
    if (number != null) out = out.replace(/\$Number(%0\d+d)?\$/g, (_, f) => f ? pad(number, f) : String(number));
    if (time != null) out = out.replace(/\$Time(%0\d+d)?\$/g, (_, f) => f ? pad(time, f) : String(time));
    return out.replaceAll("$$", "$");
  }
  function pad(n, fmt) { const w = parseInt(/%0(\d+)d/.exec(fmt)[1]); return String(n).padStart(w, "0"); }

  function ctype(aset, rep) {
    const blob = [aset.getAttribute("contentType"), aset.getAttribute("mimeType"), rep.getAttribute("mimeType")]
      .filter(Boolean).join(" ").toLowerCase();
    if (blob.includes("video") || rep.getAttribute("width") || rep.getAttribute("height") || rep.getAttribute("frameRate")) return "video";
    if (blob.includes("audio") || rep.getAttribute("audioSamplingRate") || child(aset, "AudioChannelConfiguration")) return "audio";
    if (blob.includes("text") || blob.includes("ttml") || blob.includes("vtt")) return "text";
    return (aset.getAttribute("lang") && !rep.getAttribute("width")) ? "audio" : "video";
  }

  function baseFor(aset, rep, baseUrl) {
    let base = baseUrl;
    for (const el of [aset, rep]) { const b = child(el, "BaseURL"); if (b && b.textContent.trim()) base = urljoin(base, b.textContent.trim()); }
    return base;
  }

  function repInfo(aset, rep, baseUrl, total) {
    const repId = rep.getAttribute("id") || "";
    const bw = parseInt(rep.getAttribute("bandwidth") || "0") || 0;
    const base = baseFor(aset, rep, baseUrl);
    const info = {
      id: repId, bandwidth: bw,
      height: rep.getAttribute("height") || aset.getAttribute("maxHeight"),
      lang: rep.getAttribute("lang") || aset.getAttribute("lang") || "",
      mime: rep.getAttribute("mimeType") || aset.getAttribute("mimeType") || "",
      init: null, segments: [],
    };
    const tmpl = child(rep, "SegmentTemplate") || child(aset, "SegmentTemplate");
    if (tmpl) {
      const initT = tmpl.getAttribute("initialization") || "";
      const mediaT = tmpl.getAttribute("media") || "";
      const start = parseInt(tmpl.getAttribute("startNumber") || "1") || 1;
      const timeline = child(tmpl, "SegmentTimeline");
      if (initT) info.init = urljoin(base, sub(initT, repId, bw));
      if (timeline) {
        let number = start, time = 0;
        for (const s of children(timeline, "S")) {
          const t = s.getAttribute("t"); if (t != null) time = parseInt(t);
          const d = parseInt(s.getAttribute("d"));
          const r = parseInt(s.getAttribute("r") || "0") || 0;
          for (let k = 0; k <= r; k++) { info.segments.push(urljoin(base, sub(mediaT, repId, bw, number, time))); number++; time += d; }
        }
      } else {
        const ts = parseInt(tmpl.getAttribute("timescale") || "1") || 1;
        const segDur = parseInt(tmpl.getAttribute("duration") || "0") || 0;
        let count = 0;
        if (segDur > 0 && total > 0) count = Math.ceil(total / (segDur / ts));
        for (let n = start; n < start + count; n++) info.segments.push(urljoin(base, sub(mediaT, repId, bw, n)));
      }
      return info;
    }
    const seglist = child(rep, "SegmentList");
    if (seglist) {
      const init = child(seglist, "Initialization");
      if (init && init.getAttribute("sourceURL")) info.init = urljoin(base, init.getAttribute("sourceURL"));
      for (const su of children(seglist, "SegmentURL")) if (su.getAttribute("media")) info.segments.push(urljoin(base, su.getAttribute("media")));
      return info;
    }
    info.segments = [base]; info.single_file = true;
    return info;
  }

  function allDesc(root, name) { return Array.from(root.getElementsByTagName("*")).filter((e) => tag(e) === name); }

  function findPsshBox(doc) {
    for (const cp of allDesc(doc, "ContentProtection")) {
      if ((cp.getAttribute("schemeIdUri") || "").toLowerCase().includes(WV_SYSTEM_ID)) {
        for (const c of elems(cp)) if (tag(c) === "pssh" && c.textContent.trim()) return c.textContent.trim();
      }
    }
    return null;
  }
  function psshInitData(boxB64) {
    const box = b64ToU8(boxB64);
    let o = 8; const version = box[o]; o += 4; o += 16; // version+flags, systemid
    if (version > 0) { const kc = u32(box, o); o += 4 + 16 * kc; }
    const dlen = u32(box, o); o += 4;
    return box.subarray(o, o + dlen);
  }
  function findLicenseUrl(doc) {
    for (const el of Array.from(doc.getElementsByTagName("*"))) if (tag(el).toLowerCase() === "laurl" && el.textContent.trim()) return el.textContent.trim();
    for (const cp of allDesc(doc, "ContentProtection")) {
      if (!(cp.getAttribute("schemeIdUri") || "").toLowerCase().includes(WV_SYSTEM_ID)) continue;
      for (const a of ["licenseUrl", "licenseServerUrl", "ms:laurl"]) if (cp.getAttribute(a)) return cp.getAttribute(a);
    }
    return null;
  }

  function parseMPD(mpdText, baseUrl, quality) {
    const doc = new DOMParser().parseFromString(mpdText, "application/xml");
    const mpd = doc.documentElement;
    let periods = allDesc(doc, "Period");
    if (!periods.length) throw new Error("MPD has no Period");
    if (periods.length > 1) periods = [periods.reduce((a, b) => (iso8601(a.getAttribute("duration")) >= iso8601(b.getAttribute("duration")) ? a : b))];
    const period = periods[0];
    const total = iso8601(mpd.getAttribute("mediaPresentationDuration")) || iso8601(period.getAttribute("duration"));
    const psshBox = findPsshBox(doc);

    const videos = [], audios = [], subs = [];
    for (const aset of children(period, "AdaptationSet")) {
      for (const rep of children(aset, "Representation")) {
        const kind = ctype(aset, rep);
        const info = repInfo(aset, rep, baseUrl, total); info.kind = kind;
        (kind === "video" ? videos : kind === "audio" ? audios : subs).push(info);
      }
    }
    if (!videos.length) throw new Error("no video representation in MPD");
    const cap = maxHeight(quality);
    let vids = videos;
    if (cap) { const c = videos.filter((v) => v.height && parseInt(v.height) <= cap); vids = c.length ? c : videos; }
    const video = vids.reduce((a, b) => (a.bandwidth >= b.bandwidth ? a : b));
    const audio = audios.length ? audios.reduce((a, b) => (a.bandwidth >= b.bandwidth ? a : b)) : null;

    return {
      video, audio, subs,
      psshBox,
      psshInit: psshBox ? psshInitData(psshBox) : null,
      licenseUrl: findLicenseUrl(doc),
    };
  }

  root.DASH = { parseMPD, psshInitData, b64ToU8 };
})(typeof self !== "undefined" ? self : globalThis);
