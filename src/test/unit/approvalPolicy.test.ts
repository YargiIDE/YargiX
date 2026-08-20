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
  splitShellCommands,
  matchPattern,
  evaluateApproval,
  deniedSubject,
  isOutsideWorkspace,
  subjectsFor,
  DEFAULT_APPROVAL,
  type ApprovalPolicy,
  type ApprovalRule,
} from "../../agent/approvalPolicy";

/** Build a policy where only `shell` differs from the safe defaults. */
function shellPolicy(rule: Partial<ApprovalRule>): ApprovalPolicy {
  return {
    ...DEFAULT_APPROVAL,
    shell: { mode: "allow", allowlist: [], denylist: [], ...rule },
  };
}

// ---------------------------------------------------------------- splitting

test("splitShellCommands splits on ; && || | and newlines", () => {
  assert.deepEqual(splitShellCommands("git add -A; git commit -m x"), ["git add -A", "git commit -m x"]);
  assert.deepEqual(splitShellCommands("a && b"), ["a", "b"]);
  assert.deepEqual(splitShellCommands("a || b"), ["a", "b"]);
  assert.deepEqual(splitShellCommands("a | b"), ["a", "b"]);
  assert.deepEqual(splitShellCommands("a\nb"), ["a", "b"]);
});

test("splitShellCommands keeps separators that live inside quotes", () => {
  assert.deepEqual(splitShellCommands(`echo "a; b"`), [`echo "a; b"`]);
  assert.deepEqual(splitShellCommands(`echo 'a && b'`), [`echo 'a && b'`]);
});

test("splitShellCommands unwraps a sub-shell body so it is still checked", () => {
  assert.deepEqual(splitShellCommands("(git commit -m x)"), ["git commit -m x"]);
  assert.deepEqual(splitShellCommands("$(rm -rf /)"), ["rm -rf /"]);
});

test("a backslash before a single quote does not extend the quote (POSIX)", () => {
  // Regression: treating \' as an escape inside single quotes swallowed the rest
  // of the line into one command, so a denied command could ride along unchecked.
  const parts = splitShellCommands(`echo 'it\\'; rm -rf /tmp/x`);
  assert.ok(parts.length >= 2, `expected the chained command to be split out, got ${JSON.stringify(parts)}`);
  assert.ok(parts.some((p) => p.startsWith("rm -rf")), `expected an rm command, got ${JSON.stringify(parts)}`);
});

test("a backslash-escaped double quote does keep the quote open", () => {
  assert.deepEqual(splitShellCommands(`echo "a\\"; b"`), [`echo "a\\"; b"`]);
});

// ---------------------------------------------------------------- matching

test("matchPattern matches commands on a token boundary only", () => {
  assert.equal(matchPattern("git", "git", true), true);
  assert.equal(matchPattern("git", "git status", true), true);
  // Regression: a bare startsWith let an allowlisted "git" cover unrelated binaries.
  assert.equal(matchPattern("git", "gitfoo", true), false);
  assert.equal(matchPattern("git", "git-crypt unlock", true), false);
});

test("matchPattern still allows URL prefixes", () => {
  assert.equal(matchPattern("https://example.com", "https://example.com/a/b", true), true);
  assert.equal(matchPattern("https://example.com", "https://example.com.evil.test/x", true), false);
});

test("matchPattern wildcards: * is greedy for commands", () => {
  assert.equal(matchPattern("npm run *", "npm run build", true), true);
  assert.equal(matchPattern("git *", "git push --force", true), true);
});

test("matchPattern path globs: * stays in a segment, ** crosses dirs", () => {
  assert.equal(matchPattern("*.md", "README.md", false), true);
  assert.equal(matchPattern("*.md", "docs/README.md", false), true, "basename fallback");
  assert.equal(matchPattern("src/*.ts", "src/a.ts", false), true);
  assert.equal(matchPattern("src/*.ts", "src/deep/a.ts", false), false);
  assert.equal(matchPattern("src/**", "src/deep/a.ts", false), true);
  // "dir/**" also covers the directory itself (listing an approved folder).
  assert.equal(matchPattern("src/**", "src", false), true);
});

// ---------------------------------------------------------------- policy

test("deny list beats allow list beats mode", () => {
  const policy = shellPolicy({ mode: "allow", denylist: ["rm"] });
  assert.equal(evaluateApproval(policy, "Shell", { command: "ls" }), "allow");
  assert.equal(evaluateApproval(policy, "Shell", { command: "rm -rf x" }), "deny");

  const asking = shellPolicy({ mode: "ask", allowlist: ["ls"] });
  assert.equal(evaluateApproval(asking, "Shell", { command: "ls" }), "allow");
  assert.equal(evaluateApproval(asking, "Shell", { command: "cat x" }), "ask");
});

test("a denied command cannot be smuggled behind an allowed one", () => {
  const policy = shellPolicy({ mode: "allow", denylist: ["git commit"] });
  assert.equal(evaluateApproval(policy, "Shell", { command: "git add -A; git commit -m x" }), "deny");
  assert.equal(deniedSubject(policy, "Shell", { command: "git add -A; git commit -m x" }), "git commit -m x");
});

test("review mode asks for risky commands and allows tame ones", () => {
  const policy = shellPolicy({ mode: "review" });
  assert.equal(evaluateApproval(policy, "Shell", { command: "ls -la" }), "allow");
  assert.equal(evaluateApproval(policy, "Shell", { command: "rm -rf /" }), "ask");
  assert.equal(evaluateApproval(policy, "Shell", { command: "sudo reboot" }), "ask");
});

test("the strictest decision across chained commands wins", () => {
  const policy = shellPolicy({ mode: "review" });
  assert.equal(evaluateApproval(policy, "Shell", { command: "ls && rm -rf /tmp/x" }), "ask");
});

test("subjectsFor splits shell input but leaves other action types intact", () => {
  assert.deepEqual(subjectsFor("shell", "Shell", { command: "a; b" }), ["a", "b"]);
  assert.deepEqual(subjectsFor("edits", "Write", { path: "src/a.ts" }), ["src/a.ts"]);
});

test("ungated tools are allowed outright", () => {
  assert.equal(evaluateApproval(DEFAULT_APPROVAL, "Grep", { pattern: "x" }), "allow");
});

// ---------------------------------------------------------------- workspace

test("isOutsideWorkspace detects escapes and accepts inside paths", () => {
  const root = process.platform === "win32" ? "C:\\ws" : "/ws";
  assert.equal(isOutsideWorkspace("src/a.ts", root), false);
  assert.equal(isOutsideWorkspace("./src/a.ts", root), false);
  assert.equal(isOutsideWorkspace("../secret.txt", root), true);
  assert.equal(isOutsideWorkspace("src/../../secret.txt", root), true);
});

test("path-bearing tools escalate to the outside rule when they leave the root", () => {
  const root = process.platform === "win32" ? "C:\\ws" : "/ws";
  const policy: ApprovalPolicy = { ...DEFAULT_APPROVAL, outside: { mode: "deny", allowlist: [], denylist: [] } };
  // Read is normally ungated, but not when it reaches outside the workspace.
  assert.equal(evaluateApproval(policy, "Read", { path: "../../etc/passwd" }, root), "deny");
  assert.equal(evaluateApproval(policy, "Read", { path: "src/a.ts" }, root), "allow");
});
