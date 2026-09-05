/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * CLI token totals.
 *
 * A missing usage event must stay silent; junk numbers must not become NaN
 * on the summary line a script greps for.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { addUsage, emptyUsage, formatUsage } from "../../cli/usage";

test("no events means no summary line", () => {
  assert.equal(formatUsage(emptyUsage()), undefined);
});

test("usage events are summed the way the editor Usage page sums them", () => {
  const acc = emptyUsage();
  addUsage(acc, { promptTokens: 100, completionTokens: 20, totalTokens: 120 });
  addUsage(acc, { promptTokens: 80, completionTokens: 10, totalTokens: 90 });
  assert.equal(acc.events, 2);
  assert.equal(acc.promptTokens, 180);
  assert.equal(acc.completionTokens, 30);
  assert.equal(acc.totalTokens, 210);
  assert.equal(formatUsage(acc), "- tokens: 180 in / 30 out (210 total)");
});

test("a missing total falls back to prompt plus completion", () => {
  const acc = emptyUsage();
  addUsage(acc, { promptTokens: 5, completionTokens: 2 });
  assert.equal(acc.totalTokens, 7);
});

test("negative, NaN, and fractional counts are ignored or floored", () => {
  const acc = emptyUsage();
  addUsage(acc, { promptTokens: -3, completionTokens: Number.NaN, totalTokens: 4.9 });
  assert.equal(acc.promptTokens, 0);
  assert.equal(acc.completionTokens, 0);
  assert.equal(acc.totalTokens, 4);
  assert.equal(acc.events, 1);
});
