/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * CLI attachments.
 *
 * A missing, empty, binary, or oversized file must never become a silent empty
 * attach: that would start a run the user thought was pinned to a fixture.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  MAX_ATTACHMENTS,
  MAX_ATTACH_TEXT_BYTES,
  describeAttachment,
  loadAttachments,
  mergeSystem,
  splitAttachArgs,
  splitPathList,
} from "../../cli/attach";
import { isIoError } from "../../cli/io";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "yargix-attach-"));
}

test("splitPathList keeps spaces inside a name and drops empties", () => {
  assert.deepEqual(splitPathList("a.ts, b.md, ,c.json"), ["a.ts", "b.md", "c.json"]);
  assert.deepEqual(splitPathList("my notes.md"), ["my notes.md"]);
});

test("splitAttachArgs accepts commas or spaces", () => {
  assert.deepEqual(splitAttachArgs("a.ts b.md,c.json"), ["a.ts", "b.md", "c.json"]);
});

test("mergeSystem puts the file first so --system can add a one-off", () => {
  assert.equal(mergeSystem("be careful", "be brief"), "be careful\n\nbe brief");
  assert.equal(mergeSystem("from file", ""), "from file");
  assert.equal(mergeSystem("", "inline"), "inline");
  assert.equal(mergeSystem("  ", "  "), "");
});

test("a text file is attached with its exact contents (BOM stripped)", async () => {
  const root = await tempDir();
  await fs.writeFile(path.join(root, "note.ts"), "\uFEFFexport const n = 1;\n");
  const loaded = await loadAttachments(["note.ts"], root, "t");
  if (isIoError(loaded)) assert.fail(loaded.error);
  assert.equal(loaded.attachments.length, 1);
  assert.equal(loaded.attachments[0].kind, "text");
  assert.equal(loaded.attachments[0].name, "note.ts");
  assert.equal(loaded.attachments[0].data, "export const n = 1;\n");
  assert.equal(loaded.attachments[0].id, "t_0");
  assert.equal(describeAttachment(loaded.attachments[0]), "note.ts (text)");
});

test("a PNG is attached as an image data URL", async () => {
  const root = await tempDir();
  // Minimal 1x1 PNG.
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
    "hex",
  );
  await fs.writeFile(path.join(root, "dot.png"), png);
  const loaded = await loadAttachments(["dot.png"], root, "img");
  if (isIoError(loaded)) assert.fail(loaded.error);
  assert.equal(loaded.attachments[0].kind, "image");
  assert.equal(loaded.attachments[0].mime, "image/png");
  assert.match(loaded.attachments[0].data, /^data:image\/png;base64,/);
});

test("duplicate paths are attached once", async () => {
  const root = await tempDir();
  await fs.writeFile(path.join(root, "a.ts"), "x");
  const loaded = await loadAttachments(["a.ts", "./a.ts"], root);
  if (isIoError(loaded)) assert.fail(loaded.error);
  assert.equal(loaded.attachments.length, 1);
});

test("a missing, empty, or directory path is a clear error", async () => {
  const root = await tempDir();
  await fs.writeFile(path.join(root, "empty.ts"), "");
  const missing = await loadAttachments(["nope.ts"], root);
  const empty = await loadAttachments(["empty.ts"], root);
  const dir = await loadAttachments(["."], root);
  const dash = await loadAttachments(["-"], root);
  assert.ok(isIoError(missing));
  assert.ok(isIoError(empty));
  assert.ok(isIoError(dir));
  assert.ok(isIoError(dash));
  assert.match(missing.error, /not found/);
  assert.match(empty.error, /empty/);
  assert.match(dir.error, /directory/);
  assert.match(dash.error, /cannot be '-'/);
});

test("a binary file that is not a known image is refused", async () => {
  const root = await tempDir();
  await fs.writeFile(path.join(root, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
  const loaded = await loadAttachments(["blob.bin"], root);
  assert.ok(isIoError(loaded));
  assert.match(loaded.error, /not a text file/);
});

test("an oversized text file is refused before it is fully parsed as a prompt", async () => {
  const root = await tempDir();
  await fs.writeFile(path.join(root, "big.ts"), Buffer.alloc(MAX_ATTACH_TEXT_BYTES + 1, 0x61));
  const loaded = await loadAttachments(["big.ts"], root);
  assert.ok(isIoError(loaded));
  assert.match(loaded.error, /exceeds/);
});

test("more than the cap is refused instead of silently dropping the tail", async () => {
  const paths = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => `${i}.ts`);
  const loaded = await loadAttachments(paths, process.cwd());
  assert.ok(isIoError(loaded));
  assert.match(loaded.error, /too many attachments/);
});

test("an empty path list is a no-op", async () => {
  const loaded = await loadAttachments([], process.cwd());
  if (isIoError(loaded)) assert.fail(loaded.error);
  assert.deepEqual(loaded.attachments, []);
});
