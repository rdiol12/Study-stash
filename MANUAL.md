# Udemy Downloader Bridge — Setup Manual

A browser extension that downloads Udemy courses you are enrolled in, plays
them back offline with a Udemy-style player (resume, progress ticks, hover
scrub previews, subtitles, interactive quizzes), and optionally pairs with a
Docker service for faster native-ffmpeg 1080p and bulk downloads.

Built on top of [Puyodead1/udemy-downloader](https://github.com/Puyodead1/udemy-downloader)
(MIT). Upstream files are untouched except one two-line ffmpeg-flag fix, so
`git pull` from upstream stays clean.

> Downloading courses is against Udemy's Terms of Service. Use at your own
> risk, for content you are enrolled in. Modes 1–2 do no decryption. Mode 3
> (the Keyframe engine) decrypts DRM content you can already access using **your
> own** Widevine CDM — supply your own device file; this project ships no keys.

---

## Mode 1 — Extension only (no install at all)

1. Clone this repo.
2. `brave://extensions` (or `chrome://extensions`) → enable **Developer mode**
   → **Load unpacked** → select the `extension/` folder.
3. Note the extension's **ID** shown on its card — you'll want it if you add
   the helper later.
4. Open a Udemy course you're enrolled in, click the extension icon (or the
   **⤓ Download course** button injected on the page) and press **Download**.

Files land in a `Courses/` subfolder of the browser's download folder as
`<Course>/01 - Section/001. Lecture name.mp4`. Your other downloads are not
affected.

**Settings that matter (once):**

- `brave://settings/downloads` → **"Ask where to save each file before
  downloading" = OFF**. The save dialog overrides the extension's file naming
  — with it on you get random UUID filenames.
- For the built-in player: extension card → **Details** → **"Allow access to
  file URLs" = ON** (the player streams your downloaded files; thumbnails and
  playback need this). Re-check it after extension updates — permission
  changes reset it.

**What you get in this mode**

| Feature | Extension only |
| --- | --- |
| Video quality | 720p direct, or **1080p** with "1080p in browser mode" ticked (HLS transmuxed in-browser, slower) |
| Captions | `.vtt` files, shown in the player's CC menu |
| Quizzes | interactive HTML players (exam/practice modes, timer, attempts) |
| DRM lectures | skipped (no decryption code in this build) |
| Destination | subfolder of the browser download folder (anywhere with the helper, below) |
| Player | full: library with thumbnails, resume, ✓ per lecture, scrub previews, speed, autoplay |

### Optional add-on: the local helper (move courses anywhere)

A tiny native-messaging host that moves finished courses out of the download
folder to any drive/folder you pick inside the extension. No admin rights;
registers under HKCU only. Requires Python 3 on PATH.

```powershell
powershell -ExecutionPolicy Bypass -File native\install.ps1 -ExtensionId <your extension id>
```

Restart the browser, then: extension **Settings → Test helper** should say
`ready`. Pick a destination via **Save to → Change…** in the popup. Finished
courses are moved there automatically (merge-move; re-downloads land in the
same course folder). The helper only ever receives paths — file bytes never
cross it — and it refuses to touch system directories.

Uninstall: delete the two `NativeMessagingHosts\com.udemy_bridge.host`
registry keys under HKCU and the `native/` generated files.

---

## Mode 2 — Extension + Docker (the full engine)

Everything from Mode 1, plus the upstream Python downloader running as a local
API: real ffmpeg (1080p muxing without in-browser transmuxing) and saving directly to any mounted drive.

### Setup

```powershell
cp .env.sample .env         # then edit:
#   UD_API_TOKEN  -> any random secret (see the comment in the file)
#   UD_LIBRARY_A / UD_LIBRARY_C -> host folders to expose to the folder picker

docker compose -f docker-compose.server.yml up -d
```

Then in the extension popup press **Docker: off → on** (pill should read
`connected`), and paste `UD_API_TOKEN` into **Settings → API token**.

The API listens on `127.0.0.1:8787` only and refuses every request without
the token. Keep it that way — it holds your Udemy session while jobs run.

### GPU encoding

