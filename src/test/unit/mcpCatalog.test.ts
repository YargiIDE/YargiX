/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * The MCP catalog.
 *
 * Adding an entry launches its command on the user's machine, so the catalog
 * itself is the contract: every entry must be well-formed, and the config it
 * produces must be launchable without further editing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MCP_CATALOG,
  configFromCatalog,
  isAlreadyAdded,
  type McpCatalogEntry,
} from "../../shared/mcpCatalog";

const entry = (id: string): McpCatalogEntry => {
  const e = MCP_CATALOG.find((x) => x.id === id);
  assert.ok(e, `catalog should contain "${id}"`);
  return e;
};

// ------------------------------------------------------------ catalog shape

test("every entry has the fields the UI and launcher need", () => {
  assert.ok(MCP_CATALOG.length > 0);
  for (const e of MCP_CATALOG) {
    assert.ok(e.id.trim(), "id must be set");
    assert.ok(e.name.trim(), `${e.id}: name must be set`);
    assert.ok(e.description.length > 20, `${e.id}: description should be useful`);
    assert.ok(e.command.trim(), `${e.id}: command must be set`);
    assert.ok(Array.isArray(e.args), `${e.id}: args must be an array`);
    assert.match(e.docs, /^https:\/\//, `${e.id}: docs must be an https URL`);
  }
});

test("ids and names are unique", () => {
  const ids = MCP_CATALOG.map((e) => e.id);
  const names = MCP_CATALOG.map((e) => e.name.toLowerCase());
  assert.equal(ids.length, new Set(ids).size, "duplicate id in the catalog");
  assert.equal(names.length, new Set(names).size, "duplicate name in the catalog");
});

test("entries only launch through a known runner", () => {
  // A catalog entry is a command that will run locally; keep it to the two
  // runners we document rather than arbitrary executables.
  for (const e of MCP_CATALOG) {
    assert.ok(["npx", "uvx"].includes(e.command), `${e.id}: unexpected command "${e.command}"`);
  }
});

test("npx entries pass -y so adding one never hangs on a prompt", () => {
  for (const e of MCP_CATALOG.filter((x) => x.command === "npx")) {
    assert.ok(e.args.includes("-y"), `${e.id}: npx entries need -y`);
  }
});

test("entries needing a non-npm runtime say so", () => {
  assert.ok(entry("git").requires, "the git server needs uv and must warn about it");
});

// ------------------------------------------------------------ config output

test("a plain entry becomes an enabled stdio config", () => {
  const cfg = configFromCatalog(entry("fetch"), "/repo");
  assert.equal(cfg.transport, "stdio");
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.command, "npx");
  assert.deepEqual(cfg.args, ["-y", "@modelcontextprotocol/server-fetch"]);
  assert.equal(cfg.env, undefined, "no env means no empty env object");
});

test("directory-scoped servers get the workspace path appended", () => {
  const cfg = configFromCatalog(entry("filesystem"), "/repo/app");
  assert.equal(cfg.args[cfg.args.length - 1], "/repo/app");
});

test("the git server keeps --repository immediately before the path", () => {
  const cfg = configFromCatalog(entry("git"), "/repo/app");
  assert.deepEqual(cfg.args.slice(-2), ["--repository", "/repo/app"]);
});

test("an empty workspace path is not appended as a blank argument", () => {
  const cfg = configFromCatalog(entry("filesystem"), "");
  assert.ok(!cfg.args.includes(""), "a blank arg would break the server");
});

test("building a config does not mutate the catalog entry", () => {
  const e = entry("filesystem");
  const before = [...e.args];
  configFromCatalog(e, "/repo");
  configFromCatalog(e, "/other");
  assert.deepEqual(e.args, before, "catalog args must not accumulate paths");
});

// ------------------------------------------------------------- duplicate check

test("an entry already present is detected regardless of case or padding", () => {
  const e = entry("fetch");
  assert.equal(isAlreadyAdded(e, [{ name: "Fetch" }]), true);
  assert.equal(isAlreadyAdded(e, [{ name: "  fetch  " }]), true);
  assert.equal(isAlreadyAdded(e, [{ name: "FETCH" }]), true);
});

test("a different server does not count as already added", () => {
  assert.equal(isAlreadyAdded(entry("fetch"), [{ name: "Filesystem" }]), false);
  assert.equal(isAlreadyAdded(entry("fetch"), []), false);
});
