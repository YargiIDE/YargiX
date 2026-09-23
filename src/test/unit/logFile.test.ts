/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * CLI event-log I/O.
 *
 * The file is a CI artifact, so a bad path must fail before a run starts, a
 * full disk must not kill a finished run, and two flags must not share one
 * path and silently overwrite each other.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { AgentEvent } from "../../agent/types";
import { isIoError } from "../../cli/io";
import {
  DEFAULT_LOG_FILE,
  EventLog,
  describeLog,
  formatLogLine,
  formatTruncationLine,
  parseLogArg,
  prepareLogPath,
  resolvedPathsEqual,
  teeEmit,
} from "../../cli/logFile";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "yargix-log-"));
}

const started: AgentEvent = { type: "tool-call-started", callId: "c1", name: "Read", input: { path: "a.ts" } };
const result: AgentEvent = { type: "run-result", text: "done", durationMs: 12 };

// ----------------------------------------------------------- paths

test("resolvedPathsEqual is cwd-aware and rejects empty sides", () => {
  const cwd = path.join(os.tmpdir(), "repo");
  assert.equal(resolvedPathsEqual("out/a.jsonl", "./out/a.jsonl", cwd), true);
  assert.equal(resolvedPathsEqual("out/a.jsonl", "out/b.jsonl", cwd), false);
  assert.equal(resolvedPathsEqual("", "out/a.jsonl", cwd), false);
  assert.equal(resolvedPathsEqual("out/a.jsonl", "", cwd), false);
});

test("prepareLogPath refuses empty, '-', and a directory", async () => {
  const root = await tempDir();
  const empty = await prepareLogPath("  ", root);
  assert.ok(isIoError(empty));
  assert.match(empty.error, /empty/);

  const dash = await prepareLogPath("-", root);
  assert.ok(isIoError(dash));
  assert.match(dash.error, /cannot be '-'/);

  const dir = await prepareLogPath(".", root);
  assert.ok(isIoError(dir));
  assert.match(dir.error, /directory/);
});

test("prepareLogPath creates missing parent directories", async () => {
  const root = await tempDir();
  const prepared = await prepareLogPath(path.join("nested", "run", "events.jsonl"), root);
  if (isIoError(prepared)) assert.fail(prepared.error);
  assert.equal(prepared.path, path.resolve(root, "nested", "run", "events.jsonl"));
  const st = await fs.stat(path.dirname(prepared.path));
  assert.equal(st.isDirectory(), true);
});

// ----------------------------------------------------------- format

test("a log line is one JSON object with ts and event", () => {
  const line = formatLogLine(started, 1_700_000_000_000);
  assert.equal(line.endsWith("\n"), true);
  const parsed = JSON.parse(line) as { ts: number; event: AgentEvent };
  assert.equal(parsed.ts, 1_700_000_000_000);
  assert.deepEqual(parsed.event, started);
});

test("the truncation marker has no event field so readers can skip it", () => {
  const parsed = JSON.parse(formatTruncationLine(42, 9)) as { truncated: boolean; bytes: number; event?: unknown };
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.bytes, 42);
  assert.equal(parsed.event, undefined);
});

// ----------------------------------------------------------- EventLog

test("events are written in order and the file is truncated on open", async () => {
  const root = await tempDir();
  const dest = "events.jsonl";
  const first = await EventLog.open(dest, root);
  if (isIoError(first)) assert.fail(first.error);
  first.write(started, 1);
  first.write(result, 2);
  await first.close();

  const second = await EventLog.open(dest, root);
  if (isIoError(second)) assert.fail(second.error);
  second.write({ type: "run-status", status: "running" }, 3);
  await second.close();

  const text = await fs.readFile(path.join(root, dest), "utf8");
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.length, 1, "reopening must replace the previous run, not append");
  assert.equal((JSON.parse(lines[0]) as { event: AgentEvent }).event.type, "run-status");
});

test("writes after close or a write error are ignored", async () => {
  const root = await tempDir();
  const log = await EventLog.open("events.jsonl", root);
  if (isIoError(log)) assert.fail(log.error);
  log.write(started, 1);
  await log.close();
  log.write(result, 2);
  await log.flush();
  const text = await fs.readFile(log.path, "utf8");
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.length, 1);
  assert.equal((JSON.parse(lines[0]) as { event: AgentEvent }).event.type, "tool-call-started");
});

test("a size cap writes one truncation marker and drops the rest", async () => {
  const root = await tempDir();
  const line = formatLogLine(started, 1);
  const cap = Buffer.byteLength(line, "utf8") + 20;
  const log = await EventLog.open("events.jsonl", root, cap);
  if (isIoError(log)) assert.fail(log.error);
  log.write(started, 1);
  log.write(result, 2);
  log.write({ type: "error", message: "nope" }, 3);
  await log.flush();
  assert.equal(log.truncated, true);
  await log.close();

  const lines = (await fs.readFile(log.path, "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.equal((JSON.parse(lines[0]) as { event: AgentEvent }).event.type, "tool-call-started");
  assert.equal((JSON.parse(lines[1]) as { truncated: boolean }).truncated, true);
});

test("opening a directory is a result, not a throw", async () => {
  const root = await tempDir();
  const opened = await EventLog.open(".", root);
  assert.ok(isIoError(opened));
  assert.match(opened.error, /directory/);
});

// ----------------------------------------------------------- tee / parse

test("teeEmit writes to the log and still calls the original emit", async () => {
  const root = await tempDir();
  const log = await EventLog.open("events.jsonl", root);
  if (isIoError(log)) assert.fail(log.error);
  const seen: AgentEvent[] = [];
  const emit = teeEmit((ev) => seen.push(ev), log);
  emit(started);
  emit(result);
  await log.flush();
  assert.deepEqual(seen, [started, result]);
  const lines = (await fs.readFile(log.path, "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, 2);
  await log.close();
});

test("teeEmit without a log is the original function", () => {
  const emit = (ev: AgentEvent) => ev;
  assert.equal(teeEmit(emit, undefined), emit);
});

test("parseLogArg treats on/off/show distinctly", () => {
  assert.deepEqual(parseLogArg(""), { action: "show" });
  assert.deepEqual(parseLogArg("  "), { action: "show" });
  assert.deepEqual(parseLogArg("off"), { action: "off" });
  assert.deepEqual(parseLogArg("NO"), { action: "off" });
  assert.deepEqual(parseLogArg("-"), { action: "off" });
  assert.deepEqual(parseLogArg("on"), { action: "set", path: DEFAULT_LOG_FILE });
  assert.deepEqual(parseLogArg("yes"), { action: "set", path: DEFAULT_LOG_FILE });
  assert.deepEqual(parseLogArg("run/events.jsonl"), { action: "set", path: "run/events.jsonl" });
});

test("describeLog reports off, the path, and failure modes", async () => {
  assert.equal(describeLog(undefined), "event log: off");
  const root = await tempDir();
  const log = await EventLog.open("events.jsonl", root);
  if (isIoError(log)) assert.fail(log.error);
  assert.equal(describeLog(log), `event log: ${log.path}`);
  log.writeError = "ENOSPC";
  assert.match(describeLog(log), /stopped: ENOSPC/);
  log.writeError = undefined;
  log.truncated = true;
  log.bytes = 99;
  assert.match(describeLog(log), /truncated at 99 bytes/);
  await log.close();
});
