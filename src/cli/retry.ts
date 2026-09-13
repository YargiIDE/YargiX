/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Unattended-run resilience.
 *
 * A CI job should survive a 429 or a llama.cpp that was not listening yet, but
 * it must never replay a run that already wrote files or launched a shell.
 * These helpers decide that, independently of the agent loop.
 */

import { ChatHTTPError, isRetryableError, sleep } from "../agent/provider";

/** Extra whole-run attempts. 0 = current behaviour (one try). */
export const DEFAULT_RETRY = 0;
/** Hard cap so `--retry 999` cannot loop a pipeline for hours. */
export const MAX_RETRY = 10;

/**
 * Tools that change the workspace, the shell, or another agent. Starting any
 * of these makes a second attempt unsafe — the first one may already have
 * done work we cannot roll back from here.
 */
export const UNSAFE_TO_RETRY_TOOLS = new Set([
  "StrReplace",
  "Write",
  "Delete",
  "Shell",
  "AwaitShell",
  "EditNotebook",
  "Browser",
  "CallMcpTool",
  "Memory",
  "Task",
  "TodoWrite",
  "WritePlan",
  "SwitchMode",
]);

export function isUnsafeToRetryTool(name: string): boolean {
  return UNSAFE_TO_RETRY_TOOLS.has(name) || name.startsWith("mcp__");
}

export function parseRetryCount(value: string | undefined, fallback = DEFAULT_RETRY): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(MAX_RETRY, Math.floor(n));
}

export function splitModelIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/** Delay before the next whole-run attempt. `failure` is 1-based. */
export function retryDelayMs(failure: number): number {
  const n = Math.max(1, failure);
  return Math.min(1000 * 2 ** (n - 1), 8000);
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error == null) return "";
  return String(error);
}

/**
 * Provider outage / overload / network. Auth, bad requests, and agent-loop
 * messages ("user denied Write") stay fatal.
 */
export function looksLikeProviderOutage(message: string): boolean {
  const m = message.trim();
  if (!m) return false;
  if (/^chat\s+(408|425|429|5\d\d)\b/i.test(m)) return true;
  if (/\b(408|425|429|5\d\d)\b/.test(m) && /chat|http|status|overloaded|unavailable|gateway|timeout/i.test(m)) {
    return true;
  }
  return /econnreset|econnrefused|etimedout|enotfound|eai_again|epipe|socket hang up|failed to fetch|fetch failed|network error|overloaded|rate.?limit|temporar(?:il)?y unavailable|try again later|service unavailable|bad gateway|gateway timeout|too many requests/i.test(
    m,
  );
}

export function isRetryableFailure(error: unknown): boolean {
  if (error == null) return false;
  if (typeof error === "object") {
    if (error instanceof DOMException && error.name === "AbortError") return false;
    if (error instanceof ChatHTTPError) return isRetryableError(error);
    if (error instanceof Error) {
      if (error.name === "AbortError") return false;
      if (looksLikeProviderOutage(error.message)) return true;
      if (error.name === "TypeError" && /fetch|network/i.test(error.message)) return true;
      return false;
    }
  }
  if (typeof error === "string") return looksLikeProviderOutage(error);
  return false;
}

export interface RetryGate {
  remaining: number;
  aborted: boolean;
  timedOut: boolean;
  mutated: boolean;
  error: unknown;
}

export function shouldRetry(gate: RetryGate): boolean {
  if (gate.remaining <= 0) return false;
  if (gate.aborted || gate.timedOut || gate.mutated) return false;
  return isRetryableFailure(gate.error);
}

export interface FallbackTarget {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  anthropic?: boolean;
}

/**
 * Walk `--fallback-model` ids in order, skipping anything already tried
 * (including the primary `--model`). Same endpoint and credentials.
 */
export function createFallbackResolver(opts: {
  models: string[];
  apiBaseUrl: string;
  apiKey: string;
  anthropic?: boolean;
}): ((info: { failedModel: string; tried: string[]; error: string }) => Promise<FallbackTarget | undefined>) | undefined {
  const models = opts.models.filter(Boolean);
  if (!models.length) return undefined;
  return async ({ tried }) => {
    const next = models.find((id) => !tried.includes(id));
    if (!next) return undefined;
    return {
      apiBaseUrl: opts.apiBaseUrl,
      apiKey: opts.apiKey,
      model: next,
      anthropic: opts.anthropic,
    };
  };
}

export interface AttemptInspect {
  ok: boolean;
  mutated?: boolean;
  aborted?: boolean;
  error?: unknown;
}

/**
 * Re-invoke `run` after a transient provider failure. Stops immediately on
 * abort, timeout, workspace mutation, or a non-retryable error.
 */
export async function runWithRetries<T>(opts: {
  retries: number;
  signal: AbortSignal;
  timedOut?: () => boolean;
  run: () => Promise<T>;
  inspect: (result: T) => AttemptInspect;
  onRetry?: (info: { attempt: number; max: number; delayMs: number; error: string }) => void;
  /** Test seam. Defaults to the shared abortable sleep. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(opts.retries) + 1);
  let last: T | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await opts.run();
    const info = opts.inspect(last);
    if (info.ok) return last;
    const remaining = maxAttempts - attempt;
    if (
      !shouldRetry({
        remaining,
        aborted: Boolean(info.aborted) || opts.signal.aborted,
        timedOut: Boolean(opts.timedOut?.()),
        mutated: Boolean(info.mutated),
        error: info.error,
      })
    ) {
      return last;
    }
    const delay = retryDelayMs(attempt);
    opts.onRetry?.({
      attempt,
      max: maxAttempts,
      delayMs: delay,
      error: errorText(info.error),
    });
    try {
      await (opts.wait ?? sleep)(delay, opts.signal);
    } catch {
      return last;
    }
  }
  return last as T;
}
