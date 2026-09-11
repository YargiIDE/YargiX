/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * CLI least-privilege policy.
 *
 * `--auto` must never override `--deny`, a typo in `--allow` must fail the
 * parse rather than silently deny, and `--strict` is the only way a blocked
 * action becomes a non-zero exit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateApproval } from "../../agent/approvalPolicy";
import {
  ACTION_TYPES,
  buildCliPolicy,
  parseActionTypes,
  resolveCliApproval,
  runExitCode,
  uniqueTypes,
} from "../../cli/policy";

test("every action type parses, including aliases", () => {
  for (const type of ACTION_TYPES) {
    const parsed = parseActionTypes(type);
    assert.ok(!("error" in parsed), `${type} should parse`);
    assert.deepEqual(parsed.types, [type]);
  }
  assert.deepEqual(typesOf("write"), ["edits"]);
  assert.deepEqual(typesOf("command"), ["shell"]);
  assert.deepEqual(typesOf("fetch"), ["web"]);
  assert.deepEqual(typesOf("external"), ["outside"]);
});

test("comma and space lists accumulate without duplicates", () => {
  assert.deepEqual(typesOf("edits,web"), ["edits", "web"]);
  assert.deepEqual(typesOf("edits web shell"), ["edits", "web", "shell"]);
  assert.deepEqual(typesOf("edits, edits, write"), ["edits"]);
});

function typesOf(raw: string) {
  const parsed = parseActionTypes(raw);
  if ("error" in parsed) assert.fail(`expected types, got: ${parsed.error}`);
  return parsed.types;
}

test("an unknown type is an error, not a silent skip", () => {
  const parsed = parseActionTypes("edits,sudo");
  assert.ok("error" in parsed);
  assert.match(parsed.error, /unknown action type "sudo"/);
});

test("all / * point at --auto instead of being treated as a type", () => {
  const parsed = parseActionTypes("all");
  assert.ok("error" in parsed);
  assert.match(parsed.error, /--auto/);
});

test("an empty list is an error", () => {
  const parsed = parseActionTypes(" ,  ");
  assert.ok("error" in parsed);
  assert.match(parsed.error, /no action types/);
});

test("uniqueTypes keeps first-seen order", () => {
  assert.deepEqual(uniqueTypes(["web", "edits", "web", "shell"]), ["web", "edits", "shell"]);
});

test("default policy asks for every gated type (unattended then refuses)", () => {
  const policy = buildCliPolicy({ auto: false, allow: [], deny: [] });
  assert.equal(evaluateApproval(policy, "Write", { path: "a.ts" }), "ask");
  assert.equal(evaluateApproval(policy, "Shell", { command: "ls" }), "ask");
  assert.equal(evaluateApproval(policy, "Delete", { path: "a.ts" }), "ask");
  assert.equal(evaluateApproval(policy, "WebFetch", { url: "https://example.com" }), "ask");
  // Read stays ungated inside the workspace.
  assert.equal(evaluateApproval(policy, "Read", { path: "a.ts" }), "allow");
});

test("--auto allows every type except an explicit deny", () => {
  const policy = buildCliPolicy({ auto: true, allow: [], deny: ["shell"] });
  assert.equal(evaluateApproval(policy, "Write", { path: "a.ts" }), "allow");
  assert.equal(evaluateApproval(policy, "Shell", { command: "ls" }), "deny");
  assert.equal(evaluateApproval(policy, "WebSearch", { search_term: "x" }), "allow");
});

test("--allow is per-type and does not imply --auto", () => {
  const policy = buildCliPolicy({ auto: false, allow: ["edits"], deny: [] });
  assert.equal(evaluateApproval(policy, "Write", { path: "README.md" }), "allow");
  assert.equal(evaluateApproval(policy, "StrReplace", { path: "a.ts" }), "allow");
  assert.equal(evaluateApproval(policy, "Shell", { command: "pnpm test" }), "ask");
  assert.equal(evaluateApproval(policy, "Delete", { path: "a.ts" }), "ask");
});

test("--deny wins over --allow of the same type", () => {
  const policy = buildCliPolicy({ auto: false, allow: ["edits", "shell"], deny: ["edits"] });
  assert.equal(evaluateApproval(policy, "Write", { path: "a.ts" }), "deny");
  assert.equal(evaluateApproval(policy, "Shell", { command: "ls" }), "allow");
});

test("unattended ask becomes a denial with a --allow hint", () => {
  const policy = buildCliPolicy({ auto: false, allow: [], deny: [] });
  const resolved = resolveCliApproval(policy, "Write", { path: "a.ts" }, "/repo", "unattended");
  assert.equal(resolved.decision, "ask");
  assert.equal(resolved.type, "edits");
  assert.notEqual(resolved.reply, true);
  assert.match((resolved.reply as { blockedSubject: string }).blockedSubject, /--allow edits/);
});

test("a hard deny names the --deny type", () => {
  const policy = buildCliPolicy({ auto: true, allow: [], deny: ["shell"] });
  const resolved = resolveCliApproval(policy, "Shell", { command: "rm -rf build" }, "/repo", "unattended");
  assert.equal(resolved.decision, "deny");
  assert.notEqual(resolved.reply, true);
  assert.match((resolved.reply as { blockedSubject: string }).blockedSubject, /--deny shell/);
  assert.match((resolved.reply as { blockedSubject: string }).blockedSubject, /rm -rf build/);
});

test("interactive ask leaves the reply unset so the REPL can prompt", () => {
  const policy = buildCliPolicy({ auto: false, allow: [], deny: [] });
  const resolved = resolveCliApproval(policy, "Write", { path: "a.ts" }, "/repo", "ask");
  assert.equal(resolved.decision, "ask");
  assert.equal(resolved.reply, undefined);
});

test("allowed tools resolve to true without a prompt", () => {
  const policy = buildCliPolicy({ auto: false, allow: ["web"], deny: [] });
  const resolved = resolveCliApproval(
    policy,
    "WebFetch",
    { url: "https://example.com" },
    "/repo",
    "ask",
  );
  assert.equal(resolved.reply, true);
});

test("outside-workspace reads are gated even when inside-workspace reads are not", () => {
  const policy = buildCliPolicy({ auto: false, allow: [], deny: ["outside"] });
  const resolved = resolveCliApproval(policy, "Read", { path: "../../etc/passwd" }, "/repo", "unattended");
  assert.equal(resolved.decision, "deny");
  assert.equal(resolved.type, "outside");
});

test("exit 1 beats a strict denial", () => {
  assert.equal(runExitCode({ failed: true, denied: 2, strict: true }), 1);
  assert.equal(runExitCode({ failed: false, denied: 2, strict: true }), 3);
  assert.equal(runExitCode({ failed: false, denied: 2, strict: false }), 0);
  assert.equal(runExitCode({ failed: false, denied: 0, strict: true }), 0);
});
