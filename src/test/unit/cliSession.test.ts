/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Session snapshots.
 *
 * /load feeds history back into the agent, so a crafted file must not be able
 * to inject unknown step kinds, skip required fields, or explode the process
 * with tens of thousands of steps.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Step } from "../../agent/types";
import {
  MAX_SESSION_STEPS,
  parseSession,
  serializeSession,
  sessionToMarkdown,
  snapshotSession,
} from "../../cli/session";

const steps: Step[] = [
  { kind: "user", text: "what does main.ts do?" },
  {
    kind: "assistant",
    text: "I will read it.",
    thinking: "plan",
    calls: [{ id: "c1", name: "Read", arguments: '{"path":"src/cli/main.ts"}' }],
  },
  { kind: "tool-result", callId: "c1", name: "Read", output: "export async function main", status: "completed" },
  { kind: "assistant", text: "It is the CLI entry point.", calls: [] },
];

function snap(overrides: Partial<Parameters<typeof snapshotSession>[0]> = {}) {
  return snapshotSession({
    mode: "ask",
    model: "local",
    cwd: "/repo",
    steps,
    now: 1_700_000_000_000,
    ...overrides,
  });
}

function sessionError(raw: string): string {
  const parsed = parseSession(raw);
  if (!("error" in parsed)) assert.fail(`expected an error, got a snapshot with ${parsed.snapshot.steps.length} step(s)`);
  return parsed.error;
}

test("a snapshot round-trips through JSON without sharing the live array", () => {
  const original = snap();
  const live: Step[] = [{ kind: "user", text: "live" }];
  const fromLive = snap({ steps: live });
  live[0] = { kind: "user", text: "mutated" };
  assert.equal(fromLive.steps[0].kind === "user" ? fromLive.steps[0].text : "", "live");

  const parsed = parseSession(serializeSession(original));
  if ("error" in parsed) assert.fail(parsed.error);
  assert.deepEqual(parsed.snapshot, original);
});

test("parseSession rejects invalid JSON and non-objects", () => {
  assert.match(sessionError("not json"), /not valid JSON/);
  assert.match(sessionError("[]"), /must be an object/);
  assert.match(sessionError("null"), /must be an object/);
});

test("parseSession rejects a missing or unknown version", () => {
  const raw = JSON.parse(serializeSession(snap())) as Record<string, unknown>;
  delete raw.version;
  assert.match(sessionError(JSON.stringify(raw)), /unsupported session version/);
  raw.version = 99;
  assert.match(sessionError(JSON.stringify(raw)), /unsupported session version/);
});

test("parseSession rejects a bad mode, missing fields, and a non-array history", () => {
  const raw = JSON.parse(serializeSession(snap())) as Record<string, unknown>;
  raw.mode = "sudo";
  assert.match(sessionError(JSON.stringify(raw)), /invalid mode/);
  raw.mode = "ask";
  raw.model = 1;
  assert.match(sessionError(JSON.stringify(raw)), /missing model/);
  raw.model = "local";
  raw.steps = { kind: "user" };
  assert.match(sessionError(JSON.stringify(raw)), /steps must be an array/);
});

test("parseSession rejects unknown and malformed steps", () => {
  const raw = JSON.parse(serializeSession(snap())) as { steps: unknown[] };
  raw.steps[0] = { kind: "system", text: "nope" };
  assert.match(sessionError(JSON.stringify(raw)), /unknown kind/);

  raw.steps[0] = { kind: "user", text: 12 };
  assert.match(sessionError(JSON.stringify(raw)), /user text must be a string/);

  raw.steps[0] = { kind: "assistant", text: "ok", calls: { id: "x" } };
  assert.match(sessionError(JSON.stringify(raw)), /calls must be an array/);

  raw.steps[0] = { kind: "assistant", text: "ok", calls: [{ id: "x" }] };
  assert.match(sessionError(JSON.stringify(raw)), /malformed tool call/);

  raw.steps[0] = { kind: "tool-result", callId: "c", name: "Read", output: "x", status: "maybe" };
  assert.match(sessionError(JSON.stringify(raw)), /invalid status/);
});

test("parseSession keeps well-formed attachments and drops junk", () => {
  const raw = JSON.parse(serializeSession(snap())) as { steps: Array<Record<string, unknown>> };
  raw.steps[0] = {
    kind: "user",
    text: "see this",
    attachments: [
      { id: "a1", name: "a.ts", mime: "text/plain", data: "hi", kind: "text" },
      { id: 1, name: "bad" },
      "nope",
    ],
  };
  const parsed = parseSession(JSON.stringify(raw));
  if ("error" in parsed) assert.fail(parsed.error);
  const user = parsed.snapshot.steps[0];
  assert.equal(user.kind, "user");
  if (user.kind === "user") {
    assert.equal(user.attachments?.length, 1);
    assert.equal(user.attachments?.[0].name, "a.ts");
  }
});

test("parseSession refuses a history large enough to be a denial of service", () => {
  const raw = JSON.parse(serializeSession(snap())) as { steps: unknown[] };
  raw.steps = Array.from({ length: MAX_SESSION_STEPS + 1 }, () => ({ kind: "user", text: "x" }));
  assert.match(sessionError(JSON.stringify(raw)), /too many steps/);
});

test("markdown export names speakers, lists attachment names, and clips huge tool dumps", () => {
  const huge: Step[] = [
    {
      kind: "user",
      text: "run it",
      attachments: [{ id: "a1", name: "fixture.json", mime: "text/plain", data: "{}", kind: "text" }],
    },
    { kind: "assistant", text: "done", calls: [] },
    { kind: "tool-result", callId: "c", name: "Read", output: "Z".repeat(20_000), status: "completed" },
    { kind: "user", text: "ignored", synthetic: true },
  ];
  const md = sessionToMarkdown(snap({ steps: huge }));
  assert.match(md, /## User/);
  assert.match(md, /run it/);
  assert.match(md, /attached: fixture\.json/);
  assert.ok(!md.includes("{}"), "attachment bodies stay out of the markdown transcript");
  assert.match(md, /## Assistant/);
  assert.match(md, /### Read \(completed\)/);
  assert.match(md, /more bytes/);
  assert.ok(!md.includes("ignored"), "synthetic steps stay out of the transcript");
  assert.ok(md.length < 20_000);
});
