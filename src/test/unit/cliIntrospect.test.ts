/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * CLI introspection: mode/tool lists and the prompt dry-run report.
 *
 * These paths run without credentials and without the network, so they are
 * what a CI job uses to validate a `--mode` name or check that `--file`
 * resolves to the intended prompt. The formatters must stay one item per
 * line (scripts grep them) and ASCII-only (the Windows console mangles more).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MODES } from "../../cli/args";
import {
  MODE_INFO,
  describePromptSource,
  firstLine,
  formatModeNames,
  formatModes,
  formatPromptPreview,
  formatToolNames,
  formatTools,
  modesJson,
  toolsJson,
  type PromptPreview,
} from "../../cli/introspect";
import { toolsForMode } from "../../agent/tools";

const ASCII = /^[\x00-\x7F]*$/;

// ------------------------------------------------------------------- modes

test("every mode has a non-empty description and an edit marker", () => {
  assert.equal(Object.keys(MODE_INFO).length, MODES.length);
  for (const mode of MODES) {
    assert.ok(MODE_INFO[mode].description.length > 10, `${mode} needs a description`);
    assert.equal(typeof MODE_INFO[mode].canEdit, "boolean");
  }
});

test("only agent and debug edit files directly; coordinators delegate", () => {
  assert.equal(MODE_INFO.agent.canEdit, true);
  assert.equal(MODE_INFO.debug.canEdit, true);
  for (const mode of ["ask", "plan", "review", "multitask", "project"] as const) {
    assert.equal(MODE_INFO[mode].canEdit, false, `${mode} must not claim direct edits`);
  }
  assert.match(MODE_INFO.multitask.description, /delegat/);
  assert.match(MODE_INFO.project.description, /delegat/);
});

test("formatModes lists every mode once with its marker", () => {
  const out = formatModes();
  assert.match(out, ASCII, "mode list must stay ASCII for cmd.exe");
  assert.ok(out.endsWith("\n"));
  for (const mode of MODES) {
    assert.ok(out.includes(mode), `missing ${mode}`);
    assert.ok(out.includes(MODE_INFO[mode].description), `missing ${mode} description`);
  }
  assert.ok(out.includes("(edits)"), "editing modes need a marker");
  assert.ok(out.includes("(read-only)"), "read-only modes need a marker");
  assert.equal(out.trimEnd().split("\n").length, MODES.length, "one mode per line");
});

test("formatModeNames is bare names for scripts", () => {
  assert.equal(formatModeNames(), `${MODES.join("\n")}\n`);
});

test("modesJson mirrors the human list in MODES order", () => {
  const json = modesJson();
  assert.equal(json.length, MODES.length);
  assert.deepEqual(
    json.map((m) => m.mode),
    MODES,
  );
  for (const entry of json) {
    assert.equal(entry.description, MODE_INFO[entry.mode].description);
    assert.equal(entry.canEdit, MODE_INFO[entry.mode].canEdit);
  }
  assert.doesNotThrow(() => JSON.stringify(json));
});

// ------------------------------------------------------------------- tools

const SAMPLE = [
  { name: "Read", description: "Reads a file from disk.\nSecond paragraph.", mutating: false },
  { name: "Shell", description: "Runs a command.", mutating: true },
];

test("formatTools names the mode, the count, and every tool", () => {
  const out = formatTools("agent", SAMPLE);
  assert.match(out, ASCII);
  assert.ok(out.endsWith("\n"));
  assert.match(out, /mode "agent" \(2\)/);
  assert.ok(out.includes("Read"));
  assert.ok(out.includes("Shell"));
});

test("mutating tools carry a star that read-only tools lack", () => {
  const out = formatTools("agent", SAMPLE);
  const shell = out.split("\n").find((l) => l.includes("Shell")) ?? "";
  const read = out.split("\n").find((l) => l.includes("Read")) ?? "";
  assert.match(shell, /\*/);
  assert.doesNotMatch(read, /\*/);
  assert.match(out, /\* = can change the workspace/);
});

