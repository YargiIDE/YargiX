/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Whole-run retry and fallback-model selection.
 *
 * A 503 from llama.cpp should be retried; a Write that already started must
 * not. These tests lock that gate so a CI job cannot double-apply an edit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ChatHTTPError, isRetryableError } from "../../agent/provider";
import {
  MAX_RETRY,
  createFallbackResolver,
  isRetryableFailure,
  isUnsafeToRetryTool,
  looksLikeProviderOutage,
  parseRetryCount,
  retryDelayMs,
  runWithRetries,
  shouldRetry,
  splitModelIds,
} from "../../cli/retry";

// ---------------------------------------------------------- parse / split

test("retry count is a non-negative integer capped at MAX_RETRY", () => {
  assert.equal(parseRetryCount("3"), 3);
  assert.equal(parseRetryCount("0"), 0);
  assert.equal(parseRetryCount("abc"), 0);
  assert.equal(parseRetryCount("-2"), 0);
  assert.equal(parseRetryCount(undefined), 0);
  assert.equal(parseRetryCount("999"), MAX_RETRY);
});

test("fallback model ids split on commas and drop empties", () => {
  assert.deepEqual(splitModelIds("a, b,c"), ["a", "b", "c"]);
  assert.deepEqual(splitModelIds("  , , "), []);
  assert.deepEqual(splitModelIds(undefined), []);
});

test("retry delay grows then caps at 8s", () => {
  assert.equal(retryDelayMs(1), 1000);
  assert.equal(retryDelayMs(2), 2000);
  assert.equal(retryDelayMs(3), 4000);
  assert.equal(retryDelayMs(4), 8000);
  assert.equal(retryDelayMs(9), 8000);
});

// ---------------------------------------------------- provider outage gate

test("HTTP 429/5xx and network phrases are outages", () => {
  assert.equal(looksLikeProviderOutage("chat 503: overloaded"), true);
  assert.equal(looksLikeProviderOutage("chat 429: rate limit"), true);
  assert.equal(looksLikeProviderOutage("fetch failed"), true);
  assert.equal(looksLikeProviderOutage("ECONNREFUSED"), true);
  assert.equal(looksLikeProviderOutage("socket hang up"), true);
});

test("auth, not-found, and agent messages are not outages", () => {
  assert.equal(looksLikeProviderOutage("chat 401: unauthorized"), false);
  assert.equal(looksLikeProviderOutage("chat 404: no such model"), false);
  assert.equal(looksLikeProviderOutage("user denied Write"), false);
  assert.equal(looksLikeProviderOutage(""), false);
});

test("isRetryableFailure accepts ChatHTTPError the same way streamChat does", () => {
  assert.equal(isRetryableFailure(new ChatHTTPError(503, "chat 503")), true);
  assert.equal(isRetryableFailure(new ChatHTTPError(429, "chat 429")), true);
  assert.equal(isRetryableFailure(new ChatHTTPError(401, "chat 401")), false);
  assert.equal(isRetryableFailure(new DOMException("Aborted", "AbortError")), false);
  assert.equal(isRetryableFailure(new TypeError("Failed to fetch")), true);
  assert.equal(isRetryableFailure("chat 502: bad gateway"), true);
  assert.equal(isRetryableFailure("user denied Shell"), false);
});

test("isRetryableError treats 408/425/429/5xx as transient and abort as fatal", () => {
  assert.equal(isRetryableError(new ChatHTTPError(408, "timeout")), true);
  assert.equal(isRetryableError(new ChatHTTPError(425, "too early")), true);
  assert.equal(isRetryableError(new ChatHTTPError(500, "boom")), true);
  assert.equal(isRetryableError(new ChatHTTPError(400, "bad")), false);
  assert.equal(isRetryableError(new DOMException("Aborted", "AbortError")), false);
});

// -------------------------------------------------------------- shouldRetry

test("retry only when attempts remain and the failure is transient", () => {
  const base = { remaining: 2, aborted: false, timedOut: false, mutated: false, error: "chat 503: down" };
  assert.equal(shouldRetry(base), true);
  assert.equal(shouldRetry({ ...base, remaining: 0 }), false);
  assert.equal(shouldRetry({ ...base, aborted: true }), false);
  assert.equal(shouldRetry({ ...base, timedOut: true }), false);
  assert.equal(shouldRetry({ ...base, mutated: true }), false);
  assert.equal(shouldRetry({ ...base, error: "chat 401: no" }), false);
});

