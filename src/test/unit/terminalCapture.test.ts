/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { stripAnsi, formatExecutions, type TerminalExecution } from "../../integrations/terminalCapture";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

function exec(patch: Partial<TerminalExecution> = {}): TerminalExecution {
  return {
    terminal: "bash",
    command: "npm test",
    output: "",
    exitCode: 0,
    startedAt: 0,
    running: false,
    ...patch,
  };
}

// ------------------------------------------------------------------ stripAnsi

test("stripAnsi removes SGR colour codes but keeps the text", () => {
  assert.equal(stripAnsi(`${ESC}[31merror${ESC}[0m: boom`), "error: boom");
});

test("stripAnsi removes cursor-movement and erase sequences", () => {
  assert.equal(stripAnsi(`a${ESC}[2Kb${ESC}[1;5Hc`), "abc");
});

test("stripAnsi removes OSC title sequences terminated by BEL or ST", () => {
  assert.equal(stripAnsi(`${ESC}]0;my title${BEL}done`), "done");
  assert.equal(stripAnsi(`${ESC}]0;my title${ESC}\\done`), "done");
});

test("stripAnsi normalizes CRLF and bare CR to newlines", () => {
  assert.equal(stripAnsi("a\r\nb\rc"), "a\nb\nc");
});

test("stripAnsi drops stray control bytes but preserves tabs and newlines", () => {
  assert.equal(stripAnsi("a\tb\nc"), "a\tb\nc");
  assert.equal(stripAnsi(`a${String.fromCharCode(0)}b`), "ab");
});

test("stripAnsi leaves ordinary text untouched", () => {
  const plain = "npm ERR! code ELIFECYCLE\n  at Object.<anonymous> (/x/y.js:1:1)";
  assert.equal(stripAnsi(plain), plain);
});

// ------------------------------------------------------------- formatExecutions

test("formatExecutions reports the exit code and command", () => {
  const out = formatExecutions([exec({ command: "pnpm build", exitCode: 1, output: "boom" })]);
  assert.match(out, /\$ pnpm build/);
  assert.match(out, /exit_code=1/);
  assert.match(out, /boom/);
});

test("formatExecutions marks a still-running command", () => {
  const out = formatExecutions([exec({ running: true, exitCode: undefined })]);
  assert.match(out, /running/);
});

test("formatExecutions distinguishes an unknown exit code from a zero one", () => {
  const out = formatExecutions([exec({ exitCode: undefined, running: false })]);
  assert.match(out, /exit code unknown/);
  assert.doesNotMatch(out, /exit_code=/);
});

test("formatExecutions includes the working directory when known", () => {
  const out = formatExecutions([exec({ cwd: "/repo/app" })]);
  assert.match(out, /cwd="\/repo\/app"/);
});

test("formatExecutions says so when a command produced no output", () => {
  assert.match(formatExecutions([exec({ output: "   " })]), /\(no output\)/);
});

test("formatExecutions handles an empty list without throwing", () => {
  assert.equal(formatExecutions([]), "(no captured terminal activity)");
});

test("formatExecutions separates multiple commands", () => {
  const out = formatExecutions([exec({ command: "a" }), exec({ command: "b" })]);
  assert.match(out, /\$ a/);
  assert.match(out, /\$ b/);
});
