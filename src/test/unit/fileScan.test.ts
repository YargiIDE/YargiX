/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * File discovery ignore rules.
 *
 * Settings already lets you edit `.cursorignore`, but search and the semantic
 * index used to honor only `.gitignore`. A secret that is committed (or a
 * generated tree that git tracks) must still be skippable without turning
 * `useGitignore` off.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  EXTRA_IGNORE_FILENAMES,
  IGNORE_FILENAMES,
  existingExtraIgnoreFiles,
  isIgnored,
  parseGitignore,
  scanFiles,
} from "../../agent/tools/fileScan";

async function tempRepo(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "yargix-scan-"));
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
  }
}

function rels(files: { rel: string }[]): string[] {
  return files.map((f) => f.rel).sort();
}

function ignored(text: string, file: string, isDir = false, base = ""): boolean {
  return isIgnored(parseGitignore(text, base), file, isDir);
}

// ----------------------------------------------------------- matcher

test("comments, blanks, and malformed lines are skipped", () => {
  const rules = parseGitignore("# secrets\n\n  \nsecrets/\n");
  assert.equal(rules.length, 1);
  assert.equal(isIgnored(rules, "secrets", true), true);
  assert.equal(isIgnored(rules, "src/app.ts", false), false);
});

test("an unanchored name matches at any depth", () => {
  assert.equal(ignored("build", "build", true), true);
  assert.equal(ignored("build", "pkg/build", true), true);
  assert.equal(ignored("*.log", "debug.log"), true);
  assert.equal(ignored("*.log", "nested/app.log"), true);
  assert.equal(ignored("*.log", "app.ts"), false);
});

test("a leading slash anchors the pattern to the ignore file's directory", () => {
  assert.equal(ignored("/dist", "dist", true), true);
  assert.equal(ignored("/dist", "pkg/dist", true), false);
});

test("a trailing slash matches directories only", () => {
  assert.equal(ignored("tmp/", "tmp", true), true);
  assert.equal(ignored("tmp/", "tmp", false), false);
});

test("the last matching rule wins, so a negation can un-ignore", () => {
  const text = "*.log\n!keep.log\n";
  assert.equal(ignored(text, "debug.log"), true);
  assert.equal(ignored(text, "keep.log"), false);
});

test("rules from a nested ignore file only apply under that directory", () => {
  const rules = parseGitignore("local.bin\n", "pkg");
  assert.equal(isIgnored(rules, "pkg/local.bin", false), true);
  assert.equal(isIgnored(rules, "local.bin", false), false);
  assert.equal(isIgnored(rules, "other/local.bin", false), false);
});

test("IGNORE_FILENAMES lists gitignore first, then the agent-specific files", () => {
  assert.deepEqual([...IGNORE_FILENAMES], [".gitignore", ".cursorignore", ".yargixignore"]);
  assert.deepEqual([...EXTRA_IGNORE_FILENAMES], [".cursorignore", ".yargixignore"]);
});

// ----------------------------------------------------------- existingExtraIgnoreFiles

test("existingExtraIgnoreFiles reports only agent ignore files that are present", async () => {
  const root = await tempRepo();
  await writeTree(root, {
    ".gitignore": "vendor/\n",
    ".cursorignore": "secrets/\n",
  });
  assert.deepEqual(await existingExtraIgnoreFiles(root), [".cursorignore"]);
  await fs.writeFile(path.join(root, ".yargixignore"), "*.pem\n");
  assert.deepEqual(await existingExtraIgnoreFiles(root), [".cursorignore", ".yargixignore"]);
});

test("existingExtraIgnoreFiles skips directories that share an ignore-file name", async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, ".cursorignore"));
  assert.deepEqual(await existingExtraIgnoreFiles(root), []);
});

// ----------------------------------------------------------- scanFiles

test("scanFiles still honors .gitignore", async () => {
  const root = await tempRepo();
  await writeTree(root, {
    ".gitignore": "generated/\n",
    "src/app.ts": "export {}\n",
    "generated/lib.js": "module.exports = 1\n",
  });
  const { files } = await scanFiles(root, { timeMs: 5_000 });
  const names = rels(files);
  assert.ok(names.includes("src/app.ts"));
  assert.ok(!names.includes("generated/lib.js"));
});

test("scanFiles honors .cursorignore in addition to .gitignore", async () => {
  const root = await tempRepo();
  await writeTree(root, {
    ".gitignore": "generated/\n",
    ".cursorignore": "secrets/\n",
    "src/app.ts": "export {}\n",
    "generated/lib.js": "module.exports = 1\n",
    "secrets/key.pem": "not-a-real-key\n",
  });
  const { files } = await scanFiles(root, { timeMs: 5_000 });
  const names = rels(files);
  assert.ok(names.includes("src/app.ts"));
  assert.ok(!names.includes("generated/lib.js"), "gitignore still applies");
  assert.ok(!names.includes("secrets/key.pem"), "cursorignore must hide secrets");
});

test("scanFiles honors .yargixignore patterns", async () => {
  const root = await tempRepo();
  await writeTree(root, {
    ".yargixignore": "*.pem\n",
    "src/app.ts": "export {}\n",
    "certs/prod.pem": "not-a-real-key\n",
  });
  const { files } = await scanFiles(root, { timeMs: 5_000 });
  const names = rels(files);
  assert.ok(names.includes("src/app.ts"));
  assert.ok(!names.includes("certs/prod.pem"));
});

test("a nested .cursorignore only hides files under that directory", async () => {
  const root = await tempRepo();
  await writeTree(root, {
    "pkg/.cursorignore": "local.bin\n",
    "pkg/local.bin": "x\n",
    "pkg/ok.ts": "export {}\n",
    "local.bin": "root copy\n",
  });
  const { files } = await scanFiles(root, { timeMs: 5_000 });
  const names = rels(files);
  assert.ok(names.includes("pkg/ok.ts"));
  assert.ok(names.includes("local.bin"), "root copy must stay visible");
  assert.ok(!names.includes("pkg/local.bin"));
});

test("useGitignore: false skips every ignore file, including .cursorignore", async () => {
  const root = await tempRepo();
  await writeTree(root, {
    ".gitignore": "generated/\n",
    ".cursorignore": "secrets/\n",
    "generated/lib.js": "module.exports = 1\n",
    "secrets/key.pem": "not-a-real-key\n",
  });
  const { files } = await scanFiles(root, { useGitignore: false, timeMs: 5_000 });
  const names = rels(files);
  assert.ok(names.includes("generated/lib.js"));
  assert.ok(names.includes("secrets/key.pem"));
});
