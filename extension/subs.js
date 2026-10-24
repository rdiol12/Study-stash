// WebVTT -> SubRip (.srt), matching vtt_to_srt.py's behaviour in pure JS so the
// standalone extension needs no Python: number each cue, render timestamps as
// HH:MM:SS,mmm, unescape HTML entities, and drop VTT-only cue markup.

function unescapeHtml(s) {
  return String(s)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

function normalizeTs(ts) {
  const clean = ts.trim().replace(",", ".");
  const parts = clean.split(":");
  let h = "0", m = "0", rest = "0.000";
  if (parts.length === 3) [h, m, rest] = parts;
  else if (parts.length === 2) [m, rest] = parts;
  else return "00:00:00,000";
  let [sec, ms = "0"] = rest.split(".");
  ms = (ms + "000").slice(0, 3);
  const pad = (v, n = 2) => String(parseInt(v, 10) || 0).padStart(n, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)},${ms}`;
}

export function vttToSrt(vtt) {
  const text = String(vtt).replace(/\r\n|\r/g, "\n");
  const cues = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti === -1) continue; // WEBVTT header, NOTE/STYLE/REGION blocks
    const [rawStart, rawEnd] = lines[ti].split("-->");
    if (!rawEnd) continue;
    const start = normalizeTs(rawStart);
    const end = normalizeTs(rawEnd.trim().split(/\s+/)[0]); // drop cue settings
    const body = lines.slice(ti + 1).join("\n").replace(/<[^>]+>/g, ""); // strip <c>/<v>/<i> markup
    cues.push({ start, end, text: unescapeHtml(body) });
  }
  return cues.map((c, i) => `${i + 1}\n${c.start} --> ${c.end}\n${c.text}\n`).join("\n");
}
