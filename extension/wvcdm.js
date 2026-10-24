// Standalone Widevine L3 CDM — pure WebCrypto, no native host, no Docker.
// Ports pywidevine/cdm.py; validated to reproduce its content keys byte-for-byte.
// Browser + Node 22 (same WebCrypto API). Exposes globalThis.WVCDM.widevineKeys.
(function (root) {
  "use strict";
  const subtle = (root.crypto || globalThis.crypto).subtle;

  // ---------- bytes ----------
  const te = new TextEncoder();
  function cat(...arrs) {
    let n = 0; for (const a of arrs) n += a.length;
    const out = new Uint8Array(n); let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  }
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
  function b64ToU8(b64) {
    const bin = atob(b64); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function u8ToB64(u8) {
    let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }

  // ---------- protobuf (minimal) ----------
  function varint(n) {
    let v = BigInt(n); const out = [];
    do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
    return Uint8Array.from(out);
  }
  const tag = (f, w) => varint((f << 3) | w);
  const vfield = (f, n) => cat(tag(f, 0), varint(n));
  const bfield = (f, b) => cat(tag(f, 2), varint(b.length), b);
  function readVarint(buf, o) { let v = 0n, s = 0n; for (;;) { const b = buf[o++]; v |= BigInt(b & 0x7f) << s; if (!(b & 0x80)) break; s += 7n; } return [v, o]; }
  function readFields(buf) {
    let o = 0; const out = {};
    while (o < buf.length) {
      let t; [t, o] = readVarint(buf, o); const f = Number(t >> 3n), w = Number(t & 7n);
      let val;
      if (w === 0) { [val, o] = readVarint(buf, o); }
      else if (w === 2) { let len; [len, o] = readVarint(buf, o); len = Number(len); val = buf.subarray(o, o + len); o += len; }
      else if (w === 5) { val = buf.subarray(o, o + 4); o += 4; }
      else if (w === 1) { val = buf.subarray(o, o + 8); o += 8; }
      else throw new Error("protobuf wire " + w);
      (out[f] = out[f] || []).push(val);
    }
    return out;
  }

  // ---------- DER: wrap PKCS1 RSA private key as PKCS8 (WebCrypto wants PKCS8) ----------
  function derLen(n) { if (n < 0x80) return [n]; const b = []; while (n > 0) { b.unshift(n & 0xff); n >>= 8; } return [0x80 | b.length, ...b]; }
  function tlv(tagByte, content) { return cat(Uint8Array.from([tagByte, ...derLen(content.length)]), content); }
  function pkcs1ToPkcs8(pkcs1) {
    const version = tlv(0x02, Uint8Array.from([0x00]));
    const algId = Uint8Array.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
    const pk = tlv(0x04, pkcs1);
    return tlv(0x30, cat(version, algId, pk));
  }

  // ---------- AES-CMAC via WebCrypto AES-CBC (no ECB in WebCrypto) ----------
  const ZERO16 = new Uint8Array(16);
  async function ecb(aesKey, block16) {
    // AES-CBC with IV=0 on a single block: first 16 output bytes == ECB(block)
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv: ZERO16 }, aesKey, block16));
    return ct.subarray(0, 16);
  }
  function dbl(b) {
    const out = new Uint8Array(16); let carry = 0;
    for (let i = 15; i >= 0; i--) { const v = (b[i] << 1) | carry; out[i] = v & 0xff; carry = (b[i] & 0x80) ? 1 : 0; }
    if (b[0] & 0x80) out[15] ^= 0x87;
    return out;
  }
  async function cmac(rawKey, msg) {
    const aesKey = await subtle.importKey("raw", rawKey, { name: "AES-CBC" }, false, ["encrypt"]);
    const L = await ecb(aesKey, ZERO16);
    const K1 = dbl(L), K2 = dbl(K1);
    const n = Math.ceil(msg.length / 16) || 1;
    const rem = msg.length - (n - 1) * 16;
    let last;
    if (rem === 16) { last = msg.slice((n - 1) * 16); for (let i = 0; i < 16; i++) last[i] ^= K1[i]; }
    else { last = new Uint8Array(16); last.set(msg.subarray((n - 1) * 16)); last[rem] = 0x80; for (let i = 0; i < 16; i++) last[i] ^= K2[i]; }
    const mPrime = cat(msg.subarray(0, (n - 1) * 16), last); // multiple of 16
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv: ZERO16 }, aesKey, mPrime));
    // real cipher blocks are ct[0 .. mPrime.length); WebCrypto appends one pad block.
    return ct.subarray(mPrime.length - 16, mPrime.length);
  }

  // ---------- WVD ----------
  function parseWVD(buf) {
    if (String.fromCharCode(buf[0], buf[1], buf[2]) !== "WVD") throw new Error("not a .wvd file");
    let o = 3; const version = buf[o++], type = buf[o++], level = buf[o++], flags = buf[o++];
    const privLen = (buf[o] << 8) | buf[o + 1]; o += 2; const priv = buf.subarray(o, o + privLen); o += privLen;
    const cidLen = (buf[o] << 8) | buf[o + 1]; o += 2; const cid = buf.subarray(o, o + cidLen);
    return { version, type, level, priv, cid };
  }

  function randBytes(n) { const u = new Uint8Array(n); (root.crypto || globalThis.crypto).getRandomValues(u); return u; }

  // ---------- main ----------
  // opts: { wvd:Uint8Array, initData:Uint8Array, licenseUrl, licenseHeaders?:{} }
  async function widevineKeys(opts) {
    const dev = parseWVD(opts.wvd);
    const pkcs8 = pkcs1ToPkcs8(dev.priv);
    const signKey = await subtle.importKey("pkcs8", pkcs8, { name: "RSA-PSS", hash: "SHA-1" }, false, ["sign"]);
    const oaepKey = await subtle.importKey("pkcs8", pkcs8, { name: "RSA-OAEP", hash: "SHA-1" }, false, ["decrypt"]);

    // request_id (ANDROID): (4 rand + 4 zero + 8-byte LE counter=0) -> hex upper -> 32 bytes
    const ridRaw = cat(randBytes(4), new Uint8Array(4), new Uint8Array(8));
    const request_id = te.encode(hex(ridRaw).toUpperCase());

    const wpd = cat(bfield(1, opts.initData), vfield(2, 1), bfield(3, request_id)); // WidevinePsshData
    const contentId = bfield(1, wpd);                                              // ContentIdentification
    const now = Math.floor(Date.now() / 1000);
    const nonce = 1 + Math.floor(Math.random() * (2 ** 31 - 1));
    const licenseRequest = cat(
      bfield(1, dev.cid), bfield(2, contentId), vfield(3, 1), vfield(4, now), vfield(6, 21), vfield(7, nonce)
    );
    const signature = new Uint8Array(await subtle.sign({ name: "RSA-PSS", saltLength: 20 }, signKey, licenseRequest));
    const signed = cat(vfield(1, 1), bfield(2, licenseRequest), bfield(3, signature));

    const resp = await fetch(opts.licenseUrl, {
      method: "POST", body: signed, headers: opts.licenseHeaders || {},
      credentials: "include", // send the browser's Udemy session (how the API auths)
    });
    if (!resp.ok) throw new Error("license server HTTP " + resp.status);
    let body = new Uint8Array(await resp.arrayBuffer());
    // some servers wrap the license in JSON/base64
    if (body[0] === 0x7b || body[0] === 0x5b) {
      const j = JSON.parse(new TextDecoder().decode(body));
      const lic = j.license || j.License || (j.msg && j.msg.license);
      if (lic) body = b64ToU8(lic);
    }

    const sm = readFields(body);
    const licenseMsg = sm[2][0];
    const sessionKey = new Uint8Array(await subtle.decrypt({ name: "RSA-OAEP" }, oaepKey, sm[4][0]));
    const oem = sm[9] ? sm[9][0] : new Uint8Array(0);

    const encCtx = cat(te.encode("ENCRYPTION"), Uint8Array.from([0]), licenseRequest, Uint8Array.from([0, 0, 0, 0x80]));
    const macCtx = cat(te.encode("AUTHENTICATION"), Uint8Array.from([0]), licenseRequest, Uint8Array.from([0, 0, 2, 0]));
    const encKey = await cmac(sessionKey, cat(Uint8Array.from([1]), encCtx));
    const macServer = cat(await cmac(sessionKey, cat(Uint8Array.from([1]), macCtx)), await cmac(sessionKey, cat(Uint8Array.from([2]), macCtx)));

    // verify license HMAC (defensive)
    const hmacKey = await subtle.importKey("raw", macServer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const computed = new Uint8Array(await subtle.sign("HMAC", hmacKey, cat(oem, licenseMsg)));
    const ok = sm[3] && hex(computed) === hex(sm[3][0]);

    const aesEncKey = await subtle.importKey("raw", encKey, { name: "AES-CBC" }, false, ["decrypt"]);
    const lic = readFields(licenseMsg);
    const keys = [];
    for (const kc of (lic[3] || [])) {
      const k = readFields(kc);
      const type = k[4] ? Number(k[4][0]) : 0;
      if (type !== 2) continue; // CONTENT
      const kid = k[1][0], iv = k[2][0], enc = k[3][0];
      const key = new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv: iv }, aesEncKey, enc));
      keys.push({ kid: hex(kid), key: hex(key) });
    }
    return { keys, hmacVerified: ok };
  }

  root.WVCDM = { widevineKeys, parseWVD, b64ToU8, u8ToB64, hex };
})(typeof self !== "undefined" ? self : globalThis);
