# -*- coding: utf-8 -*-
"""Widevine DRM download + decrypt for the container/Docker path.

Mirrors the browser extension's proven flow (extension/dash.js, wvcdm.js,
cenc.js, udemy-api.js) but uses the standard Python toolchain:

  * pywidevine  -> build the Widevine challenge from the user's own L3 .wvd
                   device and parse the license into KID:KEY content keys
  * mp4decrypt  -> decrypt each fMP4 track (cenc AES-CTR or cbcs AES-CBC)
  * ffmpeg      -> mux the decrypted video + audio into the final .mp4

Nothing is hardcoded: the .wvd device path is supplied by the caller (CLI
--wvd / env UDEMY_WVD), the per-asset license token is minted fresh from the
single-asset endpoint right before licensing, and content keys come from the
live license response.

pywidevine is imported lazily so this module imports cleanly even where the
package is not installed (e.g. a dev checkout without the DRM extras); in that
case load_cdm() simply returns None and the caller falls back to skipping.
"""

import base64
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import urllib.parse
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger("udemy-downloader")

WV_SYSTEM_ID = "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"

# The real Widevine license endpoint, confirmed by sniffing the player. NOT the
# old /api-2.0/.../validate-auth/widevine/ path. It authenticates with the
# per-asset JWT in auth_token plus the existing Udemy session (cookies/bearer).
LICENSE_URL_TEMPLATE = (
    "https://www.udemy.com/media-license-server/validate-auth-token"
    "?drm_type=widevine&auth_token={token}"
)


# --------------------------------------------------------------------------- #
# CDM (pywidevine) — loaded from the user's own L3 .wvd device file
# --------------------------------------------------------------------------- #
def load_cdm(wvd_path):
    """Return a pywidevine Cdm built from the .wvd device, or None.

    None means "skip DRM cleanly" — missing path, missing file, or pywidevine
    not installed. Never raises.
    """
    if not wvd_path:
        return None
    if not os.path.isfile(wvd_path):
        logger.warning("DRM: .wvd device file not found at %s — skipping DRM", wvd_path)
        return None
    try:
        from pywidevine.cdm import Cdm
        from pywidevine.device import Device
    except Exception as exc:  # pragma: no cover - import-time only
        logger.error("DRM: pywidevine not available (%s) — skipping DRM", exc)
        return None
    try:
        device = Device.load(wvd_path)
        cdm = Cdm.from_device(device)
        logger.info("DRM: loaded L3 CDM from %s", os.path.basename(wvd_path))
        return cdm
    except Exception as exc:
        logger.error("DRM: failed to load .wvd device (%s) — skipping DRM", exc)
        return None


def fetch_fresh_token(session, portal, asset_id):
    """Mint a fresh per-asset media_license_token.

    The bulk-curriculum token's JWT exp is ~5 min, so a big course outruns it.
    Fetching the single asset right before licensing returns one valid now.
    """
    if not asset_id:
        return None
    url = (
        f"https://{portal}.udemy.com/api-2.0/assets/{asset_id}/"
        "?fields[asset]=media_license_token"
    )
    try:
        resp = session._get(url)
        data = resp.json()
        return (data or {}).get("media_license_token")
    except Exception as exc:
        logger.warning("DRM: could not fetch fresh license token: %s", exc)
        return None


def get_content_keys(cdm, pssh_b64, license_token, session):
    """Run the Widevine handshake and return [(kid_hex, key_hex), ...].

    Posts the raw challenge to the Udemy license server using the existing
    session (so cookies / bearer ride along, exactly as the extension does with
    credentials:'include').
    """
    from pywidevine.pssh import PSSH

    license_url = LICENSE_URL_TEMPLATE.format(
        token=urllib.parse.quote(license_token, safe="")
    )

    session_id = cdm.open()
    try:
        pssh = PSSH(pssh_b64)
        # privacy_mode would need a service certificate we don't fetch; the
        # player/extension licenses without it.
        challenge = cdm.get_license_challenge(
            session_id, pssh, "STREAMING", privacy_mode=False
        )
        resp = session._post(license_url, data=challenge)
        status = getattr(resp, "status_code", None)
        if status != 200:
            raise RuntimeError(f"license server HTTP {status}")
        body = resp.content

        # Some deployments wrap the license in JSON/base64 — mirror cenc/wvcdm.
        if body[:1] in (b"{", b"["):
            parsed = json.loads(body.decode("utf-8", "ignore"))
            wrapped = (
                parsed.get("license")
                or parsed.get("License")
                or (parsed.get("msg") or {}).get("license")
            )
            if wrapped:
                body = base64.b64decode(wrapped)

        cdm.parse_license(session_id, body)
        keys = [
            (key.kid.hex, key.key.hex())
            for key in cdm.get_keys(session_id)
            if key.type == "CONTENT"
        ]
        return keys
    finally:
        try:
            cdm.close(session_id)
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# DASH MPD parsing — faithful port of extension/dash.js
# --------------------------------------------------------------------------- #
def _ln(tag):
    return tag.split("}")[-1]


