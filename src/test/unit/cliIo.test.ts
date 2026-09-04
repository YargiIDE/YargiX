/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * CLI prompt/answer I/O.
 *
 * A missing, empty, or oversized file must never become a silent empty prompt:
 * that would start a run the user did not ask for. Directories and "-" as an
 * output path are refused for the same reason.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  MAX_PROMPT_BYTES,
  isIoError,
  loadPrompt,
  promptSource,
  readStdin,
  readTextFile,
  writeTextFile,
} from "../../cli/io";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "yargix-clio-"));
}

// ----------------------------------------------------------- promptSource

test("exactly one source is accepted", () => {
  assert.deepEqual(promptSource({ prompt: "hi", file: "", stdin: false }), { kind: "text", text: "hi" });
  assert.deepEqual(promptSource({ prompt: "", file: "a.md", stdin: false }), { kind: "file", path: "a.md" });
  assert.deepEqual(promptSource({ prompt: "", file: "", stdin: true }), { kind: "stdin" });
  assert.deepEqual(promptSource({ prompt: "", file: "", stdin: false }), { kind: "none" });
});

test("two sources at once is an error", () => {
  for (const src of [
    promptSource({ prompt: "hi", file: "a.md", stdin: false }),
    promptSource({ prompt: "", file: "a.md", stdin: true }),
    promptSource({ prompt: "hi", file: "", stdin: true }),
  ]) {
    assert.ok("error" in src);
    assert.match(src.error, /not more than one/);
  }
});

test("loadPrompt returns text sources unchanged", async () => {
  const loaded = await loadPrompt({ kind: "text", text: "  keep  " }, process.cwd());
  if (isIoError(loaded)) assert.fail(loaded.error);
  assert.equal(loaded.text, "  keep  ");
});

test("loadPrompt refuses a none source", async () => {
  const loaded = await loadPrompt({ kind: "none" }, process.cwd());
  assert.ok(isIoError(loaded));
});

// ----------------------------------------------------------- readTextFile

test("a normal file is read, BOM-stripped and trimmed", async () => {
  const root = await tempDir();
  const file = path.join(root, "task.md");
  await fs.writeFile(file, "\uFEFF  review the diff  \n");
  const loaded = await readTextFile("task.md", root, "prompt file");
  if (isIoError(loaded)) assert.fail(loaded.error);
  assert.equal(loaded.text, "review the diff");
  assert.equal(loaded.path, file);
});

test("a missing file is a clear error, not an exception", async () => {
  const root = await tempDir();
  const loaded = await readTextFile("nope.md", root, "prompt file");
  assert.ok(isIoError(loaded));
  assert.match(loaded.error, /not found/);
});

test("a directory is refused", async () => {
  const root = await tempDir();
  const loaded = await readTextFile(".", root, "prompt file");
  assert.ok(isIoError(loaded));
  assert.match(loaded.error, /directory/);
});

test("an empty or whitespace-only file is refused", async () => {
  const root = await tempDir();
  await fs.writeFile(path.join(root, "empty.md"), "");
  await fs.writeFile(path.join(root, "blank.md"), "  \n\t\n");
  const empty = await readTextFile("empty.md", root);
  const blank = await readTextFile("blank.md", root);
  assert.ok(isIoError(empty));
  assert.ok(isIoError(blank));
  assert.match(empty.error, /empty/);
  assert.match(blank.error, /empty/);
});

test("an oversized file is refused before it is fully parsed as a prompt", async () => {
  const root = await tempDir();
  const big = path.join(root, "big.md");
  await fs.writeFile(big, Buffer.alloc(MAX_PROMPT_BYTES + 1, 0x61));
  const loaded = await readTextFile("big.md", root, "prompt file");
  assert.ok(isIoError(loaded));
  assert.match(loaded.error, /exceeds/);
});

test("an empty path is refused", async () => {
  const loaded = await readTextFile("  ", process.cwd());
  assert.ok(isIoError(loaded));
  assert.match(loaded.error, /empty/);
});

// -------------------------------------------------------------- readStdin

test("piped text is returned trimmed", async () => {
  const loaded = await readStdin(Readable.from(["  hello from stdin  \n"]));
  if (isIoError(loaded)) assert.fail(loaded.error);
  assert.equal(loaded.text, "hello from stdin");
});

test("empty stdin is an error", async () => {
  const loaded = await readStdin(Readable.from([]));
  assert.ok(isIoError(loaded));
  assert.match(loaded.error, /empty/);
});

test("oversized stdin is refused", async () => {
  const loaded = await readStdin(Readable.from([Buffer.alloc(MAX_PROMPT_BYTES + 8, 0x62)]), MAX_PROMPT_BYTES);
  assert.ok(isIoError(loaded));
  assert.match(loaded.error, /exceeds/);
});

test("chunked stdin is concatenated", async () => {
  const loaded = await readStdin(Readable.from(["hel", "lo ", "world"]));
  if (isIoError(loaded)) assert.fail(loaded.error);
  assert.equal(loaded.text, "hello world");
});

// ----------------------------------------------------------- writeTextFile

test("writeTextFile creates parent directories and overwrites a file", async () => {
  const root = await tempDir();
  const dest = path.join("nested", "out", "answer.md");
  const first = await writeTextFile(dest, root, "one");
  if (isIoError(first)) assert.fail(first.error);
  const second = await writeTextFile(dest, root, "two");
  if (isIoError(second)) assert.fail(second.error);
  assert.equal(await fs.readFile(first.path, "utf8"), "two");
});

test("writeTextFile refuses a directory target", async () => {
  const root = await tempDir();
  const written = await writeTextFile(".", root, "nope");
  assert.ok(isIoError(written));
  assert.match(written.error, /directory/);
});

test("writeTextFile refuses '-' so stdout is not clobbered as a path", async () => {
  const written = await writeTextFile("-", process.cwd(), "x");
  assert.ok(isIoError(written));
  assert.match(written.error, /cannot be '-'/);
});

test("writeTextFile refuses an empty path", async () => {
  const written = await writeTextFile("  ", process.cwd(), "x");
  assert.ok(isIoError(written));
  assert.match(written.error, /empty/);
});