test("tool descriptions stay on one line and are capped", () => {
  const out = formatTools("agent", [
    { name: "Read", description: "First line.\nSecond line must not leak.", mutating: false },
    { name: "Web", description: `x${"y".repeat(200)}`, mutating: false },
  ]);
  assert.ok(!out.includes("Second line must not leak"), "multiline descriptions break greppability");
  const web = out.split("\n").find((l) => l.includes("Web")) ?? "";
  assert.ok(web.length < 140, `too long: ${web.length}`);
  assert.match(web, /\.\.\.$/);
});

test("an empty tool set reports itself instead of printing a bare header", () => {
  assert.match(formatTools("ask", []), /\(0\)/);
  assert.match(formatTools("ask", []), /\(none\)/);
});

test("formatToolNames is bare names for scripts", () => {
  assert.equal(formatToolNames(SAMPLE), "Read\nShell\n");
  assert.match(formatToolNames([]), /\(none\)/);
});

test("toolsJson keeps full descriptions for machines", () => {
  const json = toolsJson("agent", SAMPLE);
  assert.equal(json.mode, "agent");
  assert.equal(json.count, 2);
  assert.equal(json.tools[0].description, SAMPLE[0].description, "JSON must not truncate");
  assert.equal(json.tools[1].mutating, true);
  assert.doesNotThrow(() => JSON.stringify(json));
});

test("the real registry formats cleanly and stays ASCII", () => {
  for (const mode of MODES) {
    const tools = toolsForMode(mode).map((t) => ({
      name: t.schema.function.name,
      description: t.schema.function.description,
      mutating: t.mutating,
    }));
    assert.ok(tools.length > 0, `${mode} must expose at least one tool`);
    assert.match(formatTools(mode, tools), ASCII, `${mode} list must stay ASCII`);
  }
  const agent = formatTools(
    "agent",
    toolsForMode("agent").map((t) => ({
      name: t.schema.function.name,
      description: t.schema.function.description,
      mutating: t.mutating,
    })),
  );
  const review = formatTools(
    "review",
    toolsForMode("review").map((t) => ({
      name: t.schema.function.name,
      description: t.schema.function.description,
      mutating: t.mutating,
    })),
  );
  assert.ok(agent.includes("Shell"), "agent list needs the shell");
  assert.ok(!review.split("\n").some((l) => l.trimStart().startsWith("Shell ")), "review list must not offer the shell");
});

// ------------------------------------------------------------- firstLine

test("firstLine takes the head line, collapses whitespace, and caps length", () => {
  assert.equal(firstLine("hello"), "hello");
  assert.equal(firstLine("  padded  "), "padded");
  assert.equal(firstLine("one\ntwo"), "one");
  assert.equal(firstLine("a\t\tb"), "a b");
  assert.equal(firstLine("abcdef", 5), "ab...");
  assert.equal(firstLine("abcde", 5), "abcde");
});

test("firstLine skips leading blank lines (some specs start with one)", () => {
  assert.equal(firstLine("\nTool to search for files\nmore"), "Tool to search for files");
  assert.equal(firstLine(""), "");
  assert.equal(firstLine("\n  \n"), "");
});

// ------------------------------------------------------ prompt preview

const PREVIEW: PromptPreview = {
  mode: "ask",
  model: "m",
  cwd: "/repo",
  system: "be brief",
  source: "file task.md",
  prompt: "explain this",
};

test("formatPromptPreview reports the run header and the prompt verbatim", () => {
  const out = formatPromptPreview(PREVIEW);
  assert.match(out, ASCII);
  assert.ok(out.endsWith("\n"));
  for (const fragment of ["mode: ask", "model: m", "cwd: /repo", "system: be brief", "source: file task.md"]) {
    assert.ok(out.includes(fragment), `missing ${fragment}`);
  }
  assert.ok(out.endsWith("--- prompt ---\nexplain this\n"), "prompt must close the report verbatim");
});

test("an unset model and empty system read as placeholders, not blanks", () => {
  const out = formatPromptPreview({ ...PREVIEW, model: "", system: "" });
  assert.ok(out.includes("model: (unset)"));
  assert.ok(out.includes("system: (none)"));
});

test("describePromptSource labels every source kind", () => {
  assert.equal(describePromptSource({ kind: "text", text: "hi" }), "argv");
  assert.equal(describePromptSource({ kind: "file", path: "task.md" }), "file task.md");
  assert.equal(describePromptSource({ kind: "stdin" }), "stdin");
  assert.equal(describePromptSource({ kind: "none" }), "none");
});
