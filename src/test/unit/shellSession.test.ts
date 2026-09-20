/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import { applyCwdSideEffect, type ShellSession } from "../../agent/tools/shared";

const ROOT = path.resolve("fake-workspace");

function session(cwd = ROOT): ShellSession {
  return { cwd, queue: Promise.resolve(), running: new Set() };
}

test("a bare cd inside the workspace moves the session cwd", () => {
  const s = session();
  applyCwdSideEffect(s, "cd src", ROOT);
  assert.equal(s.cwd, path.join(ROOT, "src"));
});

test("an absolute cd inside the workspace moves the session cwd", () => {
  const s = session();
  applyCwdSideEffect(s, `cd ${path.join(ROOT, "docs")}`, ROOT);
  assert.equal(s.cwd, path.join(ROOT, "docs"));
});

test("cd outside the workspace is ignored so the session cannot drift out", () => {
  // Regression: `cd /etc` used to move session.cwd anywhere, and later commands
  // run there without re-consulting the "outside" rule — a silent sandbox exit.
  const outside = path.resolve(path.dirname(ROOT), "elsewhere");
  const s = session();
  applyCwdSideEffect(s, `cd ${outside}`, ROOT);
  assert.equal(s.cwd, ROOT);
});

test("cd .. that would escape the workspace is ignored", () => {
  const s = session();
  applyCwdSideEffect(s, "cd ..", ROOT);
  assert.equal(s.cwd, ROOT);
});

test("cd .. that stays inside the workspace still works", () => {
  const s = session(path.join(ROOT, "src"));
  applyCwdSideEffect(s, "cd ..", ROOT);
  assert.equal(s.cwd, ROOT);
});

test("non-cd commands and cd - leave the cwd alone", () => {
  const s = session();
  applyCwdSideEffect(s, "cd src && rm -rf x", ROOT);
  applyCwdSideEffect(s, "cd -", ROOT);
  applyCwdSideEffect(s, "ls -la", ROOT);
  assert.equal(s.cwd, ROOT);
});