test("starting a mutating or delegated tool is unsafe to retry", () => {
  for (const name of ["Write", "StrReplace", "Delete", "Shell", "Task", "Browser", "mcp__fs__write"]) {
    assert.equal(isUnsafeToRetryTool(name), true, name);
  }
  for (const name of ["Read", "Grep", "Glob", "ListDir", "WebFetch"]) {
    assert.equal(isUnsafeToRetryTool(name), false, name);
  }
});

// -------------------------------------------------------- fallback resolver

test("fallback resolver walks unused ids on the same endpoint", async () => {
  const resolve = createFallbackResolver({
    models: ["backup", "last"],
    apiBaseUrl: "http://local/v1",
    apiKey: "k",
    anthropic: true,
  });
  assert.ok(resolve);
  const first = await resolve({ failedModel: "primary", tried: ["primary"], error: "down" });
  assert.deepEqual(first, {
    apiBaseUrl: "http://local/v1",
    apiKey: "k",
    model: "backup",
    anthropic: true,
  });
  const second = await resolve({ failedModel: "backup", tried: ["primary", "backup"], error: "down" });
  assert.equal(second?.model, "last");
  const done = await resolve({ failedModel: "last", tried: ["primary", "backup", "last"], error: "down" });
  assert.equal(done, undefined);
});

test("no fallback models means no resolver", () => {
  assert.equal(createFallbackResolver({ models: [], apiBaseUrl: "u", apiKey: "k" }), undefined);
});

// ---------------------------------------------------------- runWithRetries

test("a successful first attempt never sleeps", async () => {
  let runs = 0;
  let waits = 0;
  const result = await runWithRetries({
    retries: 3,
    signal: new AbortController().signal,
    run: async () => {
      runs++;
      return { ok: true };
    },
    inspect: (r) => r,
    wait: async () => {
      waits++;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(runs, 1);
  assert.equal(waits, 0);
});

test("a 503 then a success retries exactly once", async () => {
  let runs = 0;
  const notices: number[] = [];
  const result = await runWithRetries({
    retries: 2,
    signal: new AbortController().signal,
    run: async () => {
      runs++;
      return runs === 1 ? { ok: false, error: "chat 503: overloaded" } : { ok: true };
    },
    inspect: (r) => r,
    onRetry: ({ attempt }) => notices.push(attempt),
    wait: async () => undefined,
  });
  assert.equal(result.ok, true);
  assert.equal(runs, 2);
  assert.deepEqual(notices, [1]);
});

test("a Write that already started is not retried", async () => {
  let runs = 0;
  await runWithRetries({
    retries: 3,
    signal: new AbortController().signal,
    run: async () => {
      runs++;
      return { ok: false, mutated: true, error: "chat 503: down" };
    },
    inspect: (r) => r,
    wait: async () => undefined,
  });
  assert.equal(runs, 1);
});

test("abort and timeout never retry even on a 503", async () => {
  for (const inspect of [{ ok: false, aborted: true, error: "chat 503" }, { ok: false, error: "chat 503" }]) {
    let runs = 0;
    await runWithRetries({
      retries: 3,
      signal: new AbortController().signal,
      timedOut: () => !("aborted" in inspect),
      run: async () => {
        runs++;
        return inspect;
      },
      inspect: (r) => r,
      wait: async () => undefined,
    });
    assert.equal(runs, 1, JSON.stringify(inspect));
  }
});

test("retries are exhausted after N extra attempts", async () => {
  let runs = 0;
  await runWithRetries({
    retries: 2,
    signal: new AbortController().signal,
    run: async () => {
      runs++;
      return { ok: false, error: "chat 429: rate limit" };
    },
    inspect: (r) => r,
    wait: async () => undefined,
  });
  assert.equal(runs, 3);
});

test("abort during backoff returns the last failure", async () => {
  const ac = new AbortController();
  let runs = 0;
  const result = await runWithRetries({
    retries: 3,
    signal: ac.signal,
    run: async () => {
      runs++;
      return { ok: false, error: "chat 503: down" };
    },
    inspect: (r) => r,
    wait: async (_ms, signal) => {
      ac.abort();
      signal?.throwIfAborted();
    },
  });
  assert.equal(result.ok, false);
  assert.equal(runs, 1);
});
