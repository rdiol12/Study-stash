<p align="center"><a href="https://www.buymeacoffee.com/rdiol12" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="60" width="217"></a></p>

<p align="center"><em>If my work helped you, a coffee keeps the next project coming.</em></p>

<div align="center">

# Udemy Downloader Bridge

**Download your Udemy courses. Watch them offline. Keep your progress.**

A browser extension that downloads the courses you're enrolled in decrypts and muxes them entirely in your browser, and
saves them straight to a folder you choose. No cloud, no account, no server.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Extension-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](extension/)
[![Works on Brave / Chrome](https://img.shields.io/badge/Brave%20%2F%20Chrome-supported-FB542B?logo=brave&logoColor=white)](#)

</div>

---

## ⚠️ Disclaimer — read first

- **Bring your own key.** This project ships **no** Widevine CDM. You **must**
  provide your own `.wvd` device file. None is included, none will be shared, and
  requests for one will be ignored. Where/how you obtain it is entirely your
  responsibility.
- **No support.** This is provided as-is. No help, troubleshooting, or
  installation support will be given. Issues/requests for keys or support will
  not be answered.
- **No warranty, no responsibility.** The authors take **no responsibility** for
  how you use this, for any accounts, data, or hardware affected, or for any
  legal consequences. Use entirely at your own risk.
- **Your content only.** Use this solely to download courses you are legally
  enrolled in, for your own offline use. You alone are responsible for complying
  with Udemy's Terms of Service and the laws where you live.

By downloading, installing, or using any part of this project you accept all of
the above.

## What it does

| | |
|---|---|
| **One button** | Downloads every lecture of a course you're enrolled in  |
| **Real quality** | Progressive, or **1080p** transmuxed in-browser — never re-encoded |
| **Saves where you want** | With the tiny native helper, files are written straight to any folder (e.g. `A:\udemycourses\<Course>\…`), no browser "Save As" prompts |
| **Subtitles → SRT** | Captions are converted to `.srt` automatically (keep `.vtt` if you prefer) |
| **Skip what you have** | Re-run a course and only the missing lectures download |
| **One unified list** | DRM + 1080p + files grouped per course, collapsible, with per-item/per-course discard — in the popup and as an on-page panel |
| **Offline player** | Built-in course library with resume, speed, scrub previews, quizzes |
| **Library from disk** | Every folder in your courses folder shows up as a course (subfolders = sections), and loose videos/audio as single items, including ones you copy in yourself. Same-name `.srt`/`.vtt` files become captions. Needs the native helper for best results; without it the player reads `file://` folder listings |
| **Optional Docker engine** | A separate legacy Python downloader for bulk/native-ffmpeg workflows |

## Install & activate

**1. Get the files**

```text
git clone https://github.com/rdiol12/udemy-downloader-bridge
```

**2. Load the extension**

```text
brave://extensions  (or chrome://extensions)
→ enable Developer mode
→ Load unpacked → select the  extension/  folder
```
Copy the extension's **ID** shown on its card — you'll need it for step 3.

**3. (Recommended) Install the native helper** — lets the extension save files
directly to any folder on disk (and skips the browser's "Save As" prompts).
Needs **Python 3** on PATH. In the repo folder, PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File native\install.ps1 -ExtensionId <your-extension-id>
```
Then restart the browser. (Without this, files land in your Downloads folder

**4. Download**

```text
Open a Udemy course you're enrolled in → click the extension → set your
"Save to" folder → Download course.
```

Watch offline from the popup → **My courses**.

**Updates.** With the native helper installed and `git` on PATH, the popup
shows **Update available** when the repo has new commits on `master`. Click
**Update now** to fast-forward your clone and reload the extension. It refuses
(and says why) if you edited files in the install folder or switched branches.

## Settings that matter

- **Parallel downloads** — how many lectures download at once (1–12).
- **Captions** — downloads subtitles as `.srt` (tick **Keep .vtt** to keep raw VTT).
- **Skip already downloaded** — on by default; re-runs fetch only what's missing
  (filename-based, so uncheck it to force-refresh a lecture the site updated).
- **Save to** — the absolute folder files are written to.

Docker-only options (H.265/NVENC re-encode, etc.) are hidden unless you turn
Docker on.

## Credits

The downloader core — course parsing, DASH/HLS handling, muxing — and the quiz
player template are the work of
**[Puyodead1/udemy-downloader](https://github.com/Puyodead1/udemy-downloader)**
and its contributors; its commit history is preserved here. In-browser TS→MP4
remuxing uses [mux.js](https://github.com/videojs/mux.js).

The in-browser DRM engine (`extension/wvcdm.js`, `cenc.js`, `dash.js`,
`remux.js`) is this project's own code — a hand-rolled Widevine L3 CDM on
WebCrypto plus CENC/CBCS decryption and mp4 muxing, all in JavaScript. It uses
**no** GPL libraries, so the extension stays MIT. You supply your own `.wvd`.

The **optional Docker engine** (`main.py`, `udemy_drm.py`) uses
[`pywidevine`](https://github.com/devine-dl/pywidevine) (**GPL-3.0**),
[Bento4 `mp4decrypt`](https://www.bento4.com/) and [ffmpeg](https://ffmpeg.org/);
that path is therefore GPL-3.0. It is entirely separate from the extension.

## License

- **Extension (incl. in-browser DRM):** [MIT](LICENSE).
- **Optional Docker engine (`main.py`/`udemy_drm.py`):** GPL-3.0 in use (imports `pywidevine`).
- Downloader core © [Puyodead1 and contributors](https://github.com/Puyodead1/udemy-downloader).

> Use this only to download courses you are legally enrolled in, for your own
> offline use. You are responsible for complying with Udemy's terms and the law
> where you live.
