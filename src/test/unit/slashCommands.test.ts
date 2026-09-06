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
  SIDEBAR_HELP,
  SIDEBAR_MODES,
  interpretSidebarCommand,
  parseSidebarCommand,
} from "../../shared/slashCommands";

test("plain text is a prompt", () => {
  assert.deepEqual(parseSidebarCommand("fix the login bug"), { kind: "prompt", text: "fix the login bug" });
});

test("whitespace-only input is empty, not a command", () => {
  for (const line of ["", "  ", "\n"]) {
    assert.deepEqual(parseSidebarCommand(line), { kind: "empty" });
  }
});

test("help aliases are recognised", () => {
  for (const line of ["/help", "/h", "/?", "  /HELP  "]) {
    assert.equal(parseSidebarCommand(line).kind, "help", line);
  }
});

test("clear / new / reset start a fresh chat", () => {
  for (const line of ["/clear", "/new", "/reset"]) {
    assert.equal(parseSidebarCommand(line).kind, "clear", line);
  }
});

test("export defaults to markdown and accepts json or a filename", () => {
  assert.deepEqual(parseSidebarCommand("/export"), { kind: "export", format: "markdown" });
  assert.deepEqual(parseSidebarCommand("/export json"), { kind: "export", format: "json" });
  assert.deepEqual(parseSidebarCommand("/export notes.md"), { kind: "export", format: "markdown" });
  assert.deepEqual(parseSidebarCommand("/export dump.json"), { kind: "export", format: "json" });
});

test("mode and model keep the rest of the line as the value", () => {
  assert.deepEqual(parseSidebarCommand("/mode review"), { kind: "mode", value: "review" });
  assert.deepEqual(parseSidebarCommand("/model"), { kind: "model", value: "" });
  assert.deepEqual(parseSidebarCommand("/model claude-opus-5"), { kind: "model", value: "claude-opus-5" });
});

test("settings aliases open the settings panel", () => {
  for (const line of ["/settings", "/prefs", "/config"]) {
    assert.equal(parseSidebarCommand(line).kind, "settings", line);
  }
});

test("an unrecognised slash command is not a prompt", () => {
  const cmd = parseSidebarCommand("/whatever");
  assert.equal(cmd.kind, "unknown");
  if (cmd.kind === "unknown") assert.equal(cmd.name, "whatever");
});

test("a path that starts with a slash is sent to the agent", () => {
  const cmd = parseSidebarCommand("/src/cli/main.ts explain this");
  assert.equal(cmd.kind, "prompt");
  if (cmd.kind === "prompt") assert.equal(cmd.text, "/src/cli/main.ts explain this");
});

test("a double-slash line is a prompt, not an empty command", () => {
  assert.equal(parseSidebarCommand("// keep this comment").kind, "prompt");
});

test("interpretSidebarCommand never spends a model call on help or a typo", () => {
  const ctx = { mode: "agent" as const, model: "local" };
  const help = interpretSidebarCommand({ kind: "help" }, ctx);
  assert.equal(help.action.type, "none");
  assert.ok(help.notice.includes("/export"));
  assert.equal(help.ok, true);

  const typo = interpretSidebarCommand({ kind: "unknown", name: "exprot" }, ctx);
  assert.equal(typo.action.type, "none");
  assert.equal(typo.ok, false);
  assert.match(typo.notice, /\/exprot/);
  assert.match(typo.notice, /\/help/);
});

test("interpretSidebarCommand switches a known mode and rejects a fake one", () => {
  const ctx = { mode: "agent" as const, model: "local" };
  const ok = interpretSidebarCommand({ kind: "mode", value: "ask" }, ctx);
  assert.deepEqual(ok.action, { type: "setMode", mode: "ask" });
  assert.equal(ok.ok, true);

  const bad = interpretSidebarCommand({ kind: "mode", value: "sudo" }, ctx);
  assert.equal(bad.action.type, "none");
  assert.equal(bad.ok, false);
  assert.match(bad.notice, /sudo/);
});

test("an empty /mode or /model reports the current value", () => {
  const ctx = { mode: "review" as const, model: "llama" };
  const mode = interpretSidebarCommand({ kind: "mode", value: "" }, ctx);
  assert.equal(mode.action.type, "none");
  assert.equal(mode.notice, "mode: review");

  const model = interpretSidebarCommand({ kind: "model", value: "" }, ctx);
  assert.equal(model.notice, "model: llama");
});

test("every documented mode is accepted", () => {
  const ctx = { mode: "agent" as const, model: "" };
  for (const mode of SIDEBAR_MODES) {
    const result = interpretSidebarCommand({ kind: "mode", value: mode }, ctx);
    assert.equal(result.ok, true, mode);
    assert.deepEqual(result.action, { type: "setMode", mode });
  }
});

test("help text documents every mode", () => {
  for (const mode of SIDEBAR_MODES) {
    assert.ok(SIDEBAR_HELP.includes(mode), `help should mention ${mode}`);
  }
});
