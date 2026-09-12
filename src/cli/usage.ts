/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Local CLI usage ledger.
 *
 * The editor keeps token totals in VS Code globalState. The CLI has no
 * extension host, so each finished run (and each interactive turn) appends
 * one JSON line under `.yargix/usage.jsonl`. That file is for later
 * inspection — CI can point it at an artifact with `--usage-file`, or skip
 * it with `--no-usage`.
 *
 * Exit codes live here too: a wall-clock timeout used to look like a generic
 * agent error (1). Callers that retry on timeout need a distinct code.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { AgentEvent, Mode } from "../agent/types";
import type { IoResult } from "./io";

export const USAGE_VERSION = 1 as const;
export const DEFAULT_USAGE_LOG = ".yargix/usage.jsonl";
/** A runaway job must not be able to fill the disk with usage lines. */
export const MAX_USAGE_LOG_BYTES = 2_000_000;

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
/** Reserved by the least-privilege `--strict` draft. Do not reuse. */
export const EXIT_STRICT = 3;
export const EXIT_TIMEOUT = 4;

export type RunOutcome = "success" | "error" | "timeout" | "cancelled";

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
}

export interface UsageRecord {
  version: typeof USAGE_VERSION;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  model: string;
  mode: Mode;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
  outcome: RunOutcome;
}

export interface RunFinish {
  timedOut: boolean;
  failed: boolean;
  cancelled?: boolean;
}

/** How a finished run should leave the process. Timeout wins over error. */
export function runExitCode(result: RunFinish): number {
  if (result.timedOut) return EXIT_TIMEOUT;
  if (result.failed || result.cancelled) return EXIT_ERROR;
  return EXIT_OK;
}

export function runOutcome(result: RunFinish): RunOutcome {
  if (result.timedOut) return "timeout";
  if (result.cancelled) return "cancelled";
  if (result.failed) return "error";
  return "success";
}

/** Accumulate per-step `usage` events. Other event kinds are ignored. */
export function createUsageTracker(): {
  add(ev: AgentEvent): void;
  totals(): UsageTotals;
} {
  const totals: UsageTotals = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };
  return {
    add(ev: AgentEvent) {
      if (ev.type !== "usage") return;
      const prompt = Number.isFinite(ev.promptTokens) ? Math.max(0, ev.promptTokens) : 0;
      const completion = Number.isFinite(ev.completionTokens) ? Math.max(0, ev.completionTokens) : 0;
      totals.promptTokens += prompt;
      totals.completionTokens += completion;
      totals.totalTokens = totals.promptTokens + totals.completionTokens;
      totals.requests += 1;
    },
    totals() {
      return { ...totals };
    },
  };
}

export function buildUsageRecord(opts: {
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  model: string;
  mode: Mode;
  totals: UsageTotals;
  result: RunFinish;
}): UsageRecord {
  const endedAt = opts.endedAt ?? Date.now();
  const durationMs =
    opts.durationMs !== undefined && Number.isFinite(opts.durationMs) && opts.durationMs >= 0
      ? Math.floor(opts.durationMs)
      : Math.max(0, endedAt - opts.startedAt);
  return {
    version: USAGE_VERSION,
    startedAt: opts.startedAt,
    endedAt,
    durationMs,
    model: opts.model,
    mode: opts.mode,
    promptTokens: opts.totals.promptTokens,
    completionTokens: opts.totals.completionTokens,
    totalTokens: opts.totals.totalTokens,
    requests: opts.totals.requests,
    outcome: runOutcome(opts.result),
  };
}

export function serializeUsageLine(record: UsageRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/** Resolve the ledger path, falling back to `.yargix/usage.jsonl`. */
export function usageLogPath(file: string): string {
  return file.trim() || DEFAULT_USAGE_LOG;
}

/**
 * Parse a JSONL ledger. Bad lines are skipped so a truncated write cannot
 * poison later inspection.
 */
export function parseUsageLog(raw: string): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = parseUsageRecord(data);
    if (parsed) records.push(parsed);
  }
  return records;
}

