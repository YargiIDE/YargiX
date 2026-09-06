/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Step } from "../../agent/types";
import {
  TOOL_OUTPUT_CLIP,
  conversationToMarkdown,
  parseExportFormat,
  resolveTranscriptFormat,
  stepsToMarkdown,
} from "../../shared/transcript";

const steps: Step[] = [
  { kind: "user", text: "what does main.ts do?" },
  {
    kind: "assistant",
    text: "I will read it.",
    calls: [{ id: "c1", name: "Read", arguments: '{"path":"src/cli/main.ts"}' }],
  },
  { kind: "tool-result", callId: "c1", name: "Read", output: "export async function main", status: "completed" },
  { kind: "assistant", text: "It is the CLI entry point.", calls: [] },
];

test("stepsToMarkdown names speakers and keeps tool arguments", () => {
  const md = stepsToMarkdown(steps);
  assert.match(md, /## User/);
  assert.match(md, /what does main.ts do\?/);
  assert.match(md, /## Assistant/);
  assert.match(md, /### Read/);
  assert.match(md, /src\/cli\/main.ts/);
  assert.match(md, /### Read \(completed\)/);
  assert.match(md, /CLI entry point/);
});

test("stepsToMarkdown skips synthetic user steps and clips huge tool dumps", () => {
  const huge: Step[] = [
    { kind: "user", text: "run it" },
    { kind: "assistant", text: "done", calls: [] },
    { kind: "tool-result", callId: "c", name: "Read", output: "Z".repeat(20_000), status: "completed" },
    { kind: "user", text: "ignored", synthetic: true },
  ];
  const md = stepsToMarkdown(huge);
  assert.match(md, /run it/);
  assert.match(md, /more bytes/);
  assert.ok(!md.includes("ignored"), "synthetic steps stay out of the transcript");
  assert.ok(md.length < 20_000);
  assert.ok(md.includes("Z".repeat(TOOL_OUTPUT_CLIP)));
});

test("stepsToMarkdown lists attachment names, never the blob", () => {
  const md = stepsToMarkdown([
    {
      kind: "user",
      text: "see this",
      attachments: [{ id: "a1", name: "shot.png", mime: "image/png", data: "data:image/png;base64,AAAA", kind: "image" }],
    },
  ]);
  assert.match(md, /shot\.png/);
  assert.ok(!md.includes("base64"), "attachment payloads must not land in markdown");
});

test("conversationToMarkdown writes a titled header", () => {
  const md = conversationToMarkdown(
    {
      title: "Auth token refresh",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_100_000,
      personaId: "reviewer",
      steps,
    },
    1_700_000_200_000,
  );
  assert.match(md, /^# Auth token refresh/m);
  assert.match(md, /2023-11-14T22:13:20.000Z/);
  assert.match(md, /persona: reviewer/);
  assert.match(md, /what does main.ts do\?/);
});

test("conversationToMarkdown falls back when the title is blank", () => {
  const md = conversationToMarkdown({
    title: "   ",
    createdAt: 1,
    updatedAt: 2,
    steps: [],
  });
  assert.match(md, /^# YargiX conversation/m);
});

test("resolveTranscriptFormat trusts the file extension over the request", () => {
  assert.equal(resolveTranscriptFormat("chat.json", "markdown"), "json");
  assert.equal(resolveTranscriptFormat("chat.md", "json"), "markdown");
  assert.equal(resolveTranscriptFormat("chat.markdown"), "markdown");
  assert.equal(resolveTranscriptFormat("chat.txt", "json"), "json");
  assert.equal(resolveTranscriptFormat("chat.txt"), "markdown");
});

test("parseExportFormat accepts aliases and file-like values", () => {
  assert.equal(parseExportFormat("json"), "json");
  assert.equal(parseExportFormat("MD"), "markdown");
  assert.equal(parseExportFormat("notes.md"), "markdown");
  assert.equal(parseExportFormat("out.json"), "json");
  assert.equal(parseExportFormat("nope"), undefined);
  assert.equal(parseExportFormat(""), undefined);
});
