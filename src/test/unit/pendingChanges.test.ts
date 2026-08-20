/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeHunks } from "../../stores/pendingChanges";

const lines = (...l: string[]) => l.join("\n");

test("identical texts produce no hunks", () => {
  assert.deepEqual(computeHunks(lines("a", "b"), lines("a", "b")), []);
});

test("a replaced line is one hunk anchored in the after file", () => {
  const hunks = computeHunks(lines("a", "b", "c"), lines("a", "B", "c"));
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].beforeLines, ["b"]);
  assert.deepEqual(hunks[0].afterLines, ["B"]);
  assert.equal(hunks[0].startLine, 1);
  assert.equal(hunks[0].endLine, 1);
});

test("a pure insertion reports no before lines", () => {
  const hunks = computeHunks(lines("a", "c"), lines("a", "b", "c"));
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].beforeLines, []);
  assert.deepEqual(hunks[0].afterLines, ["b"]);
  assert.equal(hunks[0].startLine, 1);
});

test("a pure deletion reports no after lines", () => {
  const hunks = computeHunks(lines("a", "b", "c"), lines("a", "c"));
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].beforeLines, ["b"]);
  assert.deepEqual(hunks[0].afterLines, []);
});

test("separate edits stay separate hunks", () => {
  const hunks = computeHunks(lines("a", "b", "c", "d", "e"), lines("A", "b", "c", "d", "E"));
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0].afterLines, ["A"]);
  assert.deepEqual(hunks[1].afterLines, ["E"]);
});

test("creating content from empty is a single hunk", () => {
  const hunks = computeHunks("", lines("a", "b"));
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].afterLines, ["a", "b"]);
  assert.deepEqual(hunks[0].beforeLines, []);
});

test("hunk before-ranges index the original file", () => {
  const before = lines("keep", "old1", "old2", "tail");
  const hunks = computeHunks(before, lines("keep", "new", "tail"));
  assert.equal(hunks.length, 1);
  const h = hunks[0];
  assert.equal(h.beforeStart, 1);
  assert.equal(h.beforeEnd, 3);
  // Splicing the after-lines over that range reproduces the new text.
  const arr = before.split("\n");
  arr.splice(h.beforeStart, h.beforeEnd - h.beforeStart, ...h.afterLines);
  assert.equal(arr.join("\n"), lines("keep", "new", "tail"));
});
