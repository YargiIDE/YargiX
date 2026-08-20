/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Related-edit mapping.
 *
 * The model is only ever allowed to point at candidate lines we found
 * ourselves, so `mapRelatedEdits` is the boundary that has to reject anything
 * malformed, out of range, or not actually a change — a bad row here would
 * rewrite the wrong line of the user's code.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mapRelatedEdits, type RelatedEditCandidate } from "../../agent/provider";
import { distinctiveTokens } from "../../inline/nextEdit";

const candidates: RelatedEditCandidate[] = [
  { file: "a.ts", line: 10, text: "  const x = oldName();", context: "" },
  { file: "b.ts", line: 20, text: "  return oldName;", context: "" },
];

// ------------------------------------------------------------ mapRelatedEdits

test("maps a valid row onto the candidate's real file and line", () => {
  const out = mapRelatedEdits([{ id: 0, replacement: "  const x = newName();", reason: "rename" }], candidates);
  assert.deepEqual(out, [{ file: "a.ts", line: 10, replacement: "  const x = newName();", reason: "rename" }]);
});

test("accepts a numeric-string id", () => {
  const out = mapRelatedEdits([{ id: "1", replacement: "  return newName;" }], candidates);
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "b.ts");
});

test("drops ids outside the candidate list", () => {
  for (const id of [2, -1, 99]) {
    assert.deepEqual(mapRelatedEdits([{ id, replacement: "x" }], candidates), []);
  }
});

test("drops non-integer and missing ids", () => {
  assert.deepEqual(mapRelatedEdits([{ id: 1.5, replacement: "x" }], candidates), []);
  assert.deepEqual(mapRelatedEdits([{ replacement: "x" }], candidates), []);
  assert.deepEqual(mapRelatedEdits([{ id: "abc", replacement: "x" }], candidates), []);
});

test("drops rows whose replacement is not a string", () => {
  assert.deepEqual(mapRelatedEdits([{ id: 0, replacement: 42 }], candidates), []);
  assert.deepEqual(mapRelatedEdits([{ id: 0 }], candidates), []);
  assert.deepEqual(mapRelatedEdits([{ id: 0, replacement: null }], candidates), []);
});

test("drops a replacement identical to the current line", () => {
  assert.deepEqual(mapRelatedEdits([{ id: 0, replacement: "  const x = oldName();" }], candidates), []);
});

test("keeps only the first suggestion per line", () => {
  const out = mapRelatedEdits(
    [
      { id: 0, replacement: "  const x = first();" },
      { id: 0, replacement: "  const x = second();" },
    ],
    candidates,
  );
  assert.equal(out.length, 1);
  assert.match(out[0].replacement, /first/);
});

test("a multi-line replacement is clamped to a single line", () => {
  // Each suggestion replaces exactly one line; extra lines would shift every
  // line number after it and corrupt the rest of the queue.
  const out = mapRelatedEdits([{ id: 0, replacement: "  const x = newName();\nrm -rf /" }], candidates);
  assert.equal(out[0].replacement, "  const x = newName();");
});

test("a missing reason becomes an empty string, not undefined", () => {
  const out = mapRelatedEdits([{ id: 0, replacement: "  const x = newName();" }], candidates);
  assert.equal(out[0].reason, "");
});

test("garbage rows are ignored without throwing", () => {
  assert.deepEqual(mapRelatedEdits([null, undefined, 5, "str", []], candidates), []);
});

test("an empty candidate list can never produce an edit", () => {
  assert.deepEqual(mapRelatedEdits([{ id: 0, replacement: "x" }], []), []);
});

// ---------------------------------------------------------- distinctiveTokens

test("distinctiveTokens finds the identifier an edit removed", () => {
  const tokens = distinctiveTokens("const value = oldHelper(input);", "const value = newHelper(input);");
  assert.ok(tokens.includes("oldHelper"), `expected oldHelper, got ${JSON.stringify(tokens)}`);
  assert.ok(!tokens.includes("value"), "unchanged identifiers are not distinctive");
});

test("distinctiveTokens ignores very short identifiers", () => {
  const tokens = distinctiveTokens("let ab = 1;", "let cd = 1;");
  assert.deepEqual(tokens, []);
});

test("distinctiveTokens falls back to shared names for a pure addition", () => {
  const tokens = distinctiveTokens("callSomething(alpha);", "callSomething(alpha, beta);");
  assert.ok(tokens.length > 0, "a pure addition should still give something to search for");
});

test("distinctiveTokens returns at most three, longest first", () => {
  const before = "alphaLongest betaMedium gammaOne deltaTwo epsilonThree";
  const tokens = distinctiveTokens(before, "");
  assert.ok(tokens.length <= 3);
  for (let i = 1; i < tokens.length; i++) {
    assert.ok(tokens[i - 1].length >= tokens[i].length, "should be sorted longest first");
  }
});
