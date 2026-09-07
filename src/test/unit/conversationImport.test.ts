/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Conversation import.
 *
 * Files opened in the editor are untrusted: a crafted dump must not inject
 * unknown step kinds, reuse an existing conversation id, or explode the host.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Step } from "../../agent/types";
import { MAX_SESSION_STEPS, serializeSession, snapshotSession } from "../../cli/session";
import {
  MAX_IMPORT_CHARS,
  parseImportedConversation,
  turnsFromSteps,
} from "../../stores/conversationImport";

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

function sessionJson(overrides: Partial<Parameters<typeof snapshotSession>[0]> = {}): string {
  return serializeSession(
    snapshotSession({
      mode: "ask",
      model: "local",
      cwd: "/repo",
      steps,
      now: 1_700_000_000_000,
      ...overrides,
    }),
  );
}

function importError(raw: string): string {
  const parsed = parseImportedConversation(raw);
  if (!("error" in parsed)) assert.fail(`expected an error, got ${parsed.imported.source} with ${parsed.imported.steps.length} step(s)`);
  return parsed.error;
}

test("a CLI /save snapshot becomes a chat with reconstructed bubbles", () => {
  const parsed = parseImportedConversation(sessionJson());
  if ("error" in parsed) assert.fail(parsed.error);
  assert.equal(parsed.imported.source, "session");
  assert.equal(parsed.imported.title, "what does main.ts do?");
  assert.equal(parsed.imported.createdAt, 1_700_000_000_000);
  assert.equal(parsed.imported.steps.length, 4);

  const turns = parsed.imported.turns;
  assert.equal(turns.length, 3);
  assert.equal(turns[0].role, "user");
  if (turns[0].role === "user") assert.equal(turns[0].text, "what does main.ts do?");
  assert.equal(turns[1].role, "assistant");
  if (turns[1].role === "assistant") {
    assert.equal(turns[1].blocks[0].kind, "thinking");
    assert.equal(turns[1].blocks[1].kind, "text");
    const tool = turns[1].blocks[2];
    assert.equal(tool.kind, "tool");
    if (tool.kind === "tool") {
      assert.equal(tool.status, "completed");
      assert.equal(tool.result, "export async function main");
      assert.deepEqual(tool.input, { path: "src/cli/main.ts" });
    }
  }
  assert.equal(turns[2].role, "assistant");
});

test("a sidebar JSON export keeps its turns and drops the original id", () => {
  const raw = JSON.stringify({
    id: "c_old_id",
    title: "  exported chat  ",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    personaId: "reviewer",
    usedTokens: 42,
    steps,
    turns: [
      { role: "user", text: "what does main.ts do?" },
      { role: "assistant", blocks: [{ kind: "text", text: "It is the CLI entry point." }] },
    ],
  });
  const parsed = parseImportedConversation(raw);
  if ("error" in parsed) assert.fail(parsed.error);
  assert.equal(parsed.imported.source, "conversation");
  assert.equal(parsed.imported.title, "exported chat");
  assert.equal(parsed.imported.personaId, "reviewer");
  assert.equal(parsed.imported.usedTokens, 42);
  assert.equal(parsed.imported.turns.length, 2);
  assert.equal(parsed.imported.turns[1].role, "assistant");
  if (parsed.imported.turns[1].role === "assistant") {
    assert.equal(parsed.imported.turns[1].blocks[0].kind, "text");
  }
});

test("malformed turns fall back to reconstruction from steps", () => {
  const raw = JSON.stringify({
    title: "fallback",
    steps,
    turns: [{ role: "system", text: "nope" }],
  });
  const parsed = parseImportedConversation(raw);
  if ("error" in parsed) assert.fail(parsed.error);
  assert.equal(parsed.imported.turns.length, 3);
  assert.equal(parsed.imported.turns[0].role, "user");
});

test("synthetic user steps stay in history but not in bubbles", () => {
  const withSynth: Step[] = [
    { kind: "user", text: "real question" },
    { kind: "user", text: "compaction summary", synthetic: true },
    { kind: "assistant", text: "ok", calls: [] },
  ];
  const parsed = parseImportedConversation(JSON.stringify({ steps: withSynth }));
  if ("error" in parsed) assert.fail(parsed.error);
  assert.equal(parsed.imported.steps.length, 3);
  assert.equal(parsed.imported.turns.length, 2);
  assert.equal(parsed.imported.turns[0].role, "user");
  if (parsed.imported.turns[0].role === "user") {
    assert.equal(parsed.imported.turns[0].text, "real question");
  }
});

test("turnsFromSteps applies tool-result status onto the matching card", () => {
  const turns = turnsFromSteps([
    { kind: "user", text: "run" },
    {
      kind: "assistant",
      text: "",
      calls: [{ id: "x", name: "Shell", arguments: "not-json" }],
    },
    { kind: "tool-result", callId: "x", name: "Shell", output: "boom", status: "error" },
  ]);
  assert.equal(turns[1].role, "assistant");
  if (turns[1].role === "assistant") {
    const tool = turns[1].blocks.find((b) => b.kind === "tool");
    assert.ok(tool && tool.kind === "tool");
    if (tool && tool.kind === "tool") {
      assert.equal(tool.status, "error");
      assert.equal(tool.result, "boom");
      assert.equal(tool.input, "not-json");
    }
  }
});

test("user attachments on a CLI snapshot survive import", () => {
  const withAtt: Step[] = [
    {
      kind: "user",
      text: "see this",
      attachments: [{ id: "a1", name: "a.ts", mime: "text/plain", data: "hi", kind: "text" }],
    },
    { kind: "assistant", text: "ok", calls: [] },
  ];
  const parsed = parseImportedConversation(sessionJson({ steps: withAtt }));
  if ("error" in parsed) assert.fail(parsed.error);
  const user = parsed.imported.turns[0];
  assert.equal(user.role, "user");
  if (user.role === "user") {
    assert.equal(user.attachments?.length, 1);
    assert.equal(user.attachments?.[0].name, "a.ts");
  }
});

test("parseImportedConversation rejects empty, invalid, and hostile input", () => {
  assert.match(importError(""), /empty/);
  assert.match(importError("   "), /empty/);
  assert.match(importError("not json"), /not valid JSON/);
  assert.match(importError("[]"), /must be a JSON object/);
  assert.match(importError("null"), /must be a JSON object/);
  assert.match(importError(JSON.stringify({ title: "no steps" })), /steps must be an array/);
  assert.match(importError(JSON.stringify({ steps: [] })), /no messages to import/);
  assert.match(importError(sessionJson({ steps: [] })), /no conversation to import/);

  const unknown = JSON.parse(sessionJson()) as { steps: unknown[] };
  unknown.steps[0] = { kind: "system", text: "nope" };
  assert.match(importError(JSON.stringify(unknown)), /unknown kind/);

  const tooMany = JSON.stringify({
    steps: Array.from({ length: MAX_SESSION_STEPS + 1 }, () => ({ kind: "user", text: "x" })),
  });
  assert.match(importError(tooMany), /too many steps/);
});

test("a file over the size cap is refused before JSON.parse", () => {
  const huge = `{${"x".repeat(MAX_IMPORT_CHARS)}}`;
  assert.match(importError(huge), /too large/);
});

test("BOM-prefixed editor export still parses", () => {
  const raw = `\uFEFF${JSON.stringify({ steps, title: "bom" })}`;
  const parsed = parseImportedConversation(raw);
  if ("error" in parsed) assert.fail(parsed.error);
  assert.equal(parsed.imported.title, "bom");
});
