/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * The plan review gate.
 *
 * Leaving plan mode is the moment the agent starts changing the workspace, so
 * the user has to sign off first. The property under test is that the agent
 * cannot approve its own plan — every path that is not an explicit approval
 * must leave the run in plan mode.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { TOOLS } from "../../agent/tools";
import { setPlanApprovalRequired, setQuestionAsker } from "../../agent/tools/shared";
import type { ToolContext } from "../../agent/tools";
import type { Mode } from "../../agent/types";

const APPROVE = "Approve — start implementing";
const REVISE = "Not yet — keep planning";

interface Harness {
  ctx: ToolContext;
  switched: Mode[];
  asked: number;
}

/** A tool context in `mode`, whose user answers with `answer` (undefined = throws). */
function harness(mode: Mode, answer?: string): Harness {
  const h: Harness = { switched: [], asked: 0, ctx: {} as ToolContext };
  h.ctx = {
    todos: [],
    getMode: () => mode,
    switchMode: (m: Mode) => {
      h.switched.push(m);
      return `switched to ${m}`;
    },
    askUser: async () => {
      h.asked++;
      if (answer === undefined) throw new Error("dismissed");
      return { q: [answer] };
    },
  } as ToolContext;
  return h;
}

const switchMode = (ctx: ToolContext, target: string) =>
  TOOLS.SwitchMode.execute({ target_mode_id: target }, undefined, "call-1", ctx);

// A stray global asker from another test file must not leak into these.
setQuestionAsker(undefined);

test("approving the plan switches into the executing mode", async (t) => {
  setPlanApprovalRequired(true);
  t.after(() => setPlanApprovalRequired(true));

  const h = harness("plan", APPROVE);
  const res = await switchMode(h.ctx, "agent");

  assert.equal(h.asked, 1, "the user should have been asked");
  assert.deepEqual(h.switched, ["agent"]);
  assert.match(res.output, /switched to agent/);
});

test("declining the plan leaves the run in plan mode", async () => {
  setPlanApprovalRequired(true);
  const h = harness("plan", REVISE);
  const res = await switchMode(h.ctx, "agent");

  assert.equal(h.switched.length, 0, "mode must not change without approval");
  assert.match(res.output, /did not approve/i);
  assert.match(res.output, /still in plan mode/i);
});

test("a dismissed or cancelled prompt counts as 'not approved'", async () => {
  setPlanApprovalRequired(true);
  const h = harness("plan", undefined); // asker throws
  const res = await switchMode(h.ctx, "agent");

  assert.equal(h.switched.length, 0, "an error must never fall through to approval");
  assert.match(res.output, /did not approve/i);
});

test("an unrecognised answer is not treated as approval", async () => {
  setPlanApprovalRequired(true);
  const h = harness("plan", "sure, go ahead");
  const res = await switchMode(h.ctx, "agent");

  assert.equal(h.switched.length, 0);
  assert.match(res.output, /did not approve/i);
});

test("every executing mode is gated, not just agent", async () => {
  setPlanApprovalRequired(true);
  for (const target of ["agent", "multitask", "project", "debug"]) {
    const h = harness("plan", REVISE);
    await switchMode(h.ctx, target);
    assert.equal(h.switched.length, 0, `${target} must be gated`);
    assert.equal(h.asked, 1, `${target} should have prompted`);
  }
});

test("staying inside plan mode is not gated", async () => {
  setPlanApprovalRequired(true);
  const h = harness("plan", REVISE);
  await switchMode(h.ctx, "plan");

  assert.equal(h.asked, 0, "no approval needed when nothing will be executed");
  assert.deepEqual(h.switched, ["plan"]);
});

test("entering plan mode from an executing mode is not gated", async () => {
  setPlanApprovalRequired(true);
  const h = harness("agent", REVISE);
  await switchMode(h.ctx, "plan");

  assert.equal(h.asked, 0);
  assert.deepEqual(h.switched, ["plan"]);
});

test("switching between executing modes is not gated", async () => {
  setPlanApprovalRequired(true);
  const h = harness("agent", REVISE);
  await switchMode(h.ctx, "debug");

  assert.equal(h.asked, 0, "the gate is about leaving plan mode, not mode changes in general");
  assert.deepEqual(h.switched, ["debug"]);
});

test("the gate can be turned off in settings", async (t) => {
  setPlanApprovalRequired(false);
  t.after(() => setPlanApprovalRequired(true));

  const h = harness("plan", REVISE);
  await switchMode(h.ctx, "agent");

  assert.equal(h.asked, 0);
  assert.deepEqual(h.switched, ["agent"]);
});

test("an invalid target mode is rejected before anything else happens", async () => {
  setPlanApprovalRequired(true);
  const h = harness("plan", APPROVE);
  const res = await switchMode(h.ctx, "yolo");

  assert.match(res.output, /^error:/);
  assert.equal(h.asked, 0);
  assert.equal(h.switched.length, 0);
});
