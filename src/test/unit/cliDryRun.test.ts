/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * `--dry-run` validation and reporting.
 *
 * A dry run must prove the real run would start: same prompt resolution,
 * same working-directory and output checks — then a report instead of a
 * model call. It must never write files, never touch the network, and never
 * echo the API key.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { CliOptions } from "../../cli/args";
import {
  buildDryRunInfo,
  describeDryRun,
  dryRunJson,
  promptSourceKind,
  runDryRun,
  type DryRunInfo,
  type DryRunStreams,
} from "../../cli/dryRun";

function options(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    prompt: "do the thing",
    file: "",
    stdin: false,
    output: "",
    system: "",
    timeout: 0,
    mode: "agent",
    model: "test-model",
    baseUrl: "https://api.test/v1",
    apiKey: "super-secret-value",
    cwd: process.cwd(),
    maxSteps: 50,
    auto: false,
    json: false,
    quiet: false,
    dryRun: true,
    interactive: false,
    help: false,
    version: false,
    ...overrides,
  };
}

function capture(stdin?: NodeJS.ReadableStream): DryRunStreams & { out: () => string; err: () => string } {
  let out = "";
  let err = "";
  const stdout = new Writable({
    write(chunk, _encoding, cb) {
      out += chunk.toString();
      cb();
    },
  });
  const stderr = new Writable({
    write(chunk, _encoding, cb) {
      err += chunk.toString();
      cb();
    },
  });
  return { stdout, stderr, stdin: stdin ?? Readable.from([]), out: () => out, err: () => err };
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "yargix-dryrun-"));
}

function sampleInfo(overrides: Partial<DryRunInfo> = {}): DryRunInfo {
  return {
    mode: "agent",
    model: "test-model",
    endpoint: "https://api.test/v1",
    apiKey: "set",
    anthropic: false,
    promptBytes: 11,
    promptFrom: "argv",
    promptFile: "",
    systemBytes: 0,
    output: "",
    cwd: "/tmp/work",
    timeoutSec: 0,
    maxSteps: 50,
    auto: false,
    ...overrides,
  };
}

// ---------------------------------------------------------- promptSourceKind

test("the prompt source kind mirrors the CLI source flags", () => {
  assert.equal(promptSourceKind(options({ file: "", stdin: false })), "argv");
  assert.equal(promptSourceKind(options({ file: "task.md", stdin: false })), "file");
  assert.equal(promptSourceKind(options({ file: "", stdin: true })), "stdin");
});

// ------------------------------------------------------------- report shape

test("the human report is a fixed ASCII shape", () => {
  assert.equal(
    describeDryRun(sampleInfo()),
    [
      "dry run ok: the run would start (no model call was made)",
      "mode: agent",
      "model: test-model",
      "endpoint: https://api.test/v1",
      "api-key: set",
      "anthropic: off",
      "prompt: 11 bytes from argv",
      "system: 0 bytes",
      "output: (none)",
      "cwd: /tmp/work",
      "timeout: none",
      "max-steps: 50",
      "auto: off",
      "",
    ].join("\n"),
  );
});

test("the human report spells out file and stdin sources", () => {
  assert.match(
    describeDryRun(sampleInfo({ promptBytes: 42, promptFrom: "file", promptFile: "task.md" })),
    /prompt: 42 bytes from --file task\.md/,
  );
  assert.match(
    describeDryRun(sampleInfo({ promptBytes: 7, promptFrom: "stdin" })),
    /prompt: 7 bytes from stdin/,
  );
});

test("the human report spells out resolved values", () => {
  const text = describeDryRun(
    sampleInfo({
      anthropic: true,
      systemBytes: 8,
      output: "/tmp/work/out.md",
      timeoutSec: 90,
      maxSteps: 5,
      auto: true,
    }),
  );
  assert.match(text, /anthropic: on/);
  assert.match(text, /system: 8 bytes/);
  assert.match(text, /output: \/tmp\/work\/out\.md/);
  assert.match(text, /timeout: 90s/);
  assert.match(text, /max-steps: 5/);
  assert.match(text, /auto: on/);
});

test("the JSON report is one object with no key material", () => {
  const parsed = JSON.parse(dryRunJson(sampleInfo())) as Record<string, unknown>;
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.mode, "agent");
  assert.equal(parsed.promptBytes, 11);
  assert.equal(parsed.apiKey, "set");
  assert.ok(!dryRunJson(sampleInfo()).includes("super-secret-value"));
  assert.equal(dryRunJson(sampleInfo()).trim().split("\n").length, 1, "must stay one line for --json");
});

test("byte counts are bytes, not characters", () => {
  const info = buildDryRunInfo(options({ system: "héllo" }), "héllo", { output: "", cwd: "/tmp" });
  assert.equal(info.promptBytes, 6);
  assert.equal(info.systemBytes, 6);
});

