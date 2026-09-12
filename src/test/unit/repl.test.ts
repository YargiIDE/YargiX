/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * The interactive session's input handling.
 *
 * Two things here are load-bearing: an approval reply must never be read as
 * consent unless it plainly says so, and the line reader must deliver every
 * line whether a person is typing or a script is piping input.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type * as readline from "node:readline";

import { parseCommand, parseApproval, describeAction, LineReader, HELP, BANNER } from "../../cli/repl";

// ------------------------------------------------------------ parseCommand

test("plain text is a prompt for the agent", () => {
  assert.deepEqual(parseCommand("fix the login bug"), { kind: "prompt", text: "fix the login bug" });
});

test("blank input is ignored", () => {
  for (const line of ["", "   ", "\t"]) {
    assert.deepEqual(parseCommand(line), { kind: "empty" });
  }
});

test("exit has the aliases people actually type", () => {
  for (const line of ["/exit", "/quit", "/q", "/EXIT", "  /exit  "]) {
    assert.equal(parseCommand(line).kind, "exit", `${line} should exit`);
  }
});

test("help has the aliases people actually type", () => {
  for (const line of ["/help", "/h", "/?"]) {
    assert.equal(parseCommand(line).kind, "help");
  }
});

test("mode and model carry their argument", () => {
  assert.deepEqual(parseCommand("/mode review"), { kind: "mode", value: "review" });
  assert.deepEqual(parseCommand("/model claude-opus-5"), { kind: "model", value: "claude-opus-5" });
});

test("mode and model with no argument are still recognised", () => {
  assert.deepEqual(parseCommand("/model"), { kind: "model", value: "" });
});

test("auto parses on, off, and a bare toggle", () => {
  assert.deepEqual(parseCommand("/auto on"), { kind: "auto", value: true });
  assert.deepEqual(parseCommand("/auto yes"), { kind: "auto", value: true });
  assert.deepEqual(parseCommand("/auto off"), { kind: "auto", value: false });
  assert.deepEqual(parseCommand("/auto no"), { kind: "auto", value: false });
  assert.deepEqual(parseCommand("/auto"), { kind: "auto" });
});

test("an unrecognised slash command is reported, not sent to the model", () => {
  const cmd = parseCommand("/whatever");
  assert.equal(cmd.kind, "unknown");
  // Sending it as a prompt would silently spend a model call on a typo.
  assert.notEqual(cmd.kind, "prompt");
});

test("a path that merely starts with a slash is not a command", () => {
  // Unix-style paths are common in prompts; only the first token decides.
  const cmd = parseCommand("/usr/local/bin matters here");
  assert.equal(cmd.kind, "unknown");
});

// ----------------------------------------------------------- parseApproval

test("only an explicit yes approves", () => {
  assert.equal(parseApproval("y"), "yes");
  assert.equal(parseApproval("Y"), "yes");
  assert.equal(parseApproval("yes"), "yes");
  assert.equal(parseApproval(" YES "), "yes");
});

test("always is distinct from yes", () => {
  assert.equal(parseApproval("a"), "always");
  assert.equal(parseApproval("always"), "always");
});

test("anything else refuses, including an empty line", () => {
  // Pressing Enter must not approve a file write.
  for (const input of ["", " ", "n", "no", "maybe", "sure", "ok", "1", "yep"]) {
    assert.equal(parseApproval(input), "no", `${JSON.stringify(input)} must not approve`);
  }
});

// ---------------------------------------------------------- describeAction

test("the approval line names the command, path or url", () => {
  assert.equal(describeAction("Shell", { command: "rm -rf build" }), "Shell: rm -rf build");
  assert.equal(describeAction("Write", { path: "src/a.ts" }), "Write: src/a.ts");
  assert.equal(describeAction("WebFetch", { url: "https://example.com" }), "WebFetch: https://example.com");
});

