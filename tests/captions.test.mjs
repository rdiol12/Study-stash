// Run with: node tests/captions.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { srtToVtt } from "../extension/captions.js";

test("adds header and converts timestamp commas", () => {
  const srt = "1\n00:00:01,000 --> 00:00:04,250\nHello\n";
  assert.equal(
    srtToVtt(srt),
    "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.250\nHello\n"
  );
});

test("normalizes CRLF and lone CR line endings", () => {
  const srt = "1\r\n00:00:01,000 --> 00:00:02,000\r\nA\r\n\r\n2\r00:00:03,000 --> 00:00:04,000\rB";
  assert.equal(
    srtToVtt(srt),
    "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nA\n\n2\n00:00:03.000 --> 00:00:04.000\nB"
  );
});

test("leaves commas and timestamp-like text in caption lines alone", () => {
  const srt = "1\n00:00:01,000 --> 00:00:02,000\nAt 00:00:05,000, we start, ok\n";
  const vtt = srtToVtt(srt);
  assert.match(vtt, /^00:00:01\.000 --> 00:00:02\.000$/m);
  assert.match(vtt, /^At 00:00:05,000, we start, ok$/m);
});

test("strips a UTF-8 BOM so the header stays first", () => {
  assert.ok(srtToVtt("﻿1\n00:00:01,000 --> 00:00:02,000\nX").startsWith("WEBVTT\n\n1\n"));
});

test("handles hours past 99 and cue settings", () => {
  assert.equal(
    srtToVtt("100:00:01,500 --> 100:00:02,000 align:start"),
    "WEBVTT\n\n100:00:01.500 --> 100:00:02.000 align:start"
  );
});

test("treats missing input as empty", () => {
  assert.equal(srtToVtt(""), "WEBVTT\n\n");
  assert.equal(srtToVtt(null), "WEBVTT\n\n");
  assert.equal(srtToVtt(undefined), "WEBVTT\n\n");
});