export function summarizeUsage(records: UsageRecord[]): {
  runs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
  byOutcome: Record<RunOutcome, number>;
} {
  const byOutcome: Record<RunOutcome, number> = { success: 0, error: 0, timeout: 0, cancelled: 0 };
  let promptTokens = 0;
  let completionTokens = 0;
  let requests = 0;
  for (const r of records) {
    promptTokens += r.promptTokens;
    completionTokens += r.completionTokens;
    requests += r.requests;
    byOutcome[r.outcome] += 1;
  }
  return {
    runs: records.length,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    requests,
    byOutcome,
  };
}

export function formatUsageSummary(records: UsageRecord[]): string {
  const s = summarizeUsage(records);
  const parts = (["success", "error", "timeout", "cancelled"] as const)
    .filter((k) => s.byOutcome[k] > 0)
    .map((k) => `${s.byOutcome[k]} ${k}`);
  const outcomes = parts.length ? parts.join(", ") : "none";
  return [
    `${s.runs} run(s): ${s.promptTokens} prompt + ${s.completionTokens} completion tokens`,
    `outcomes: ${outcomes}`,
  ].join("\n");
}

/** Append one record. Refuses `-`, directories, and an oversized existing file. */
export async function appendUsageLine(
  filePath: string,
  cwd: string,
  record: UsageRecord,
): Promise<IoResult<{ path: string }>> {
  if (!filePath.trim()) return { error: "usage path is empty" };
  if (filePath.trim() === "-") {
    return { error: "usage path cannot be '-' (pass --no-usage to skip the ledger)" };
  }
  const resolved = path.resolve(cwd, filePath);
  try {
    let st;
    try {
      st = await fs.stat(resolved);
    } catch {
      st = undefined;
    }
    if (st?.isDirectory()) return { error: `usage path is a directory: ${filePath}` };
    if (st && st.size >= MAX_USAGE_LOG_BYTES) {
      return { error: `usage log exceeds ${MAX_USAGE_LOG_BYTES} bytes: ${filePath}` };
    }
    const line = serializeUsageLine(record);
    if (st && st.size + Buffer.byteLength(line) > MAX_USAGE_LOG_BYTES) {
      return { error: `usage log exceeds ${MAX_USAGE_LOG_BYTES} bytes: ${filePath}` };
    }
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.appendFile(resolved, line, "utf8");
    return { path: resolved };
  } catch (e) {
    return { error: `could not write usage log ${filePath}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function readUsageLog(
  filePath: string,
  cwd: string,
): Promise<IoResult<{ records: UsageRecord[]; path: string }>> {
  if (!filePath.trim()) return { error: "usage path is empty" };
  const resolved = path.resolve(cwd, filePath);
  try {
    const text = await fs.readFile(resolved, "utf8");
    return { records: parseUsageLog(text), path: resolved };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { records: [], path: resolved };
    return { error: `could not read usage log ${filePath}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function parseUsageRecord(raw: unknown): UsageRecord | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (o.version !== USAGE_VERSION) return undefined;
  if (!isMode(o.mode)) return undefined;
  if (typeof o.model !== "string") return undefined;
  if (!isOutcome(o.outcome)) return undefined;
  const startedAt = asFinite(o.startedAt);
  const endedAt = asFinite(o.endedAt);
  const durationMs = asFinite(o.durationMs);
  const promptTokens = asFinite(o.promptTokens);
  const completionTokens = asFinite(o.completionTokens);
  const totalTokens = asFinite(o.totalTokens);
  const requests = asFinite(o.requests);
  if (
    startedAt === undefined ||
    endedAt === undefined ||
    durationMs === undefined ||
    promptTokens === undefined ||
    completionTokens === undefined ||
    totalTokens === undefined ||
    requests === undefined
  ) {
    return undefined;
  }
  return {
    version: USAGE_VERSION,
    startedAt,
    endedAt,
    durationMs,
    model: o.model,
    mode: o.mode,
    promptTokens,
    completionTokens,
    totalTokens,
    requests,
    outcome: o.outcome,
  };
}

function isMode(v: unknown): v is Mode {
  return (
    v === "agent" ||
    v === "ask" ||
    v === "plan" ||
    v === "multitask" ||
    v === "project" ||
    v === "debug" ||
    v === "review"
  );
}

function isOutcome(v: unknown): v is RunOutcome {
  return v === "success" || v === "error" || v === "timeout" || v === "cancelled";
}

function asFinite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
