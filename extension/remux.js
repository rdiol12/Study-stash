// Combine decrypted video + audio fMP4 into one progressive MP4, via mp4box.js.
// Browser loads vendor/mp4box.all.min.js (global MP4Box); Node requires it.
(function (root) {
  "use strict";
  const MP4Box = root.MP4Box || (typeof require !== "undefined" ? require("./vendor/mp4box.all.min.js") : null);
  // In Node, DataStream hangs off the required module; in the browser the UMD
  // declares it as its own global (not MP4Box.DataStream).
  const DataStream = (MP4Box && MP4Box.DataStream) || root.DataStream || (typeof globalThis !== "undefined" && globalThis.DataStream);

  function toAB(u8) { return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength); }
  function boxBytes(box) {
    const s = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
    box.write(s);
    return s.buffer.slice(8); // ArrayBuffer of the config record (strip 8-byte box header)
  }
  function parse(u8) {
    return new Promise((resolve, reject) => {
      const f = MP4Box.createFile();
      f.onError = reject;
      f.onReady = (info) => resolve({ f, info });
      const ab = toAB(u8); ab.fileStart = 0;
      f.appendBuffer(ab); f.flush();
    });
  }

  // videoU8, audioU8: decrypted single-track fMP4. audioU8 may be null.
  async function remux(videoU8, audioU8) {
    const out = MP4Box.createFile();
    const sources = [];
    sources.push(await parse(videoU8));
    if (audioU8) sources.push(await parse(audioU8));

    const pending = [];
    for (const src of sources) {
      for (const track of src.info.tracks) {
        const trak = src.f.getTrackById(track.id);
        const entry = trak.mdia.minf.stbl.stsd.entries[0];
        const opts = { timescale: track.timescale, language: track.language || "und" };
        if (track.type === "video" || track.video) {
          opts.type = "avc1"; opts.hdlr = "vide";
          opts.width = track.video.width; opts.height = track.video.height;
          if (entry.avcC) opts.avcDecoderConfigRecord = boxBytes(entry.avcC);
          else if (entry.hvcC) { opts.type = "hvc1"; opts.hevcDecoderConfigRecord = boxBytes(entry.hvcC); }
        } else {
          opts.type = "mp4a"; opts.hdlr = "soun";
          opts.channel_count = track.audio.channel_count;
          opts.samplerate = track.audio.sample_rate;
          if (entry.esds) opts.description = entry.esds;
        }
        const newId = out.addTrack(opts);
        src.f.setExtractionOptions(track.id, newId, { nbSamples: Number.MAX_SAFE_INTEGER });
      }
      pending.push(new Promise((resolve) => {
        let got = 0; const want = src.info.tracks.reduce((a, t) => a + t.nb_samples, 0);
        src.f.onSamples = (id, newId, samples) => {
          for (const s of samples) out.addSample(newId, s.data, { duration: s.duration, dts: s.dts, cts: s.cts, is_sync: s.is_sync });
          got += samples.length;
          if (got >= want) resolve();
        };
      }));
      src.f.start();
    }
    await Promise.all(pending);
    const ab = out.getBuffer();
    return new Uint8Array(ab);
  }

  root.REMUX = { remux };
})(typeof self !== "undefined" ? self : globalThis);