The image ships an nvenc-capable ffmpeg and the compose file reserves the GPU
(`capabilities: [gpu]` — on Docker Desktop/WSL2 it must be exactly that), but
no current code path re-encodes, so this is plumbing for the future rather
than a feature.

### DRM

Not supported: this build contains no decryption code. DRM-protected lectures
are detected and skipped in both modes.

---

## Which mode should I use?

| | Extension only | + Docker |
| --- | --- | --- |
| Install burden | none (helper: one script) | Docker Desktop + image build |
| Max quality | 1080p (in-browser transmux) | 1080p (native ffmpeg, faster) |
| DRM lectures | skipped | skipped |
| Caption format | `.vtt` | `.srt` (converted) |
| Re-running a course | re-downloads | skips existing files |
| Save destination | download folder; anywhere with helper | any mounted drive, picker built in |
| Course player | yes — same player either way | yes |

Short version: **start with the extension alone.** Add the helper when you
want courses on another drive. Add Docker when you want faster, native 1080p.

---

## Mode 3 — DRM via the Keyframe bridge (self-contained)

Downloads and decrypts Widevine DASH with **your own CDM**, using this project's
own engine (no external downloader). Full detail in
[`docs/KEYFRAME-BRIDGE.md`](docs/KEYFRAME-BRIDGE.md); the short version:

1. Install on PATH: **Python 3.11+**, **ffmpeg**, **mp4decrypt** (Bento4).
   Optionally **shaka-packager** — only needed to decrypt **WebM/Matroska** DRM
   (Opus/VP9) sources; Udemy itself is MP4, so mp4decrypt covers it.
2. Register the bridge host once:
   `powershell -ExecutionPolicy Bypass -File native\install-keyframe.ps1 -ExtensionId <id>`
   (auto-picks a suitable Python; add `-Python C:\path\to\python.exe` to force one
   if it grabs the wrong interpreter — e.g. a bare Anaconda without the deps.)
3. Restart the browser → extension → **Keyframe (DRM)** → **Set up engine**
   (installs `pywidevine`).
4. Put your `.wvd` CDM file in `%USERPROFILE%\.keyframe-bridge\cdm` → **Re-check CDM**.
5. Start playing a DRM video on any page; once the stream is detected the
   injected **⬇ Download** button appears. One press resolves keys, decrypts,
   muxes, and the file lands in **My courses**. (Or paste a manifest + license
   URL in the Keyframe page.)

Notes: `pywidevine` is GPL-3.0, so the DRM bridge is effectively GPL-3.0 in use
(see the README license note). The one-press button is powered by a **stream
sniffer** that records the manifest + license request (and the headers needed to
replay them) for the tab you're watching — this needs the `webRequest` + all-URL
permission, keeps nothing on disk, and sends captures only to your local bridge.
See `docs/KEYFRAME-BRIDGE.md` to narrow or remove it.

## Troubleshooting

- **Keyframe page says "bridge down"** → run `native\install-keyframe.ps1` with
  your extension ID, restart the browser.
- **"still needed: ffmpeg / mp4decrypt / pywidevine / a .wvd"** → the engine's
  health check lists exactly what to install; see Mode 3.
- **DRM job fails with "no content keys" / license error** → wrong CDM, or the
  license URL/headers the provider needs weren't supplied.
- **Files get random UUID names** → "Ask where to save each file" is on;
  turn it off (see Mode 1).
- **Player says it can't read course files** → the error shows the exact path
  it tried. If the path is right, enable "Allow access to file URLs" on the
  extension card (it resets whenever permissions change).
- **`Test helper` says not reachable** → re-run `native\install.ps1` with the
  correct `-ExtensionId`, then restart the browser (the registry is read at
  startup).
- **Popup shows `no token` with Docker on** → paste `UD_API_TOKEN` from your
  `.env` into Settings.
- **403 "permission" errors fetching a course** → tick **"Use cookies instead
  of token"** in Advanced; a lone session token is often not enough, the full
  cookie jar is.
- **A course isn't found but you are enrolled** → the instructor renamed it;
  put the course's numeric id in the URL instead of the slug.
- **Container build fails on apt with 404 / hash mismatch** → a middlebox on
  your network is mangling plain-HTTP downloads; the Dockerfile already pins
  HTTPS mirrors, just retry.