test("a tool with nothing to show is named alone", () => {
  assert.equal(describeAction("TodoWrite", {}), "TodoWrite");
  assert.equal(describeAction("TodoWrite", undefined), "TodoWrite");
});

test("a long detail is truncated so the prompt stays one line", () => {
  const line = describeAction("Shell", { command: "x".repeat(200) });
  assert.ok(line.length < 90, `too long: ${line.length}`);
  assert.match(line, /\.\.\.$/);
});

// --------------------------------------------------------------- LineReader

/** Stand-in for a readline interface that emits `line` and `close`. */
function fakeRl() {
  return new EventEmitter() as unknown as readline.Interface & EventEmitter;
}

test("a line typed after the request resolves the waiting read", async () => {
  const rl = fakeRl();
  const reader = new LineReader(rl);
  const pending = reader.next();
  rl.emit("line", "hello");
  assert.equal(await pending, "hello");
});

test("lines delivered before they are requested are not lost", async () => {
  // Piped stdin emits everything at once; each line must still be readable.
  const rl = fakeRl();
  const reader = new LineReader(rl);
  rl.emit("line", "one");
  rl.emit("line", "two");
  rl.emit("line", "three");

  assert.equal(await reader.next(), "one");
  assert.equal(await reader.next(), "two");
  assert.equal(await reader.next(), "three");
});

test("reads resolve in order when several are queued", async () => {
  const rl = fakeRl();
  const reader = new LineReader(rl);
  const a = reader.next();
  const b = reader.next();
  rl.emit("line", "first");
  rl.emit("line", "second");
  assert.equal(await a, "first");
  assert.equal(await b, "second");
});

test("close ends the session with null, not a hang", async () => {
  const rl = fakeRl();
  const reader = new LineReader(rl);
  const pending = reader.next();
  rl.emit("close");
  assert.equal(await pending, null);
  assert.equal(await reader.next(), null, "further reads stay ended");
});

test("buffered lines are still drained after close", async () => {
  const rl = fakeRl();
  const reader = new LineReader(rl);
  rl.emit("line", "last words");
  rl.emit("close");
  assert.equal(await reader.next(), "last words");
  assert.equal(await reader.next(), null);
});

// ---------------------------------------------------------------- surfaces

test("the help text documents every command the parser accepts", () => {
  for (const name of [
    "/help",
    "/exit",
    "/clear",
    "/mode",
    "/model",
    "/auto",
    "/system",
    "/history",
    "/cwd",
    "/tools",
    "/save",
    "/load",
    "/export",
    "/usage",
  ]) {
    assert.ok(HELP.includes(name), `help should mention ${name}`);
  }
  assert.ok(BANNER.includes("/help"));
});

test("save, load and export carry an optional path", () => {
  assert.deepEqual(parseCommand("/save"), { kind: "save", value: "" });
  assert.deepEqual(parseCommand("/save notes/run.json"), { kind: "save", value: "notes/run.json" });
  assert.deepEqual(parseCommand("/load"), { kind: "load", value: "" });
  assert.deepEqual(parseCommand("/load notes/run.json"), { kind: "load", value: "notes/run.json" });
  assert.deepEqual(parseCommand("/export out.md"), { kind: "export", value: "out.md" });
});

test("usage is a command, not a prompt", () => {
  assert.deepEqual(parseCommand("/usage"), { kind: "usage" });
  assert.deepEqual(parseCommand("/tokens"), { kind: "usage" });
  assert.notEqual(parseCommand("/usage").kind, "prompt");
});

test("system shows, sets, and is not sent to the model as a prompt", () => {
  assert.deepEqual(parseCommand("/system"), { kind: "system", value: "" });
  assert.deepEqual(parseCommand("/system be terse"), { kind: "system", value: "be terse" });
  assert.deepEqual(parseCommand("/system clear"), { kind: "system", value: "clear" });
  assert.notEqual(parseCommand("/system be terse").kind, "prompt");
});
