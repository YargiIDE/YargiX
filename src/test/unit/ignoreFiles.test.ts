/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * gitignore-syntax matching used by ListDir.
 *
 * Patterns have to behave like git: last match wins, a leading slash anchors
 * to the ignore file's directory, and nested files only apply under themselves.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  ancestorRels,
  isIgnored,
  loadIgnoreRules,
  parseIgnoreText,
  truthyFlag,
} from "../../agent/tools/ignoreFiles";

function ignored(text: string, rel: string, isDir = false, base = ""): boolean {
  return isIgnored(parseIgnoreText(text, base), rel, isDir);
}

// ---------------------------------------------------------------- parsing

test("blank lines and comments are skipped", () => {
  const rules = parseIgnoreText("# keep\n\n  \n*.log", "");
  assert.equal(rules.length, 1);
});

test("unanchored names match at any depth", () => {
  assert.equal(ignored("*.log", "debug.log"), true);
  assert.equal(ignored("*.log", "src/debug.log"), true);
  assert.equal(ignored("build", "src/build", true), true);
  assert.equal(ignored("build", "README.md"), false);
});

test("a leading slash anchors to the ignore file's directory", () => {
  assert.equal(ignored("/secret.env", "secret.env"), true);
  assert.equal(ignored("/secret.env", "src/secret.env"), false);
});

test("a directory-only pattern does not hide a same-named file", () => {
  assert.equal(ignored("build/", "build", true), true);
  assert.equal(ignored("build/", "build", false), false);
});

test("the last matching rule wins, including negation", () => {
  const text = "*.log\n!keep.log\n";
  assert.equal(ignored(text, "debug.log"), true);
  assert.equal(ignored(text, "keep.log"), false);
  assert.equal(ignored("*.log\n!keep.log\nkeep.log", "keep.log"), true);
});

test("nested rules only apply under their directory", () => {
  const rules = [
    ...parseIgnoreText("*.tmp", ""),
    ...parseIgnoreText("!keep.tmp\nlocal.log", "src"),
  ];
  assert.equal(isIgnored(rules, "scratch.tmp", false), true);
  assert.equal(isIgnored(rules, "src/keep.tmp", false), false);
  assert.equal(isIgnored(rules, "src/local.log", false), true);
  assert.equal(isIgnored(rules, "local.log", false), false);
});

test("interior slashes also anchor the pattern", () => {
  assert.equal(ignored("src/*.ts", "src/a.ts"), true);
  assert.equal(ignored("src/*.ts", "lib/a.ts"), false);
  assert.equal(ignored("src/*.ts", "a.ts"), false);
});

// ----------------------------------------------------------- ancestors

test("ancestorRels walks from the workspace root down to the listed dir", () => {
  assert.deepEqual(ancestorRels(""), [""]);
  assert.deepEqual(ancestorRels("."), [""]);
  assert.deepEqual(ancestorRels("src"), ["", "src"]);
  assert.deepEqual(ancestorRels("src/agent/tools"), ["", "src", "src/agent", "src/agent/tools"]);
});

test("truthyFlag accepts a boolean or the string true", () => {
  assert.equal(truthyFlag(true), true);
  assert.equal(truthyFlag("true"), true);
  assert.equal(truthyFlag(false), false);
  assert.equal(truthyFlag("yes"), false);
  assert.equal(truthyFlag(undefined), false);
});

// -------------------------------------------------------------- loading

test("loadIgnoreRules concatenates gitignore, cursorignore, and yargixignore", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yargix-ignore-"));
  await fs.writeFile(path.join(root, ".gitignore"), "*.log\n");
  await fs.writeFile(path.join(root, ".cursorignore"), ".env\n");
  await fs.writeFile(path.join(root, ".yargixignore"), "scratch/\n");
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", ".gitignore"), "local.bin\n");

  const rootRules = await loadIgnoreRules(root, "");
  assert.equal(isIgnored(rootRules, "a.log", false), true);
  assert.equal(isIgnored(rootRules, ".env", false), true);
  assert.equal(isIgnored(rootRules, "scratch", true), true);
  assert.equal(isIgnored(rootRules, "local.bin", false), false);

  const srcRules = await loadIgnoreRules(root, "src");
  assert.equal(isIgnored(srcRules, "src/local.bin", false), true);
  assert.equal(isIgnored(srcRules, "src/a.log", false), true);
  assert.equal(isIgnored(srcRules, "local.bin", false), false);

  await fs.rm(root, { recursive: true, force: true });
});
