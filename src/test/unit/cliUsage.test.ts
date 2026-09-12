/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * CLI usage ledger and exit codes.
 *
 * A timeout must not look like a generic agent error to CI, and a hostile
 * or truncated JSONL file must not poison later inspection.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { AgentEvent } from "../../agent/types";
import { isIoError } from "../../cli/io";
import {
  DEFAULT_USAGE_LOG,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_STRICT,
  EXIT_TIMEOUT,
  MAX_USAGE_LOG_BYTES,
  USAGE_VERSION,
  appendUsageLine,
  buildUsageRecord,
  createUsageTracker,
  formatUsageSummary,
  parseUsageLog,
  readUsageLog,
  runExitCode,
  runOutcome,
  serializeUsageLine,
  summarizeUsage,
  usageLogPath,
  type UsageRecord,
} from "../../cli/usage";

function record(partial: Partial<UsageRecord> = {}): UsageRecord {
  return {
    version: USAGE_VERSION,
    startedAt: 1_000,
    endedAt: 2_000,
    durationMs: 1_000,
    model: "m",
    mode: "ask",
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    requests: 1,
    outcome: "success",
    ...partial,
  };
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "yargix-usage-"));
}

// ----------------------------------------------------------- exit codes

test("timeout is a distinct exit code, not a generic agent error", () => {
  assert.equal(runExitCode({ timedOut: false, failed: false }), EXIT_OK);
  assert.equal(runExitCode({ timedOut: false, failed: true }), EXIT_ERROR);
  assert.equal(runExitCode({ timedOut: false, failed: false, cancelled: true }), EXIT_ERROR);
  assert.equal(runExitCode({ timedOut: true, failed: true }), EXIT_TIMEOUT);
  assert.equal(runExitCode({ timedOut: true, failed: false }), EXIT_TIMEOUT);
  assert.notEqual(EXIT_TIMEOUT, EXIT_ERROR);
  assert.notEqual(EXIT_TIMEOUT, EXIT_STRICT, "3 is reserved for --strict");
});

test("outcome prefers timeout, then cancel, then error", () => {
  assert.equal(runOutcome({ timedOut: true, failed: true, cancelled: true }), "timeout");
  assert.equal(runOutcome({ timedOut: false, failed: true, cancelled: true }), "cancelled");
  assert.equal(runOutcome({ timedOut: false, failed: true }), "error");
  assert.equal(runOutcome({ timedOut: false, failed: false }), "success");
});

// -------------------------------------------------------------- tracker

test("the tracker sums per-step usage and ignores other events", () => {
  const tracker = createUsageTracker();
  tracker.add({ type: "usage", promptTokens: 100, completionTokens: 20, totalTokens: 120 });
  tracker.add({ type: "text-delta", text: "hi" } as AgentEvent);
  tracker.add({ type: "usage", promptTokens: 40, completionTokens: 10, totalTokens: 50 });
  tracker.add({ type: "error", message: "nope" } as AgentEvent);
  assert.deepEqual(tracker.totals(), {
    promptTokens: 140,
    completionTokens: 30,
    totalTokens: 170,
    requests: 2,
  });
});

test("negative or non-finite token counts do not subtract from the total", () => {
  const tracker = createUsageTracker();
  tracker.add({ type: "usage", promptTokens: -5, completionTokens: Number.NaN, totalTokens: 0 });
  assert.deepEqual(tracker.totals(), { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 1 });
});

test("buildUsageRecord uses the reported duration when the run finished", () => {
  const built = buildUsageRecord({
    startedAt: 1_000,
    endedAt: 9_000,
    durationMs: 250,
    model: "local",
    mode: "agent",
    totals: { promptTokens: 8, completionTokens: 2, totalTokens: 10, requests: 1 },
    result: { timedOut: false, failed: false },
  });
  assert.equal(built.durationMs, 250);
  assert.equal(built.outcome, "success");
  assert.equal(built.model, "local");
});

test("buildUsageRecord falls back to wall clock when there is no run-result", () => {
  const built = buildUsageRecord({
    startedAt: 1_000,
    endedAt: 4_000,
    model: "m",
    mode: "ask",
    totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 },
    result: { timedOut: true, failed: true },
  });
  assert.equal(built.durationMs, 3_000);
  assert.equal(built.outcome, "timeout");
});

