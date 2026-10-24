// CENC (Widevine fMP4) content decryption in pure WebCrypto.
// Strategy: decrypt mdat samples in place, then neutralize the protection boxes by
// renaming them to 'free' (identical size -> zero offset shifts) and flip the
// 'encv'/'enca' sample entry back to its original codec. Output is a clean,
// playable fMP4 with no container surgery. Browser + Node 22 (same WebCrypto).
(function (root) {
  "use strict";
  const subtle = (root.crypto || globalThis.crypto).subtle;
  const u32 = (b, o) => (b[o] * 2 ** 24) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  const u16 = (b, o) => (b[o] << 8) | b[o + 1];
  const u64 = (b, o) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
  const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const setType = (b, o, s) => { for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i); };

  // Walk boxes in [start,end): returns [{type, start, size, dataStart, dataEnd}]
  function boxes(b, start, end) {
    const out = []; let o = start;
    while (o + 8 <= end) {
      let size = u32(b, o); const type = fourcc(b, o + 4); let hdr = 8;
      if (size === 1) { size = u64(b, o + 8); hdr = 16; }
      else if (size === 0) { size = end - o; }
      if (size < hdr || o + size > end) break;
      out.push({ type, start: o, size, dataStart: o + hdr, dataEnd: o + size });
      o += size;
    }
    return out;
  }
  const find = (list, t) => list.find((x) => x.type === t);
  const filter = (list, t) => list.filter((x) => x.type === t);

  // parse sample entry (encv/enca) child boxes -> {origFmt, scheme, tenc}
  function parseEncEntry(b, box) {
    // visual entry header 78 bytes, audio 28, after the 8-byte box header
    const isVideo = box.type === "encv";
    const childStart = box.dataStart + (isVideo ? 78 : 28);
    const kids = boxes(b, childStart, box.dataEnd);
    const sinf = find(kids, "sinf");
    if (!sinf) return null;
    const sk = boxes(b, sinf.dataStart, sinf.dataEnd);
    const frma = find(sk, "frma");
    const schm = find(sk, "schm");
    const schi = find(sk, "schi");
    const origFmt = frma ? fourcc(b, frma.dataStart) : "avc1";
    const scheme = schm ? fourcc(b, schm.dataStart + 4) : "cenc";
    let tenc = null;
    if (schi) {
      const tb = find(boxes(b, schi.dataStart, schi.dataEnd), "tenc");
      if (tb) {
        // fullbox(4) + reserved(1) + reserved/pattern(1) + default_isProtected(1) + default_Per_Sample_IV_Size(1) + default_KID(16)
        const p = tb.dataStart + 4;
        // byte p+1 holds the crypt/skip pattern (cbcs); 0/0 for cenc.
        tenc = { ivSize: b[p + 3], defaultKID: b.subarray(p + 4, p + 20),
                 cryptByteBlock: b[p + 1] >> 4, skipByteBlock: b[p + 1] & 0x0f };
        if (b[p + 3] === 0) { // constant IV (cbcs)
          const cl = b[p + 20]; tenc.constantIV = b.subarray(p + 21, p + 21 + cl);
        }
      }
    }
    return { entryBox: box, sinf, origFmt, scheme, tenc, isVideo };
  }

  function parseSenc(b, senc, ivSize) {
    // fullbox: version(1)+flags(3). flags&2 -> subsamples present
    const ver = b[senc.dataStart]; const flags = u32(b, senc.dataStart) & 0xffffff;
    let o = senc.dataStart + 4;
    const count = u32(b, o); o += 4;
    const samples = [];
    for (let i = 0; i < count; i++) {
      const iv = b.subarray(o, o + ivSize); o += ivSize;
      const subs = [];
      if (flags & 2) {
        const n = u16(b, o); o += 2;
        for (let j = 0; j < n; j++) { subs.push({ clear: u16(b, o), enc: u32(b, o + 2) }); o += 6; }
      }
      samples.push({ iv, subs });
    }
    return samples;
  }

  function parseTrunSizes(b, trun, defaultSize) {
    const flags = u32(b, trun.dataStart) & 0xffffff;
    let o = trun.dataStart + 4;
    const count = u32(b, o); o += 4;
    if (flags & 0x1) o += 4;        // data_offset
    if (flags & 0x4) o += 4;        // first_sample_flags
    const sizes = [];
    for (let i = 0; i < count; i++) {
      if (flags & 0x100) o += 4;    // duration
      let sz = defaultSize;
      if (flags & 0x200) { sz = u32(b, o); o += 4; } // sample_size
      if (flags & 0x400) o += 4;    // flags
      if (flags & 0x800) o += 4;    // ctts
      sizes.push(sz);
    }
    return sizes;
  }

  async function ctrDecrypt(keyRaw, iv16, data) {
    const k = await subtle.importKey("raw", keyRaw, { name: "AES-CTR" }, false, ["decrypt"]);
    return new Uint8Array(await subtle.decrypt({ name: "AES-CTR", counter: iv16, length: 64 }, k, data));
  }

  // Raw (no-padding) AES-CBC decrypt via WebCrypto: append a crafted block that
  // decrypts to valid PKCS7 padding so subtle.decrypt accepts and strips it.
  async function cbcDecryptRaw(key, iv, data) {
    const lastCipher = data.subarray(data.length - 16);
    const padPlain = new Uint8Array(16).fill(16);
    const encPad = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv: lastCipher }, key, padPlain));
    const full = new Uint8Array(data.length + 16);
    full.set(data, 0); full.set(encPad.subarray(0, 16), data.length);
    return new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv }, key, full)); // == data.length
  }

  // cbcs: AES-CBC pattern decrypt of one subsample's protected region. The crypt
  // blocks form a continuous CBC stream (skip blocks are clear), so gather them,
  // decrypt once, and scatter back. crypt/skip are in 16-byte blocks.
  async function cbcsRegion(key, iv0, enc, crypt, skip) {
    const out = new Uint8Array(enc);
    if (crypt === 0 || skip === 0) { // whole region (cbc1 / full)
      const nblk = Math.floor(enc.length / 16) * 16;
      if (nblk > 0) out.set(await cbcDecryptRaw(key, iv0, enc.subarray(0, nblk)), 0);
      return out;
    }
    const ranges = []; let pos = 0, total = 0;
    while (enc.length - pos >= 16) {
      const cLen = Math.min(crypt * 16, Math.floor((enc.length - pos) / 16) * 16);
      ranges.push([pos, cLen]); total += cLen; pos += cLen;
      pos += Math.min(skip * 16, enc.length - pos);
    }
    const gathered = new Uint8Array(total); let go = 0;
    for (const [p, l] of ranges) { gathered.set(enc.subarray(p, p + l), go); go += l; }
    const dec = await cbcDecryptRaw(key, iv0, gathered);
    go = 0; for (const [p, l] of ranges) { out.set(dec.subarray(go, go + l), p); go += l; }
    return out;
  }

  // keysByKid: { "<kidhex>": "<keyhex>" }. Returns a new Uint8Array (decrypted, playable).
  async function decryptCENC(input, keysByKid) {
    const b = input.slice(); // mutate a copy
    const top = boxes(b, 0, b.length);
    const moov = find(top, "moov");
    if (!moov) throw new Error("no moov");

    // find the encrypted sample entry + tenc (single video track assumed per file)
    let info = null;
    const traks = filter(boxes(b, moov.dataStart, moov.dataEnd), "trak");
    for (const trak of traks) {
      const mdia = find(boxes(b, trak.dataStart, trak.dataEnd), "mdia");
      const minf = mdia && find(boxes(b, mdia.dataStart, mdia.dataEnd), "minf");
      const stbl = minf && find(boxes(b, minf.dataStart, minf.dataEnd), "stbl");
      const stsd = stbl && find(boxes(b, stbl.dataStart, stbl.dataEnd), "stsd");
      if (!stsd) continue;
      const entries = boxes(b, stsd.dataStart + 8, stsd.dataEnd); // skip fullbox+count
      const enc = entries.find((e) => e.type === "encv" || e.type === "enca");
      if (enc) { info = parseEncEntry(b, enc); break; }
    }
    if (!info || !info.tenc) throw new Error("no encrypted track / tenc");
    if (info.scheme !== "cenc" && info.scheme !== "cbcs") throw new Error("unsupported encryption scheme: " + info.scheme);
    const cbcs = info.scheme === "cbcs";
    const crypt = info.tenc.cryptByteBlock || 0, skip = info.tenc.skipByteBlock || 0;
    const constIV = info.tenc.constantIV || null;
    const ivSize = info.tenc.ivSize || (cbcs ? 0 : 8);
    const kidHex = Array.from(info.tenc.defaultKID, (x) => x.toString(16).padStart(2, "0")).join("");
    const keyHex = keysByKid[kidHex] || Object.values(keysByKid)[0];
    if (!keyHex) throw new Error("no key for KID " + kidHex);
    const keyRaw = Uint8Array.from(keyHex.match(/../g).map((h) => parseInt(h, 16)));
    const cbcKey = cbcs ? await subtle.importKey("raw", keyRaw, { name: "AES-CBC" }, false, ["encrypt", "decrypt"]) : null;

    // per moof/traf: decrypt samples
    const moofs = filter(top, "moof");
    const mdats = filter(top, "mdat");
    for (let mi = 0; mi < moofs.length; mi++) {
      const moof = moofs[mi];
      const mdat = mdats[mi] || find(boxes(b, moof.dataEnd, b.length), "mdat");
      const traf = find(boxes(b, moof.dataStart, moof.dataEnd), "traf");
      if (!traf) continue;
      const tkids = boxes(b, traf.dataStart, traf.dataEnd);
      const senc = find(tkids, "senc");
      const trun = find(tkids, "trun");
      if (!senc || !trun) continue;
      const samples = parseSenc(b, senc, ivSize);
      const sizes = parseTrunSizes(b, trun, 0);
      // trun data_offset points relative to moof start; but mdat data region is mdat.dataStart.
      let p = mdat.dataStart;
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i]; const size = sizes[i];
        // per-sample IV, or the constant IV (common for cbcs with ivSize 0)
        const ivSrc = (ivSize > 0 && s.iv && s.iv.length) ? s.iv : (constIV || new Uint8Array(16));
        const iv16 = new Uint8Array(16); iv16.set(ivSrc.subarray(0, 16), 0);
        const subs = (s.subs && s.subs.length) ? s.subs : [{ clear: 0, enc: size }];
        if (cbcs) {
          // AES-CBC pattern per subsample (IV reset to the sample IV each time)
          let q = p;
          for (const ss of subs) {
            q += ss.clear;
            if (ss.enc > 0) b.set(await cbcsRegion(cbcKey, iv16, b.subarray(q, q + ss.enc), crypt, skip), q);
            q += ss.enc;
          }
        } else {
          // cenc: gather encrypted bytes, CTR-decrypt as one stream, scatter back
          let encLen = 0; for (const ss of subs) encLen += ss.enc;
          const encBuf = new Uint8Array(encLen); let eo = 0, q = p;
          for (const ss of subs) { q += ss.clear; encBuf.set(b.subarray(q, q + ss.enc), eo); eo += ss.enc; q += ss.enc; }
          const dec = await ctrDecrypt(keyRaw, iv16, encBuf);
          eo = 0; q = p;
          for (const ss of subs) { q += ss.clear; b.set(dec.subarray(eo, eo + ss.enc), q); eo += ss.enc; q += ss.enc; }
        }
        p += size;
      }
      // neutralize protection boxes in this traf
      for (const t of ["senc", "saiz", "saio", "sbgp", "sgpd"]) for (const x of filter(tkids, t)) setType(b, x.start + 4, "free");
    }

    // flip the sample entry back to clear + neutralize sinf + strip pssh
    setType(b, info.entryBox.start + 4, info.origFmt);
    setType(b, info.sinf.start + 4, "free");
    for (const x of filter(boxes(b, moov.dataStart, moov.dataEnd), "pssh")) setType(b, x.start + 4, "free");

    return b;
  }

  root.CENC = { decryptCENC };
})(typeof self !== "undefined" ? self : globalThis);
