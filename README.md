<div align="center">

# 🎓 Udemy Downloader Bridge

**Download your Udemy courses. Watch them offline. Keep your progress.**

A browser extension with a built-in Udemy-style player — plus an optional
Docker engine when you want the heavy artillery.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Extension-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](extension/)
[![Works on Brave](https://img.shields.io/badge/Brave-supported-FB542B?logo=brave&logoColor=white)](#)
[![Docker optional](https://img.shields.io/badge/Docker-optional-2496ED?logo=docker&logoColor=white)](MANUAL.md#mode-2--extension--docker-the-full-engine)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#)

[**Setup Manual**](MANUAL.md) · [**Quick Start**](#quick-start) · [**Support ☕**](#support-this-project)

</div>

---

## What it does

| | |
|---|---|
| **One-click download** | Grab any course you're enrolled in, right from the course page |
| **Real quality** | 720p direct, or **1080p** transmuxed in-browser — never re-encoded |
| **Offline player** | Course library with video thumbnails, sections, ✓ per lecture |
| **Picks up where you stopped** | Resume positions per video, autoplay next, playback speed |
| **Scrub previews** | Hover the seek bar, see the frame — YouTube style |
| **Subtitles** | Downloaded captions appear in the player's CC menu |
| **Interactive quizzes** | Exam & practice modes, timer, attempt history — fully offline |
| **Your files, your names** | `Course/01 - Section/001. Lecture name.mp4` — anywhere on disk |
| **Optional Docker engine** | Native ffmpeg 1080p, DRM with *your own* keys, NVIDIA H.265 |

## Quick start

```text
1. Clone this repo
2. brave://extensions → Developer mode → Load unpacked → select extension/
3. Open a Udemy course you're enrolled in → click ⤓ Download course
4. Popup → My courses → press play 
```

Two one-time browser settings make everything smooth — see the
[**Manual**](MANUAL.md) for those, the optional *move-anywhere* helper, and
the full Docker setup.

### Which mode is for me?

|  | Extension only | + Docker |
|---|---|---|
| Install | none | Docker Desktop |
| 1080p | ✅ in-browser transmux | ✅ native ffmpeg (faster) |
| DRM lectures | ❌ skipped | ✅ with your own keys |
| H.265 / GPU encode | ❌ | ✅ NVENC |
| Resume interrupted course | re-downloads | skips existing files |

**Start with the extension alone** — add Docker only when you need DRM, GPU
encoding, or bulk speed.

## Credits

The downloader core — course parsing, DASH/HLS handling, DRM decryption,
muxing — and the quiz player template are the work of
**[Puyodead1/udemy-downloader](https://github.com/Puyodead1/udemy-downloader)**
and its contributors. This project would not exist without it; its full
commit history is preserved in this repo. In-browser TS→MP4 remuxing is
powered by [mux.js](https://github.com/videojs/mux.js) (Video.js project).

## ☕ Support this project

If this saved you hours of clicking through lectures online, consider fueling
the next feature:

<a href="https://www.buymeacoffee.com/rdiol12" target="_blank"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?logo=buymeacoffee&logoColor=black" alt="Buy Me A Coffee" height="32"></a>

…and a ⭐ on the repo is always free.

## Disclaimer

Downloading courses violates Udemy's Terms of Service — use at your own risk,
only for content **you are enrolled in**. This project does **not** obtain,
derive, or capture DRM keys; protected lectures are skipped unless you supply
your own.

## License

[MIT](LICENSE) — same as upstream.
Downloader core © [Puyodead1 and contributors](https://github.com/Puyodead1/udemy-downloader).
