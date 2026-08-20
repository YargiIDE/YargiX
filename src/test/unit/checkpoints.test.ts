/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  captureInto,
  prune,
  describe as describeCheckpoint,
  checkpoints,
  MAX_CHECKPOINTS,
  MAX_FILE_BYTES,
  type Checkpoint,
  type CheckpointFile,
} from "../../stores/checkpoints";
import { pendingChanges } from "../../stores/pendingChanges";

function cp(patch: Partial<Checkpoint> = {}): Checkpoint {
  return { id: "x", label: "run", createdAt: 0, files: [], ...patch };
}

// ------------------------------------------------------------- captureInto

test("captureInto stashes a file's previous contents", () => {
  const files = captureInto([], "src/a.ts", "before");
  assert.deepEqual(files, [{ path: "src/a.ts", content: "before" }]);
});

test("captureInto records a not-yet-existing file as null", () => {
  const files = captureInto([], "src/new.ts", null);
  assert.equal(files[0].content, null);
});

test("captureInto keeps the FIRST snapshot of a file", () => {
  // The checkpoint must hold the state from before the run, so a second edit to
  // the same file during that run must not overwrite the stored original.
  let files: CheckpointFile[] = [];
  files = captureInto(files, "src/a.ts", "original");
  files = captureInto(files, "src/a.ts", "after first edit");
  assert.equal(files.length, 1);
  assert.equal(files[0].content, "original");
});

test("captureInto returns the same array when nothing was added", () => {
  const first = captureInto([], "src/a.ts", "v1");
  const second = captureInto(first, "src/a.ts", "v2");
  assert.equal(second, first, "identity is the store's 'nothing changed' signal");
});

test("captureInto tracks separate files independently", () => {
  let files: CheckpointFile[] = [];
  files = captureInto(files, "a.ts", "A");
  files = captureInto(files, "b.ts", "B");
  assert.deepEqual(files.map((f) => f.path), ["a.ts", "b.ts"]);
});

test("captureInto skips files above the size cap", () => {
  const huge = "x".repeat(MAX_FILE_BYTES + 1);
  assert.deepEqual(captureInto([], "big.bin", huge), []);
});

test("captureInto still records a file exactly at the size cap", () => {
  const atCap = "x".repeat(MAX_FILE_BYTES);
  assert.equal(captureInto([], "big.bin", atCap).length, 1);
});

// -------------------------------------------------------------------- prune

test("prune keeps every checkpoint below the limit", () => {
  const list = [cp({ id: "a" }), cp({ id: "b" })];
  assert.equal(prune(list, 5), list);
});

test("prune drops the oldest checkpoints first", () => {
  const list = [cp({ id: "a" }), cp({ id: "b" }), cp({ id: "c" })];
  assert.deepEqual(prune(list, 2).map((c) => c.id), ["b", "c"]);
});

test("prune defaults to the documented maximum", () => {
  const many = Array.from({ length: MAX_CHECKPOINTS + 5 }, (_, i) => cp({ id: `c${i}` }));
  assert.equal(prune(many).length, MAX_CHECKPOINTS);
});

// ----------------------------------------------------------------- describe

test("describe counts restored files", () => {
  const c = cp({ files: [{ path: "a", content: "x" }, { path: "b", content: "y" }] });
  assert.equal(describeCheckpoint(c), "2 files restored");
});

test("describe reports created files as removals", () => {
  const c = cp({ files: [{ path: "a", content: null }] });
  assert.equal(describeCheckpoint(c), "1 created file removed");
});

test("describe combines both kinds", () => {
  const c = cp({ files: [{ path: "a", content: "x" }, { path: "b", content: null }] });
  assert.equal(describeCheckpoint(c), "1 file restored, 1 created file removed");
});

test("describe handles an empty checkpoint", () => {
  assert.equal(describeCheckpoint(cp()), "nothing to undo");
});

// --------------------------------------------------------------- the wiring

/**
 * These exercise the real singletons: every edit in the app funnels through
 * `pendingChanges.record`, which must feed the checkpoint store. Minification
 * renames the internals, so only a behavioural test can prove this link.
 */

test("recording an edit stashes the file into the open checkpoint", () => {
  checkpoints.clear();
  checkpoints.begin("test run");
  pendingChanges.record("src/a.ts", "original", "modified", true);

  const all = checkpoints.all();
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].files, [{ path: "src/a.ts", content: "original" }]);
});

test("a file created by the edit is stashed as non-existent", () => {
  checkpoints.clear();
  checkpoints.begin("test run");
  pendingChanges.record("src/new.ts", "", "hello", false);

  assert.equal(checkpoints.all()[0].files[0].content, null);
});

test("repeated edits in one run keep the pre-run contents", () => {
  checkpoints.clear();
  checkpoints.begin("test run");
  pendingChanges.record("src/a.ts", "v1", "v2", true);
  pendingChanges.record("src/a.ts", "v2", "v3", true);

  const files = checkpoints.all()[0].files;
  assert.equal(files.length, 1);
  assert.equal(files[0].content, "v1");
});

test("each run gets its own checkpoint", () => {
  checkpoints.clear();
  checkpoints.begin("first run");
  pendingChanges.record("a.ts", "A", "A2", true);
  checkpoints.begin("second run");
  pendingChanges.record("b.ts", "B", "B2", true);

  const all = checkpoints.all(); // newest first
  assert.equal(all.length, 2);
  assert.equal(all[0].label, "second run");
  assert.deepEqual(all[0].files.map((f) => f.path), ["b.ts"]);
  assert.deepEqual(all[1].files.map((f) => f.path), ["a.ts"]);
});

test("a run that edited nothing leaves no checkpoint behind", () => {
  checkpoints.clear();
  checkpoints.begin("did nothing");
  checkpoints.begin("also did nothing");
  assert.equal(checkpoints.all().length, 0);
  assert.equal(checkpoints.count(), 0);
});

test("edits with no open checkpoint still get captured", () => {
  // Inline edits happen outside an agent run; they must not fall on the floor.
  checkpoints.clear();
  pendingChanges.record("src/loose.ts", "before", "after", true);
  assert.equal(checkpoints.all()[0].files[0].path, "src/loose.ts");
});
