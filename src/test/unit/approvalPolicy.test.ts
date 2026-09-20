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
  actionTypesForCall,
  DEFAULT_APPROVAL,
  PATH_INPUTS,
  type ApprovalActionType,
  type ApprovalPolicy,
  type ApprovalRule,
} from "../../agent/approvalPolicy";
import { TOOL_SPECS } from "../../agent/tools/schemas";

/** Build a policy where only `shell` differs from the safe defaults. */
function shellPolicy(rule: Partial<ApprovalRule>): ApprovalPolicy {
  return {
    ...DEFAULT_APPROVAL,
    shell: { mode: "allow", allowlist: [], denylist: [], ...rule },
  };
}

const WS_ROOT = process.platform === "win32" ? "C:\\ws" : "/ws";

/** Build a policy from per-type overrides, filling the rest with safe defaults. */
function policyOf(overrides: Partial<Record<ApprovalActionType, Partial<ApprovalRule>>>): ApprovalPolicy {
  const out = { ...DEFAULT_APPROVAL };
  for (const [type, rule] of Object.entries(overrides)) {
    out[type as ApprovalActionType] = { mode: "ask", allowlist: [], denylist: [], ...rule };
  }
  return out;
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

// ------------------------------------------------------- additive escalation

test("leaving the workspace adds the outside gate instead of replacing the tool's own", () => {
  assert.deepEqual(actionTypesForCall("Write", { path: "src/a.ts" }, WS_ROOT), ["edits"]);
  assert.deepEqual(actionTypesForCall("Write", { path: "../a.ts" }, WS_ROOT), ["edits", "outside"]);
  // Read has no gate of its own, so outside is the only one it answers to.
  assert.deepEqual(actionTypesForCall("Read", { path: "../a.ts" }, WS_ROOT), ["outside"]);
  assert.deepEqual(actionTypesForCall("Read", { path: "src/a.ts" }, WS_ROOT), []);
});

test("a denied action cannot be freed by moving it outside the workspace", () => {
  // Regression: the outside rule used to *replace* the tool's own rule, so a
  // loose outside rule waved through the very thing edits/delete/shell denied —
  // a denied edit simply moved one directory up.
  const policy = policyOf({
    edits: { mode: "deny" },
    delete: { mode: "deny" },
    shell: { mode: "deny" },
    outside: { mode: "allow" },
  });
  assert.equal(evaluateApproval(policy, "Write", { path: "../a.ts" }, WS_ROOT), "deny");
  assert.equal(evaluateApproval(policy, "StrReplace", { path: "../a.ts" }, WS_ROOT), "deny");
  assert.equal(evaluateApproval(policy, "Delete", { path: "../a.ts" }, WS_ROOT), "deny");
  assert.equal(evaluateApproval(policy, "Shell", { command: "ls", working_directory: ".." }, WS_ROOT), "deny");
});

test("an outside path still cannot be freed by a permissive tool rule", () => {
  const policy = policyOf({ edits: { mode: "allow" }, outside: { mode: "deny" } });
  assert.equal(evaluateApproval(policy, "Write", { path: "../a.ts" }, WS_ROOT), "deny");
  assert.equal(evaluateApproval(policy, "Write", { path: "src/a.ts" }, WS_ROOT), "allow");
});

test("the stricter of the two gates wins", () => {
  const asking = policyOf({ edits: { mode: "ask" }, outside: { mode: "allow" } });
  assert.equal(evaluateApproval(asking, "Write", { path: "../a.ts" }, WS_ROOT), "ask");

  const allowed = policyOf({ edits: { mode: "allow" }, outside: { mode: "allow" } });
  assert.equal(evaluateApproval(allowed, "Write", { path: "../a.ts" }, WS_ROOT), "allow");
});

// ------------------------------------------------------------- gate coverage

test("path inputs that write or read outside the workspace are gated", () => {
  const policy = policyOf({ outside: { mode: "deny" } });
  // FetchMcpResource writes the resource to disk and has no gate of its own, so
  // an unlisted downloadPath made it an unapproved arbitrary-write primitive.
  assert.equal(evaluateApproval(policy, "FetchMcpResource", { server: "s", uri: "u", downloadPath: "../../evil.sh" }, WS_ROOT), "deny");
  assert.equal(evaluateApproval(policy, "ReadLints", { paths: ["../../etc"] }, WS_ROOT), "deny");
  // Task reads each attachment into a subagent's context.
  assert.equal(evaluateApproval(policy, "Task", { file_attachments: ["../../secrets/id_rsa"] }, WS_ROOT), "deny");
  // Staying inside the workspace leaves them ungated, as before.
  assert.equal(evaluateApproval(policy, "FetchMcpResource", { server: "s", uri: "u", downloadPath: "out/x" }, WS_ROOT), "allow");
});

test("every path-bearing tool input is listed in PATH_INPUTS", () => {
  // Drift guard: a schema that grows a path input without being gated here would
  // silently escape the outside check, which is how the three above were missed.
  const pathLike = /^(path|paths|downloadPath|.*_?(?:file|files|dir|dirs|directory|directories|notebook|attachments))$/i;
  const missing: string[] = [];
  for (const [tool, spec] of Object.entries(TOOL_SPECS)) {
    const properties = (spec.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    for (const name of Object.keys(properties)) {
      if (pathLike.test(name) && !(PATH_INPUTS[tool] ?? []).includes(name)) missing.push(`${tool}.${name}`);
    }
  }
  assert.deepEqual(missing, [], `ungated path inputs: ${missing.join(", ")}`);
});

test("PATH_INPUTS does not name inputs the schemas do not have", () => {
  const unknown: string[] = [];
  for (const [tool, keys] of Object.entries(PATH_INPUTS)) {
    const spec = TOOL_SPECS[tool];
    if (!spec) {
      unknown.push(tool);
      continue;
    }
    const properties = (spec.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    for (const key of keys) if (!(key in properties)) unknown.push(`${tool}.${key}`);
  }
  assert.deepEqual(unknown, []);
});

// --------------------------------------------------------- outside subjects

test("each escaping path is its own subject, so none rides along behind another", () => {
  // Regression: every path used to be joined into one "../a, ../b" subject, which
  // matched no pattern at all — an outside allow/deny rule was dead weight for
  // any tool that takes a list of paths.
  const policy = policyOf({ outside: { mode: "allow", denylist: [outsidePattern("a")] } });
  assert.equal(evaluateApproval(policy, "SemanticSearch", { target_directories: ["../a"] }, WS_ROOT), "deny");
  assert.equal(evaluateApproval(policy, "SemanticSearch", { target_directories: ["../b", "../a"] }, WS_ROOT), "deny");
  assert.equal(deniedSubject(policy, "SemanticSearch", { target_directories: ["../b", "../a"] }, WS_ROOT), outsidePath("a"));
  assert.equal(evaluateApproval(policy, "SemanticSearch", { target_directories: ["../b"] }, WS_ROOT), "allow");
});

test("outside subjects are the resolved path, so one target cannot be spelled two ways", () => {
  assert.deepEqual(subjectsFor("outside", "Write", { path: "../a" }, WS_ROOT), [outsidePath("a")]);
  assert.deepEqual(subjectsFor("outside", "Write", { path: "../x/../a" }, WS_ROOT), [outsidePath("a")]);
  // Only the escaping paths answer to the outside rule.
  assert.deepEqual(subjectsFor("outside", "SemanticSearch", { target_directories: ["src", "../a"] }, WS_ROOT), [outsidePath("a")]);
  // Repeats collapse rather than asking the same question twice.
  assert.deepEqual(subjectsFor("outside", "SemanticSearch", { target_directories: ["../a", "../a"] }, WS_ROOT), [outsidePath("a")]);
});

/** A path one level above the workspace root, as the outside gate resolves it. */
function outsidePath(name: string): string {
  return process.platform === "win32" ? `C:\\${name}` : `/${name}`;
}

/** The same path as a rule pattern: `matchPattern` compares on forward slashes. */
function outsidePattern(name: string): string {
  return outsidePath(name).replace(/\\/g, "/");
}
