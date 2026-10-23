# Udemy Downloader Bridge

Download the Udemy courses you're enrolled in and watch them offline in a
Udemy-style player — straight from a browser extension, with an optional
Docker engine for the heavy lifting.

Built on top of **[Puyodead1/udemy-downloader](https://github.com/Puyodead1/udemy-downloader)**,
which does the hard part (course parsing, DASH/HLS handling, DRM decryption
with user-supplied keys, muxing) and also provided the interactive quiz
player template. All credit for the downloader core goes to that project and
its contributors. This repo keeps upstream's files intact (one two-line
ffmpeg-flag fix) and adds everything around them.

## What's here

**Browser extension** (`extension/`, Manifest V3 — Brave/Chrome):
- One-click download of an enrolled course from the course page or popup
- 720p direct, or 1080p by transmuxing Udemy's HLS in the browser (mux.js —
  repackaged, never re-encoded), with parallel lectures and per-file progress
- Captions (`.vtt`), lecture assets, and **interactive quizzes** exported as
  self-contained HTML (exam/practice modes, timer, attempt history)
- **Offline player**: course library with real video thumbnails, sections
  with per-lecture ✓, resume where you stopped, reset per video, hover
  scrub-previews on the seek bar, subtitles, playback speed, autoplay next
- Proper file layout: `Course/01 - Section/001. Lecture name.mp4`

**Native helper** (`native/`, optional): a tiny native-messaging host that
moves finished courses to any folder on any drive — no tab to keep open, no
browser settings to change. Paths only ever cross the pipe, never file bytes.

**Docker engine** (`server/`, `Dockerfile.server`, optional): upstream's
downloader behind a localhost API — native ffmpeg 1080p, DRM-protected
lectures with your own keys, H.265 re-encoding with NVIDIA NVENC, and a
folder picker over mounted drives. The extension switches engines with one
toggle and falls back to browser mode when the container is down.

## Setup

See **[MANUAL.md](MANUAL.md)** — covers extension-only setup, the optional
helper, the Docker engine, which mode to pick, and troubleshooting.

## Disclaimer

Downloading courses is against Udemy's Terms of Service — use at your own
risk, only for content you are enrolled in. This project does not obtain,
derive, or capture DRM keys; DRM-protected lectures are skipped unless you
supply your own keys.

## License

MIT, same as upstream — see [LICENSE](LICENSE).
Downloader core © [Puyodead1 and contributors](https://github.com/Puyodead1/udemy-downloader).
