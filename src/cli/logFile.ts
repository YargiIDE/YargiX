/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * A durable NDJSON mirror of the agent event stream.
 *
 * `--json` is a live pipe to stdout; `--output` is the final answer. This file
 * is the third artifact: every event, in order, so a CI job can keep the trace
 * after the process exits. Writes are best-effort after the file is opened —
 * a full disk must not kill a run that already did the work.
 */

import * as fs from "fs/promises";
import * as path from "path";

import type { AgentEvent } from "../agent/types";
import { isIoError, type IoResult } from "./io";

/** Hard cap so a long run of `text-delta` / shell progress cannot fill a disk. */
export const MAX_LOG_BYTES = 50_000_000;

/** Used by `/log on` when the user wants a log but has not picked a path. */
export const DEFAULT_LOG_FILE = ".yargix/events.jsonl";

export type LogEnvelope =
  | { ts: number; event: AgentEvent }
  | { ts: number; truncated: true; bytes: number }
  | { ts: number; error: string; type?: string };

export function resolvedPathsEqual(a: string, b: string, cwd: string): boolean {
  if (!a.trim() || !b.trim()) return false;
  const left = path.resolve(cwd, a);
  const right = path.resolve(cwd, b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Reject paths that would silently dump events onto stdout or into a folder.
 * Existence is checked so a directory is caught before we try to open it.
 */
export async function prepareLogPath(filePath: string, cwd: string): Promise<IoResult<{ path: string }>> {
  if (!filePath.trim()) return { error: "log file path is empty" };
  if (filePath.trim() === "-") {
    return { error: "log file path cannot be '-' (use --json to stream events to stdout)" };
  }
  const resolved = path.resolve(cwd, filePath);
  try {
    const st = await fs.stat(resolved);
    if (st.isDirectory()) return { error: `log file path is a directory: ${filePath}` };
  } catch {
    // Not there yet — we will create it.
  }
  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
  } catch (e) {
    return { error: `could not create log directory for ${filePath}: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { path: resolved };
}

export function formatLogLine(event: AgentEvent, now = Date.now()): string {
  try {
    return `${JSON.stringify({ ts: now, event } satisfies LogEnvelope)}\n`;
  } catch (e) {
    const type = event && typeof event === "object" && "type" in event ? String(event.type) : undefined;
    return `${JSON.stringify({
      ts: now,
      error: e instanceof Error ? e.message : "unserializable event",
      type,
    } satisfies LogEnvelope)}\n`;
  }
}

export function formatTruncationLine(bytes: number, now = Date.now()): string {
  return `${JSON.stringify({ ts: now, truncated: true, bytes } satisfies LogEnvelope)}\n`;
}

export class EventLog {
  readonly path: string;
  readonly maxBytes: number;
  bytes = 0;
  truncated = false;
  writeError: string | undefined;

  private handle: fs.FileHandle | undefined;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(filePath: string, handle: fs.FileHandle, maxBytes: number) {
    this.path = filePath;
    this.handle = handle;
    this.maxBytes = maxBytes;
  }

  static async open(filePath: string, cwd: string, maxBytes = MAX_LOG_BYTES): Promise<IoResult<EventLog>> {
    const prepared = await prepareLogPath(filePath, cwd);
    if (isIoError(prepared)) return prepared;
    try {
      const handle = await fs.open(prepared.path, "w");
      return new EventLog(prepared.path, handle, maxBytes);
    } catch (e) {
      return { error: `could not write log file ${filePath}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /**
   * Queue one event. Safe to call from a synchronous `emit` — the write is
   * serialised so two events cannot interleave bytes on disk.
   */
  write(event: AgentEvent, now = Date.now()): void {
    if (this.closed || this.truncated || this.writeError) return;
    this.queue = this.queue.then(() => this.writeNow(event, now));
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
    const handle = this.handle;
    this.handle = undefined;
    if (!handle) return;
    try {
      await handle.close();
    } catch {
      // Already gone.
    }
  }

  private async writeNow(event: AgentEvent, now: number): Promise<void> {
    // `closed` only rejects *new* writes; queued ones must still land.
    if (this.truncated || this.writeError || !this.handle) return;
    const line = formatLogLine(event, now);
    const n = Buffer.byteLength(line, "utf8");
    if (this.bytes + n > this.maxBytes) {
      await this.markTruncated(now);
      return;
    }
    try {
      await this.handle.write(line);
      this.bytes += n;
    } catch (e) {
      this.writeError = e instanceof Error ? e.message : String(e);
    }
  }

  private async markTruncated(now: number): Promise<void> {
    if (this.truncated || !this.handle) return;
    const marker = formatTruncationLine(this.bytes, now);
    try {
      // One extra line past the cap is acceptable: the cap exists to stop a
      // runaway stream, not to drop the sentence that says we stopped.
      await this.handle.write(marker);
      this.bytes += Buffer.byteLength(marker, "utf8");
    } catch (e) {
      this.writeError = e instanceof Error ? e.message : String(e);
      return;
    }
    this.truncated = true;
  }
}

/** Wrap an emit so every event is mirrored without changing the caller's sync contract. */
export function teeEmit(emit: (ev: AgentEvent) => void, log: EventLog | undefined): (ev: AgentEvent) => void {
  if (!log) return emit;
  return (ev) => {
    log.write(ev);
    emit(ev);
  };
}

export type LogCommand =
  | { action: "show" }
  | { action: "off" }
  | { action: "set"; path: string };

/**
 * `/log` with no argument reports the current file. `off`/`false`/`no`/`-`
 * disable it. `on` uses {@link DEFAULT_LOG_FILE}. Anything else is a path.
 */
export function parseLogArg(value: string): LogCommand {
  const v = value.trim();
  if (!v) return { action: "show" };
  const lower = v.toLowerCase();
  if (lower === "off" || lower === "false" || lower === "no" || v === "-") return { action: "off" };
  if (lower === "on" || lower === "true" || lower === "yes") return { action: "set", path: DEFAULT_LOG_FILE };
  return { action: "set", path: v };
}

/** One-line status for the REPL and for a quiet CI footer. */
export function describeLog(log: EventLog | undefined): string {
  if (!log) return "event log: off";
  if (log.writeError) return `event log stopped: ${log.writeError}`;
  if (log.truncated) return `event log truncated at ${log.bytes} bytes: ${log.path}`;
  return `event log: ${log.path}`;
}
