/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Prompt-tree ignore matching.
 *
 * A name that should stay hidden (secrets, node_modules, a gitignored build
 * folder) leaking into the cached prefix wastes tokens and can show the model
 * paths it must not open. Nested ignore files must not leak sideways.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isPathIgnored,
  isSecretName,
  parseIgnoreText,
  shouldHideEntry,
  VISIBLE_DOT_DIRS,
} from "../../context/treeIgnore";

function ignored(text: string, rel: string, isDir = false, base = ""): boolean {
  return isPathIgnored(parseIgnoreText(text, base), rel, isDir);
}

// ------------------------------------------------------------ parse / match

test("an unanchored name matches at any depth", () => {
  assert.equal(ignored("coverage\n", "coverage", true), true);
  assert.equal(ignored("coverage\n", "pkg/coverage", true), true);
  assert.equal(ignored("coverage\n", "src/app.ts", false), false);
});

test("a leading slash anchors the pattern to the ignore file's directory", () => {
  assert.equal(ignored("/dist\n", "dist", true), true);
  assert.equal(ignored("/dist\n", "packages/dist", true), false);
});

test("an interior slash is relative to the ignore file, not any depth", () => {
  assert.equal(ignored("src/generated\n", "src/generated", true), true);
  assert.equal(ignored("src/generated\n", "lib/src/generated", true), false);
});

test("*.log matches a basename at any depth", () => {
  assert.equal(ignored("*.log\n", "debug.log"), true);
  assert.equal(ignored("*.log\n", "tmp/debug.log"), true);
  assert.equal(ignored("*.log\n", "debug.txt"), false);
});

test("a trailing slash only matches directories", () => {
  assert.equal(ignored("build/\n", "build", true), true);
  assert.equal(ignored("build/\n", "build", false), false);
});

test("the last matching rule wins, so negation can un-ignore", () => {
  const text = "*.log\n!keep.log\n";
  assert.equal(ignored(text, "debug.log"), true);
  assert.equal(ignored(text, "tmp/debug.log"), true);
  assert.equal(ignored(text, "keep.log"), false);
});

test("comments and blank lines are skipped", () => {
  assert.equal(ignored("# vendor\nvendor\n\n", "vendor", true), true);
  assert.equal(ignored("# vendor\n", "vendor", true), false);
});

test("nested rules only apply under their base directory", () => {
  const rules = parseIgnoreText("secret.txt\n", "pkg");
  assert.equal(isPathIgnored(rules, "pkg/secret.txt", false), true);
  assert.equal(isPathIgnored(rules, "other/secret.txt", false), false);
  assert.equal(isPathIgnored(rules, "secret.txt", false), false);
});

test("** spans directories", () => {
  assert.equal(ignored("**/gen/*\n", "src/gen/a.ts"), true);
  assert.equal(ignored("**/gen/*\n", "gen/a.ts"), true);
  assert.equal(ignored("**/gen/*\n", "src/other/a.ts"), false);
});

// ------------------------------------------------------------ hide policy

test("node_modules and .git are always hidden", () => {
  assert.equal(shouldHideEntry("node_modules", "node_modules", true, []), true);
  assert.equal(shouldHideEntry(".git", ".git", true, []), true);
  assert.equal(shouldHideEntry("vendor", "vendor", true, []), true);
});

test("secrets stay hidden even without an ignore file", () => {
  assert.equal(isSecretName(".env"), true);
  assert.equal(isSecretName(".env.production"), true);
  assert.equal(isSecretName(".env.example"), false);
  assert.equal(isSecretName("id_rsa"), true);
  assert.equal(isSecretName("server.pem"), true);
  assert.equal(shouldHideEntry(".env", ".env", false, []), true);
});

test("project-config dot directories are visible, other dots are not", () => {
  for (const name of VISIBLE_DOT_DIRS) {
    assert.equal(shouldHideEntry(name, name, true, []), false, `${name} should be visible`);
  }
  assert.equal(shouldHideEntry(".secret", ".secret", true, []), true);
  assert.equal(shouldHideEntry(".gitignore", ".gitignore", false, []), true);
});

test("an ignore rule can still hide a visible dot directory", () => {
  const rules = parseIgnoreText(".github\n");
  assert.equal(shouldHideEntry(".github", ".github", true, rules), true);
});

test("a regular source file is not hidden", () => {
  assert.equal(shouldHideEntry("main.ts", "src/main.ts", false, []), false);
});
