/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * The memory bank.
 *
 * Note names come from the model, so `safeMemoryName` is a trust boundary: it
 * must be impossible to write outside `.yargix/memory/`, and impossible to
 * create a dotfile or a `..` entry. The round-trip tests then check the notes
 * actually persist and that the prompt block stays bounded.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  safeMemoryName,
  writeMemory,
  readMemory,
  appendMemory,
  deleteMemory,
  listMemories,
  memoryForPrompt,
  MAX_PROMPT_BYTES,
  MEMORY_DIR,
} from "../../context/memoryBank";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "yargix-memtest-"));
}

// ------------------------------------------------------------ name safety

test("a plain name is kept, lowercased", () => {
  assert.equal(safeMemoryName("Architecture"), "architecture");
  assert.equal(safeMemoryName("build-notes"), "build-notes");
});

test("the .md extension is not doubled", () => {
  assert.equal(safeMemoryName("testing.md"), "testing");
});

test("path traversal cannot escape the memory directory", () => {
  for (const raw of ["../../etc/passwd", "..\\..\\windows\\system32", "/etc/shadow", "C:\\secrets.txt"]) {
    const safe = safeMemoryName(raw);
    assert.ok(!safe.includes("/"), `${raw} → ${safe} must not contain /`);
    assert.ok(!safe.includes("\\"), `${raw} → ${safe} must not contain \\`);
    assert.ok(!safe.includes(".."), `${raw} → ${safe} must not contain ..`);
    assert.ok(!path.isAbsolute(safe), `${raw} → ${safe} must not be absolute`);
  }
});

test("a name of only traversal characters falls back to a default", () => {
  for (const raw of ["..", ".", "../..", "", "///", "..."]) {
    const safe = safeMemoryName(raw);
    assert.ok(safe.length > 0, `${JSON.stringify(raw)} should produce a usable name`);
    assert.equal(safe, "notes");
  }
});

test("a name can never become a dotfile", () => {
  for (const raw of [".env", ".gitignore", ".ssh/id_rsa"]) {
    assert.ok(!safeMemoryName(raw).startsWith("."), `${raw} must not stay a dotfile`);
  }
});

test("exotic characters are collapsed, not passed through", () => {
  const safe = safeMemoryName('we"ird <name> | with; stuff');
  assert.match(safe, /^[a-z0-9._-]+$/);
});

test("names are length-capped", () => {
  assert.ok(safeMemoryName("x".repeat(500)).length <= 64);
});

test("null and undefined are handled", () => {
  assert.equal(safeMemoryName(undefined as unknown as string), "notes");
  assert.equal(safeMemoryName(null as unknown as string), "notes");
});

// ------------------------------------------------------------- round trips

test("a note can be written and read back", async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const note = await writeMemory("architecture", "The agent loop lives in loop.ts.", root);
  assert.equal(note.name, "architecture");
  assert.equal(note.path, `${MEMORY_DIR.replace(/\\/g, "/")}/architecture.md`);
  assert.match((await readMemory("architecture", root)) ?? "", /agent loop lives in loop\.ts/);
});

test("a traversing name still lands inside the memory directory", async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await writeMemory("../../escaped", "should not escape", root);
  const notes = await listMemories(root);
  assert.equal(notes.length, 1);
  assert.ok(notes[0].path.startsWith(MEMORY_DIR.replace(/\\/g, "/")), `landed at ${notes[0].path}`);
  // Nothing was created above the workspace root.
  await assert.rejects(() => fs.stat(path.join(root, "..", "escaped.md")));
});

test("append adds to an existing note without losing it", async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await writeMemory("gotchas", "First fact.", root);
  await appendMemory("gotchas", "Second fact.", root);
  const body = (await readMemory("gotchas", root)) ?? "";
  assert.match(body, /First fact\./);
  assert.match(body, /Second fact\./);
});

test("append to a missing note creates it", async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await appendMemory("fresh", "Only fact.", root);
  assert.match((await readMemory("fresh", root)) ?? "", /Only fact\./);
});

test("write replaces rather than appends", async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await writeMemory("decisions", "Old.", root);
  await writeMemory("decisions", "New.", root);
  const body = (await readMemory("decisions", root)) ?? "";
  assert.match(body, /New\./);
  assert.doesNotMatch(body, /Old\./);
});

test("delete removes a note and reports a miss honestly", async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await writeMemory("temp", "x", root);
  assert.equal(await deleteMemory("temp", root), true);
  assert.equal(await deleteMemory("temp", root), false);
  assert.equal(await readMemory("temp", root), undefined);
});

test("an absent memory bank lists as empty instead of throwing", async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  assert.deepEqual(await listMemories(root), []);
  assert.equal(await memoryForPrompt(root), "");
  assert.equal(await readMemory("nothing", root), undefined);
});

// ------------------------------------------------------------ prompt block

test("the prompt block contains each note, tagged with its name", async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await writeMemory("build", "Run pnpm compile.", root);
  await writeMemory("testing", "Run pnpm test:unit.", root);
  const block = await memoryForPrompt(root);
  assert.match(block, /<memory name="build"/);
  assert.match(block, /<memory name="testing"/);
  assert.match(block, /pnpm compile/);
  assert.match(block, /pnpm test:unit/);
});

test("one huge note cannot crowd the others out of the prompt", async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await writeMemory("huge", "H".repeat(20_000), root);
  await writeMemory("small", "SMALL-NOTE-MARKER", root);

  const block = await memoryForPrompt(root);
  assert.ok(block.length <= MAX_PROMPT_BYTES * 2, "block should stay bounded");
  assert.match(block, /SMALL-NOTE-MARKER/, "the small note must survive alongside the huge one");
  assert.match(block, /truncated/, "the huge note should be marked truncated");
});

test("empty notes are skipped in the prompt block", async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await writeMemory("blank", "   ", root);
  assert.equal(await memoryForPrompt(root), "");
});
