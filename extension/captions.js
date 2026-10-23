// SRT -> WebVTT for the player's <track> elements. Kept in its own module,
// free of DOM access, so tests/captions.test.mjs can run it under plain node.

// HH:MM:SS,mmm (hours may be 1+ digits) -- the comma is the only difference
// from a WebVTT timestamp
const SRT_STAMP = /(\d+:\d{2}:\d{2}),(\d{3})/g;

/** <track> accepts only WebVTT; container-mode captions are .srt. Only cue
 *  timing lines are rewritten, so commas inside caption text survive. */
export function srtToVtt(srt) {
  const lines = String(srt ?? "")
    .replace(/^﻿/, "")
    .split(/\r\n|\r|\n/);
  const body = lines.map((line) =>
    line.includes("-->") ? line.replace(SRT_STAMP, "$1.$2") : line
  );
  return "WEBVTT\n\n" + body.join("\n");
}
