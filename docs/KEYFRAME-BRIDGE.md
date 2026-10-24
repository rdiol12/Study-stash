# Keyframe bridge — how it works (self-contained engine)

The bridge adds DRM download/decryption and an unattended watchlist to the
extension. It is **this project's own code** — there is no external downloader.
Python can't run in the browser, so the extension talks to a small native helper
that does the work and reports progress back.

## The moving parts

```
 ┌── Brave/Chrome ─────────────┐     native messaging      ┌── your machine ───────────────┐
 │ extension (MV3)             │     (stdio JSON)          │ keyframe_bridge.py            │
 │  • keyframe.js ── connectNative ──────────────────────▶ │  • service.py   (dispatch)    │
 │  • content-vv.js (button)   │                           │  • jobs.py      (SQLite)      │
 │  • keyframe.html (UI)       │                           │  • native_engine.py  ─────────┼─▶ ffmpeg / mp4decrypt
 │  • background.js (router)   │                           │  • vault.py / errors.py       │   pywidevine + your .wvd
 │  • player.js (offline play) │                           └───────────────────────────────┘
 └─────────────────────────────┘                                   writes into the media root
```

- **`native_engine.py`** is the engine. Non-DRM HLS/DASH/MP4 is handed to
  **ffmpeg** (it fetches + muxes in one pass). Widevine DASH is ours: parse the
  MPD, pull the PSSH, get content keys from your CDM via **pywidevine**, download
  the selected video+audio segments, decrypt with **mp4decrypt** (Bento4), mux
  with ffmpeg.
- **`service.py`** runs jobs on a thread pool, persists them to SQLite, caches
  keys in the vault, and does retry/backoff + idempotency.
- The extension side is unchanged in shape: a connectNative client, a `vv:*`
  message router, the live UI, and player registration.

## A DRM download, start to finish

1. Press the injected **Download** button on a provider page (or submit a URL in
   the Keyframe page).
2. The bridge creates a job and a worker picks it up. First ever download also
   pip-installs `pywidevine` automatically (the only self-install step).
3. For DRM it fetches the MPD, extracts the Widevine PSSH, and runs **one license
   exchange through your CDM** to get the content keys — which it caches in the
   vault, so a repeat never hits the license server again.
4. It downloads the best video + an audio track, `mp4decrypt`s them with the
   keys, and muxes to an `.mkv` in the media root.
5. Progress (percent/phase) streams back as events; on success the extension adds
   a card to **My courses**. Press play.

## Autonomy & the injected button (sniffer)

Because the self-contained engine has no provider extractors, "one press on any
DRM page" is powered by a **stream sniffer** (`sniffer.js`, opted into). While
you watch a page, the background records the **DASH/HLS manifest request** and
the **DRM license request** for that tab, so the injected ⬇ button can hand the
engine everything it needs with no URL entry.

Scope (kept deliberately tight):

- Only manifest and license requests are recorded — ordinary page traffic is
  ignored.
- Only the headers needed to replay them are kept (`Authorization`, `Cookie`,
  `User-Agent`, `Referer`, `Origin`, `X-*`). **Never request/response bodies.**
- Records live per-tab in memory + `chrome.storage.session`, and are dropped
  when the tab closes. Nothing is written to disk.
- The capture is only ever sent to the **local** bridge, never anywhere else.

This requires the `webRequest` permission and `*://*/*` host access (the button
can't know in advance which site has a stream). If that surface is more than you
want, delete `sniffer.js` + its `initSniffer()` call and drive the engine from
the Keyframe page with a pasted manifest URL instead.

## Crash / MV3 resilience

Every job is a SQLite row. If the service worker recycles and the native port
drops, running downloads keep going (the host lingers until they finish) and
interrupted ones are re-queued and drained on reconnect. Existing files are
skipped (idempotent), so resume never duplicates. WAL + atomic job-claim make a
second bridge instance safe.

## Setup

1. Install **Python 3.11+**, **ffmpeg**, and **mp4decrypt** (Bento4) on PATH.
   Optionally **shaka-packager** (its `packager` binary) — only to decrypt
   **WebM/Matroska** CENC (Opus/VP9); MP4 sources like Udemy use mp4decrypt.
   Binaries may instead be dropped in `~/.keyframe-bridge/bin`, which the host
   prepends to PATH automatically.
2. Register the host once (your extension ID from `brave://extensions`):
   ```
   powershell -ExecutionPolicy Bypass -File native\install-keyframe.ps1 -ExtensionId <id>
   ```
   The installer auto-selects a suitable Python (3.11+ that can import the host,
   preferring one that already has pywidevine). If it picks the wrong one — e.g. a
   bare Anaconda without the deps — pass `-Python C:\path\to\python.exe`.
3. Restart the browser → extension → **Keyframe (DRM)** → **Set up engine**
   (pip-installs pywidevine).
4. Drop your own `.wvd` CDM device file in `~/.keyframe-bridge/cdm`, then
   **Re-check CDM**.
5. Press Download. No terminal, no keys to paste.

The engine's health check reports exactly which of ffmpeg / mp4decrypt /
packager / pywidevine / CDM is present (packager is optional).

## Config & env overrides

`~/.keyframe-bridge/config.toml` (copy `config.toml.sample`). Overrides:
`KEYFRAME_OUTPUT_ROOT` (media root), `KEYFRAME_BRIDGE_TOKEN` (HTTP token),
`KEYFRAME_BRIDGE_PORT`, `KEYFRAME_BRIDGE_CONFIG`.

## License reality (read this)

`pywidevine` is **GPL-3.0**. Because `native_engine.py` imports it in-process,
the Python bridge is effectively **GPL-3.0 when the DRM path is used** — the
Widevine CDM primitive is GPL no matter who wrote the surrounding code. The
extension and non-DRM paths stay MIT.

If you want the bridge itself to remain non-GPL, isolate the CDM step: run the
pywidevine call in a **separate short-lived subprocess** (a tiny helper script)
instead of importing it here. Then only that helper is GPL, exactly as a
separate program — the same license boundary the original Keyframe integration
used. That refactor is localized to `native_engine.widevine_keys()`.
