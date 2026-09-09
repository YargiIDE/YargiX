/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Smoke test for the tool registry.
 *
 * `defineTool` throws at *import* time when a handler has no matching entry in
 * `schemas.ts`, which a type-check cannot catch. Importing the registry here
 * turns that class of wiring mistake into a failing test instead of a broken
 * extension at runtime.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { TOOLS, MUTATING_TOOLS, toolsForMode, schemasForMode } from "../../agent/tools";

test("every registered tool has a name, description, and parameters", () => {
  const names = Object.keys(TOOLS);
  assert.ok(names.length > 20, `expected a full tool set, got ${names.length}`);
  for (const name of names) {
    const fn = TOOLS[name].schema.function;
    assert.equal(typeof fn.name, "string", `${name}: missing schema name`);
    assert.ok(fn.name.length, `${name}: empty schema name`);
    assert.ok(fn.description && fn.description.length > 10, `${name}: missing description`);
    assert.equal(typeof fn.parameters, "object", `${name}: missing parameters`);
  }
});

test("the ReadTerminal tool is registered and read-only", () => {
  assert.ok(TOOLS.ReadTerminal, "ReadTerminal is not in the tool registry");
  assert.equal(TOOLS.ReadTerminal.mutating, false);
  assert.equal(MUTATING_TOOLS.has("ReadTerminal"), false);
});

test("read-only modes expose ReadTerminal but no mutating tools", () => {
  for (const mode of ["ask", "plan", "review"] as const) {
    const names = toolsForMode(mode).map((t) => t.schema.function.name);
    assert.ok(names.includes("ReadTerminal"), `${mode} should expose ReadTerminal`);
    for (const m of MUTATING_TOOLS) {
      assert.ok(!names.includes(m), `${mode} must not expose the mutating tool ${m}`);
    }
  }
});

test("agent mode exposes the mutating tools", () => {
  const names = toolsForMode("agent").map((t) => t.schema.function.name);
  for (const m of MUTATING_TOOLS) {
    assert.ok(names.includes(m), `agent mode should expose ${m}`);
  }
});

test("the Browser tool is registered and kept out of read-only modes", () => {
  assert.ok(TOOLS.Browser, "Browser is not in the tool registry");
  // Launching a browser process is not a read-only act.
  assert.equal(TOOLS.Browser.mutating, true);
  for (const mode of ["ask", "plan", "review"] as const) {
    const names = toolsForMode(mode).map((t) => t.schema.function.name);
    assert.ok(!names.includes("Browser"), `${mode} must not expose Browser`);
  }
  assert.ok(toolsForMode("agent").some((t) => t.schema.function.name === "Browser"));
});

test("ListDir documents include_ignored so ignored names can be revealed", () => {
  const params = TOOLS.ListDir.schema.function.parameters as { properties?: Record<string, unknown> };
  assert.ok(params.properties?.include_ignored, "ListDir needs an include_ignored flag");
});

test("review mode can read and search but never write or run commands", () => {
  const names = toolsForMode("review").map((t) => t.schema.function.name);
  // A reviewer needs to read code, search it, and see the user's terminal.
  for (const needed of ["Read", "Grep", "Glob", "SemanticSearch", "ReadLints", "ReadTerminal"]) {
    assert.ok(names.includes(needed), `review mode needs ${needed}`);
  }
  for (const blocked of ["StrReplace", "Write", "Delete", "EditNotebook", "Shell"]) {
    assert.ok(!names.includes(blocked), `review mode must not expose ${blocked}`);
  }
  assert.ok(!names.includes("WritePlan"), "WritePlan belongs to plan mode only");
});

test("WritePlan is exclusive to plan mode", () => {
  const has = (mode: Parameters<typeof toolsForMode>[0]) =>
    toolsForMode(mode).some((t) => t.schema.function.name === "WritePlan");
  assert.equal(has("plan"), true);
  assert.equal(has("agent"), false);
  assert.equal(has("ask"), false);
});

test("coordinator modes cannot edit files or run the shell themselves", () => {
  for (const mode of ["multitask", "project"] as const) {
    const names = toolsForMode(mode).map((t) => t.schema.function.name);
    for (const blocked of ["StrReplace", "Write", "Delete", "EditNotebook", "Shell"]) {
      assert.ok(!names.includes(blocked), `${mode} must not expose ${blocked}`);
    }
    assert.ok(names.includes("Task"), `${mode} needs Task to delegate`);
  }
});

test("schemasForMode returns one schema per tool with unique names", () => {
  const schemas = schemasForMode("agent");
  const names = schemas.map((s) => s.function.name);
  assert.equal(names.length, new Set(names).size, "duplicate tool names in the schema list");
  assert.equal(schemas.length, toolsForMode("agent").length);
});
