/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * The hand-written WebSocket framing behind the Browser tool.
 *
 * CDP runs over WebSocket and the extension host has no global WebSocket, so
 * the frame codec here is ours. A bug in it corrupts every browser command
 * silently, which is exactly the kind of thing a round-trip test catches.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { encodeFrame, decodeFrame, browserCandidates } from "../../integrations/browser";

/** Frames are masked on the wire; unmask the way a server would. */
function roundTrip(text: string): string {
  const frame = encodeFrame(Buffer.from(text, "utf8"), 0x1);
  const decoded = decodeFrame(frame);
  assert.ok(decoded, "frame should decode");
  assert.equal(decoded.consumed, frame.length, "should consume the whole frame");
  return decoded.payload.toString("utf8");
}

// ------------------------------------------------------------------- framing

test("a short payload survives a round trip", () => {
  assert.equal(roundTrip("hello"), "hello");
});

test("an empty payload survives a round trip", () => {
  assert.equal(roundTrip(""), "");
});

test("payloads at the 125/126 length boundary survive", () => {
  // 125 is the last inline length; 126 switches to a 16-bit length field.
  for (const n of [124, 125, 126, 127]) {
    const s = "x".repeat(n);
    assert.equal(roundTrip(s), s, `length ${n} should round trip`);
  }
});

test("payloads at the 65535/65536 boundary survive", () => {
  // 65536 switches to the 64-bit length field.
  for (const n of [65535, 65536]) {
    const s = "y".repeat(n);
    assert.equal(roundTrip(s), s, `length ${n} should round trip`);
  }
});

test("multi-byte UTF-8 is not corrupted by masking", () => {
  const s = "günaydın — ✅ 日本語 🎉";
  assert.equal(roundTrip(s), s);
});

test("client frames are masked, as the protocol requires", () => {
  const frame = encodeFrame(Buffer.from("abc", "utf8"), 0x1);
  assert.equal(frame[0] & 0x80, 0x80, "FIN must be set");
  assert.equal(frame[0] & 0x0f, 0x1, "opcode should be text");
  assert.equal(frame[1] & 0x80, 0x80, "mask bit must be set");
});

test("masking uses a fresh key each time", () => {
  const a = encodeFrame(Buffer.from("same payload"), 0x1);
  const b = encodeFrame(Buffer.from("same payload"), 0x1);
  assert.notDeepEqual(a, b, "two frames of identical text must not be byte-identical");
});

test("the opcode is preserved", () => {
  for (const opcode of [0x1, 0x8, 0x9, 0xa]) {
    const decoded = decodeFrame(encodeFrame(Buffer.alloc(0), opcode));
    assert.equal(decoded?.opcode, opcode);
  }
});

// ------------------------------------------------------------ partial buffers

test("an incomplete frame decodes to undefined instead of throwing", () => {
  const frame = encodeFrame(Buffer.from("hello world"), 0x1);
  for (let cut = 0; cut < frame.length; cut++) {
    assert.equal(decodeFrame(frame.subarray(0, cut)), undefined, `${cut} bytes should be incomplete`);
  }
  assert.ok(decodeFrame(frame), "the full frame should decode");
});

test("a truncated 16-bit length header is incomplete, not garbage", () => {
  const frame = encodeFrame(Buffer.from("z".repeat(300)), 0x1);
  assert.equal(decodeFrame(frame.subarray(0, 3)), undefined);
});

test("trailing bytes are left for the next frame", () => {
  const first = encodeFrame(Buffer.from("one"), 0x1);
  const second = encodeFrame(Buffer.from("two"), 0x1);
  const stream = Buffer.concat([first, second]);

  const a = decodeFrame(stream);
  assert.equal(a?.payload.toString("utf8"), "one");
  assert.equal(a?.consumed, first.length);

  const b = decodeFrame(stream.subarray(a!.consumed));
  assert.equal(b?.payload.toString("utf8"), "two");
});

test("a JSON CDP message survives the codec intact", () => {
  const msg = JSON.stringify({ id: 7, method: "Page.navigate", params: { url: "http://localhost:3000/?a=1&b=2" } });
  assert.deepEqual(JSON.parse(roundTrip(msg)), JSON.parse(msg));
});

// ------------------------------------------------------------ browser lookup

test("browser candidates are absolute paths, per platform", () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    const list = browserCandidates(platform);
    assert.ok(list.length > 0, `${platform} should have candidates`);
    for (const p of list) {
      assert.ok(p.includes("/") || p.includes("\\"), `${p} should be a path`);
    }
  }
});

test("mac and linux candidates include Chrome", () => {
  assert.ok(browserCandidates("darwin").some((p) => /Chrome/i.test(p)));
  assert.ok(browserCandidates("linux").some((p) => /chrom/i.test(p)));
});

test("win32 candidates are listed even when Windows env vars are unset", () => {
  const list = browserCandidates("win32");
  assert.ok(list.some((p) => /chrome\.exe$/i.test(p)));
  assert.ok(list.some((p) => /msedge\.exe$/i.test(p)));
});