test("the API key is only ever set or unset", () => {
  assert.equal(buildDryRunInfo(options({ apiKey: "k" }), "hi", { output: "", cwd: "" }).apiKey, "set");
  assert.equal(buildDryRunInfo(options({ apiKey: "" }), "hi", { output: "", cwd: "" }).apiKey, "unset");
});

// ---------------------------------------------------------------- runDryRun

test("an argv prompt validates and prints the report", async () => {
  const dir = await tempDir();
  const streams = capture();
  const code = await runDryRun(options({ prompt: "do the thing", cwd: dir }), streams);
  assert.equal(code, 0);
  assert.equal(streams.err(), "");
  assert.match(streams.out(), /dry run ok/);
  assert.match(streams.out(), /prompt: 12 bytes from argv/);
  assert.match(streams.out(), new RegExp(`cwd: ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("a --file prompt reports the file and its size", async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, "task.md"), "task content", "utf8");
  const streams = capture();
  const code = await runDryRun(options({ prompt: "", file: "task.md", cwd: dir }), streams);
  assert.equal(code, 0);
  assert.match(streams.out(), /prompt: 12 bytes from --file task\.md/);
});

test("a stdin prompt is drained and reported", async () => {
  const dir = await tempDir();
  const streams = capture(Readable.from(["piped prompt"]));
  const code = await runDryRun(options({ prompt: "", stdin: true, cwd: dir }), streams);
  assert.equal(code, 0);
  assert.match(streams.out(), /prompt: 12 bytes from stdin/);
});

test("no prompt at all is a usage error", async () => {
  const streams = capture();
  const code = await runDryRun(options({ prompt: "", file: "", stdin: false }), streams);
  assert.equal(code, 2);
  assert.match(streams.err(), /a prompt is required/);
  assert.equal(streams.out(), "");
});

test("a missing --file is a usage error", async () => {
  const dir = await tempDir();
  const streams = capture();
  const code = await runDryRun(options({ prompt: "", file: "nope.md", cwd: dir }), streams);
  assert.equal(code, 2);
  assert.match(streams.err(), /not found/);
});

test("a missing working directory is a usage error", async () => {
  const streams = capture();
  const code = await runDryRun(options({ cwd: path.join(await tempDir(), "missing") }), streams);
  assert.equal(code, 2);
  assert.match(streams.err(), /working directory not found/);
});

test("a working directory that is a file is a usage error", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "note.txt");
  await fs.writeFile(file, "x", "utf8");
  const streams = capture();
  const code = await runDryRun(options({ cwd: file }), streams);
  assert.equal(code, 2);
  assert.match(streams.err(), /not a directory/);
});

test("an --output that is a directory is a usage error", async () => {
  const dir = await tempDir();
  const streams = capture();
  const code = await runDryRun(options({ cwd: dir, output: "." }), streams);
  assert.equal(code, 2);
  assert.match(streams.err(), /output path is a directory/);
});

test("a missing --output target validates but nothing is written", async () => {
  const dir = await tempDir();
  const streams = capture();
  const code = await runDryRun(options({ cwd: dir, output: "newdir/out.md" }), streams);
  assert.equal(code, 0);
  assert.match(streams.out(), /output: .*newdir/);
  await assert.rejects(fs.stat(path.join(dir, "newdir")), "a dry run must not create anything");
});

test("--json prints one JSON object", async () => {
  const dir = await tempDir();
  const streams = capture();
  const code = await runDryRun(options({ cwd: dir, json: true }), streams);
  assert.equal(code, 0);
  const lines = streams.out().trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(parsed.ok, true);
  assert.equal(parsed.mode, "agent");
  assert.equal(parsed.apiKey, "set");
});

test("the report never leaks the API key", async () => {
  const dir = await tempDir();
  for (const json of [false, true]) {
    const streams = capture();
    const code = await runDryRun(options({ cwd: dir, json }), streams);
    assert.equal(code, 0);
    assert.ok(!streams.out().includes("super-secret-value"));
    assert.ok(!streams.err().includes("super-secret-value"));
  }
});

test("the report shows the resolved run values", async () => {
  const dir = await tempDir();
  const streams = capture();
  const code = await runDryRun(
    options({ cwd: dir, system: "be brief", timeout: 90, maxSteps: 5, auto: true, anthropic: true }),
    streams,
  );
  assert.equal(code, 0);
  assert.match(streams.out(), /anthropic: on/);
  assert.match(streams.out(), /system: 8 bytes/);
  assert.match(streams.out(), /timeout: 90s/);
  assert.match(streams.out(), /max-steps: 5/);
  assert.match(streams.out(), /auto: on/);
});