def _children(el, name):
    return [c for c in list(el) if _ln(c.tag) == name]


def _child(el, name):
    found = _children(el, name)
    return found[0] if found else None


def _iter(root, name):
    return [e for e in root.iter() if _ln(e.tag) == name]


def _urljoin(base, rel):
    try:
        return urllib.parse.urljoin(base, rel)
    except Exception:
        return rel


def _iso8601_seconds(text):
    if not text:
        return 0
    m = re.search(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?", text.strip())
    if not m:
        return 0
    d, h, mi, s = (float(x) if x else 0 for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + s


def _max_height(quality):
    if quality in (None, "", "best", "auto", "max"):
        return None
    m = re.search(r"(\d{3,4})", str(quality))
    return int(m.group(1)) if m else None


def _pad(n, fmt):
    width = int(re.search(r"%0(\d+)d", fmt).group(1))
    return str(n).zfill(width)


def _sub(template, rep_id, bw, number=None, time=None):
    out = template.replace("$RepresentationID$", rep_id).replace("$Bandwidth$", str(bw))
    if number is not None:
        out = re.sub(
            r"\$Number(%0\d+d)?\$",
            lambda m: _pad(number, m.group(1)) if m.group(1) else str(number),
            out,
        )
    if time is not None:
        out = re.sub(
            r"\$Time(%0\d+d)?\$",
            lambda m: _pad(time, m.group(1)) if m.group(1) else str(time),
            out,
        )
    return out.replace("$$", "$")


def _ctype(aset, rep):
    blob = " ".join(
        v
        for v in (
            aset.get("contentType"),
            aset.get("mimeType"),
            rep.get("mimeType"),
        )
        if v
    ).lower()
    if (
        "video" in blob
        or rep.get("width")
        or rep.get("height")
        or rep.get("frameRate")
    ):
        return "video"
    if (
        "audio" in blob
        or rep.get("audioSamplingRate")
        or _child(aset, "AudioChannelConfiguration") is not None
    ):
        return "audio"
    if "text" in blob or "ttml" in blob or "vtt" in blob:
        return "text"
    return "audio" if (aset.get("lang") and not rep.get("width")) else "video"


def _base_for(aset, rep, base_url):
    base = base_url
    for el in (aset, rep):
        b = _child(el, "BaseURL")
        if b is not None and (b.text or "").strip():
            base = _urljoin(base, b.text.strip())
    return base


def _rep_info(aset, rep, base_url, total):
    rep_id = rep.get("id") or ""
    bw = int(rep.get("bandwidth") or 0)
    base = _base_for(aset, rep, base_url)
    info = {
        "id": rep_id,
        "bandwidth": bw,
        "height": rep.get("height") or aset.get("maxHeight"),
        "lang": rep.get("lang") or aset.get("lang") or "",
        "mime": rep.get("mimeType") or aset.get("mimeType") or "",
        "init": None,
        "segments": [],
        "single_file": False,
    }

    tmpl = _child(rep, "SegmentTemplate") or _child(aset, "SegmentTemplate")
    if tmpl is not None:
        init_t = tmpl.get("initialization") or ""
        media_t = tmpl.get("media") or ""
        start = int(tmpl.get("startNumber") or 1)
        timeline = _child(tmpl, "SegmentTimeline")
        if init_t:
            info["init"] = _urljoin(base, _sub(init_t, rep_id, bw))
        if timeline is not None:
            number, time = start, 0
            for s in _children(timeline, "S"):
                t = s.get("t")
                if t is not None:
                    time = int(t)
                d = int(s.get("d"))
                r = int(s.get("r") or 0)
                for _ in range(r + 1):
                    info["segments"].append(
                        _urljoin(base, _sub(media_t, rep_id, bw, number, time))
                    )
                    number += 1
                    time += d
        else:
            ts = int(tmpl.get("timescale") or 1)
            seg_dur = int(tmpl.get("duration") or 0)
            count = 0
            if seg_dur > 0 and total > 0:
                count = int(-(-total // (seg_dur / ts)))  # ceil
            for n in range(start, start + count):
                info["segments"].append(_urljoin(base, _sub(media_t, rep_id, bw, n)))
        return info

    seglist = _child(rep, "SegmentList")
    if seglist is not None:
        init = _child(seglist, "Initialization")
        if init is not None and init.get("sourceURL"):
            info["init"] = _urljoin(base, init.get("sourceURL"))
        for su in _children(seglist, "SegmentURL"):
            if su.get("media"):
                info["segments"].append(_urljoin(base, su.get("media")))
        return info

    # SegmentBase / plain BaseURL: the whole representation is one file.
    info["segments"] = [base]
    info["single_file"] = True
    return info


def _find_pssh(root):
    for cp in _iter(root, "ContentProtection"):
        if WV_SYSTEM_ID in (cp.get("schemeIdUri") or "").lower():
            for c in list(cp):
                if _ln(c.tag) == "pssh" and (c.text or "").strip():
                    return c.text.strip()
    return None


def parse_mpd(mpd_text, base_url, quality):
    """Return {video, audio, subs, pssh} for the best tracks under `quality`."""
    root = ET.fromstring(mpd_text)
    periods = _iter(root, "Period")
    if not periods:
        raise RuntimeError("MPD has no Period")
    if len(periods) > 1:
        periods = [
            max(periods, key=lambda p: _iso8601_seconds(p.get("duration")))
        ]
    period = periods[0]
    total = _iso8601_seconds(
        root.get("mediaPresentationDuration")
    ) or _iso8601_seconds(period.get("duration"))

    videos, audios, subs = [], [], []
    for aset in _children(period, "AdaptationSet"):
        for rep in _children(aset, "Representation"):
            kind = _ctype(aset, rep)
            info = _rep_info(aset, rep, base_url, total)
            info["kind"] = kind
            (videos if kind == "video" else audios if kind == "audio" else subs).append(
                info
            )

    if not videos:
        raise RuntimeError("no video representation in MPD")

    cap = _max_height(quality)
    vids = videos
    if cap:
        fits = [v for v in videos if v["height"] and int(v["height"]) <= cap]
        vids = fits or videos
    video = max(vids, key=lambda v: v["bandwidth"])
    audio = max(audios, key=lambda a: a["bandwidth"]) if audios else None

    return {
        "video": video,
        "audio": audio,
        "subs": subs,
        "pssh": _find_pssh(root),
    }


# --------------------------------------------------------------------------- #
# Download / decrypt / mux
# --------------------------------------------------------------------------- #
def _download_segments(session, track, work_dir, tag, workers):
    """Download init + media segments and concatenate into one encrypted file."""
    urls = []
    if track.get("init"):
        urls.append(track["init"])
    urls.extend(track["segments"])
    if not urls:
        raise RuntimeError(f"{tag}: no segments to download")

    paths = [os.path.join(work_dir, f"{tag}_{i:06d}.seg") for i in range(len(urls))]

    def fetch(i):
        last = None
        for _ in range(4):
            try:
                resp = session._get(urls[i])
                if getattr(resp, "status_code", None) == 200:
                    with open(paths[i], "wb") as fh:
                        fh.write(resp.content)
                    return
                last = f"HTTP {getattr(resp, 'status_code', '?')}"
            except Exception as exc:
                last = str(exc)
        raise RuntimeError(f"{tag} segment {i} failed ({urls[i]}): {last}")

    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        # list() forces exceptions from workers to surface here
        list(ex.map(fetch, range(len(urls))))

    enc_path = os.path.join(work_dir, f"{tag}_enc.mp4")
    with open(enc_path, "wb") as dst:
        for p in paths:
            with open(p, "rb") as src:
                shutil.copyfileobj(src, dst)
            os.remove(p)
    return enc_path


def _mp4decrypt(in_path, out_path, keys):
    cmd = ["mp4decrypt"]
    for kid, key in keys:
        cmd += ["--key", f"{kid}:{key}"]
    cmd += [in_path, out_path]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0 or not os.path.isfile(out_path):
        raise RuntimeError(
            "mp4decrypt failed: "
            + (proc.stderr or b"").decode("utf-8", "ignore")[:500]
        )


def _mux(video_path, audio_path, out_path):
    cmd = ["ffmpeg", "-y", "-i", video_path]
    if audio_path:
        cmd += ["-i", audio_path]
    cmd += ["-c", "copy"]
    if audio_path:
        cmd += ["-map", "0:v:0", "-map", "1:a:0"]
    cmd += [
        "-f",
        "mp4",
        "-metadata",
        'comment="Downloaded with Udemy-Downloader (DRM)"',
        out_path,
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0 or not os.path.isfile(out_path):
        raise RuntimeError(
            "ffmpeg mux failed: " + (proc.stderr or b"").decode("utf-8", "ignore")[:500]
        )


def download_drm_lecture(
    session,
    portal,
    cdm,
    asset_id,
    dash_url,
    out_path,
    quality="best",
    concurrent_downloads=10,
    fallback_token=None,
):
    """Download, decrypt and mux one DRM lecture to out_path (.mp4).

    Returns True on success, False if it was skipped/failed (logged). Never
    raises to the caller.
    """
    tag = f"asset {asset_id}"
    try:
        logger.info("      > [DRM] %s: fetching DASH manifest", tag)
        mpd_resp = session._get(dash_url)
        if getattr(mpd_resp, "status_code", None) != 200:
            raise RuntimeError(f"manifest HTTP {getattr(mpd_resp, 'status_code', '?')}")
        parsed = parse_mpd(mpd_resp.text, dash_url, quality)
        pssh_b64 = parsed["pssh"]
        if not pssh_b64:
            raise RuntimeError("no Widevine PSSH in manifest")
        video, audio = parsed["video"], parsed["audio"]
        logger.info(
            "      > [DRM] %s: manifest parsed (video %sp / %d seg, audio %s)",
            tag,
            video.get("height") or "?",
            len(video["segments"]) + (1 if video.get("init") else 0),
            "yes" if audio else "none",
        )

        token = fetch_fresh_token(session, portal, asset_id) or fallback_token
        if not token:
            raise RuntimeError("no media_license_token available")
        logger.info("      > [DRM] %s: license token minted", tag)

        keys = get_content_keys(cdm, pssh_b64, token, session)
        if not keys:
            raise RuntimeError("license returned no content keys")
        logger.info("      > [DRM] %s: license OK, %d content key(s)", tag, len(keys))

        work_dir = tempfile.mkdtemp(prefix="uddrm_", dir=os.path.dirname(out_path) or None)
        try:
            logger.info("      > [DRM] %s: downloading + decrypting video track", tag)
            v_enc = _download_segments(
                session, video, work_dir, "video", concurrent_downloads
            )
            v_dec = os.path.join(work_dir, "video_dec.mp4")
            _mp4decrypt(v_enc, v_dec, keys)

            a_dec = None
            if audio:
                logger.info(
                    "      > [DRM] %s: downloading + decrypting audio track", tag
                )
                a_enc = _download_segments(
                    session, audio, work_dir, "audio", concurrent_downloads
                )
                a_dec = os.path.join(work_dir, "audio_dec.mp4")
                _mp4decrypt(a_enc, a_dec, keys)

            logger.info("      > [DRM] %s: muxing to %s", tag, os.path.basename(out_path))
            _mux(v_dec, a_dec, out_path)
            logger.info("      > [DRM] %s: done", tag)
            return True
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)
    except Exception as exc:
        logger.error("      > [DRM] %s failed: %s", tag, exc)
        return False