// ----------------------------------------------------------------- parse

test("parseUsageLog skips blank and malformed lines", () => {
  const good = record({ promptTokens: 3, completionTokens: 1, totalTokens: 4 });
  const raw = [
    "",
    "not-json",
    serializeUsageLine(good).trim(),
    JSON.stringify({ version: 99, mode: "ask", model: "m" }),
    JSON.stringify({ ...good, mode: "sudo" }),
  ].join("\n");
  const parsed = parseUsageLog(raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].promptTokens, 3);
});

test("summarizeUsage and formatUsageSummary report outcomes and totals", () => {
  const records = [
    record({ outcome: "success", promptTokens: 10, completionTokens: 2, totalTokens: 12, requests: 1 }),
    record({ outcome: "timeout", promptTokens: 5, completionTokens: 0, totalTokens: 5, requests: 1 }),
    record({ outcome: "success", promptTokens: 1, completionTokens: 1, totalTokens: 2, requests: 2 }),
  ];
  const summary = summarizeUsage(records);
  assert.equal(summary.runs, 3);
  assert.equal(summary.promptTokens, 16);
  assert.equal(summary.completionTokens, 3);
  assert.equal(summary.totalTokens, 19);
  assert.equal(summary.requests, 4);
  assert.equal(summary.byOutcome.success, 2);
  assert.equal(summary.byOutcome.timeout, 1);
  const text = formatUsageSummary(records);
  assert.match(text, /3 run\(s\): 16 prompt \+ 3 completion tokens/);
  assert.match(text, /2 success/);
  assert.match(text, /1 timeout/);
});

test("usageLogPath falls back to the default ledger", () => {
  assert.equal(usageLogPath(""), DEFAULT_USAGE_LOG);
  assert.equal(usageLogPath("  "), DEFAULT_USAGE_LOG);
  assert.equal(usageLogPath("ci/usage.jsonl"), "ci/usage.jsonl");
});

// ------------------------------------------------------------------- I/O

test("appendUsageLine creates parent directories and appends JSONL", async () => {
  const dir = await tempDir();
  const first = record({ promptTokens: 11, completionTokens: 1, totalTokens: 12 });
  const second = record({ promptTokens: 4, completionTokens: 2, totalTokens: 6, outcome: "error" });
  const a = await appendUsageLine(".yargix/usage.jsonl", dir, first);
  const b = await appendUsageLine(".yargix/usage.jsonl", dir, second);
  assert.equal(isIoError(a), false);
  assert.equal(isIoError(b), false);
  const loaded = await readUsageLog(".yargix/usage.jsonl", dir);
  assert.equal(isIoError(loaded), false);
  if (isIoError(loaded)) return;
  assert.equal(loaded.records.length, 2);
  assert.equal(loaded.records[0].promptTokens, 11);
  assert.equal(loaded.records[1].outcome, "error");
});

test("appendUsageLine refuses '-' and a directory target", async () => {
  const dir = await tempDir();
  const dash = await appendUsageLine("-", dir, record());
  assert.equal(isIoError(dash), true);
  if (isIoError(dash)) assert.match(dash.error, /cannot be '-' /);
  const folder = await appendUsageLine(".", dir, record());
  assert.equal(isIoError(folder), true);
  if (isIoError(folder)) assert.match(folder.error, /directory/);
});

test("appendUsageLine refuses an oversized existing ledger", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "usage.jsonl");
  await fs.writeFile(file, "x".repeat(MAX_USAGE_LOG_BYTES), "utf8");
  const written = await appendUsageLine("usage.jsonl", dir, record());
  assert.equal(isIoError(written), true);
  if (isIoError(written)) assert.match(written.error, /exceeds/);
});

test("readUsageLog treats a missing file as an empty ledger", async () => {
  const dir = await tempDir();
  const loaded = await readUsageLog("missing.jsonl", dir);
  assert.equal(isIoError(loaded), false);
  if (isIoError(loaded)) return;
  assert.deepEqual(loaded.records, []);
});
