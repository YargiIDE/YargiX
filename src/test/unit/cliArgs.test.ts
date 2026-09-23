/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * CLI argument parsing.
 *
 * The CLI runs unattended, so the parser is what stands between a CI job and a
 * surprise: `--auto` must never be implied, a bad flag must fail loudly instead
 * of being ignored, and a missing endpoint must be caught before a run starts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseArgs, isExecutingMode, MODES, USAGE } from "../../cli/args";

const ENV = { YARGIX_API_KEY: "k", YARGIX_BASE_URL: "https://api.test/v1", YARGIX_MODEL: "m" };
const parse = (argv: string[], env = ENV, tty = false) => parseArgs(argv, env as NodeJS.ProcessEnv, tty);

// ------------------------------------------------------------------ basics

test("a bare prompt parses with sensible defaults", () => {
  const { options, errors } = parse(["do the thing"]);
  assert.deepEqual(errors, []);
  assert.equal(options.prompt, "do the thing");
  assert.equal(options.mode, "agent");
  assert.equal(options.maxSteps, 50);
  assert.equal(options.auto, false, "auto must never be on by default");
  assert.equal(options.json, false);
});

test("unquoted words are joined into one prompt", () => {
  assert.equal(parse(["add", "a", "flag"]).options.prompt, "add a flag");
});

test("environment supplies the connection by default", () => {
  const { options } = parse(["x"]);
  assert.equal(options.apiKey, "k");
  assert.equal(options.baseUrl, "https://api.test/v1");
  assert.equal(options.model, "m");
});

test("flags override the environment", () => {
  const { options } = parse(["x", "--model", "other", "--base-url", "http://local/v1"]);
  assert.equal(options.model, "other");
  assert.equal(options.baseUrl, "http://local/v1");
});

// -------------------------------------------------------------------- flags

test("every documented mode is accepted", () => {
  for (const mode of MODES) {
    const { options, errors } = parse(["x", "--mode", mode]);
    assert.deepEqual(errors, [], `${mode} should parse`);
    assert.equal(options.mode, mode);
  }
});

test("an unknown mode is an error, not a silent default", () => {
  const { errors } = parse(["x", "--mode", "sudo"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown mode/);
});

test("an unknown option is rejected rather than ignored", () => {
  const { errors } = parse(["x", "--yolo"]);
  assert.match(errors.join(" "), /unknown option "--yolo"/);
});

test("a flag missing its value is reported", () => {
  assert.match(parse(["x", "--model"]).errors.join(" "), /--model needs a value/);
  // A following flag must not be swallowed as the value.
  assert.match(parse(["x", "--model", "--json"]).errors.join(" "), /--model needs a value/);
});

test("boolean flags set exactly what they say", () => {
  const { options } = parse(["x", "--auto", "--json", "--quiet", "--anthropic"]);
  assert.equal(options.auto, true);
  assert.equal(options.json, true);
  assert.equal(options.quiet, true);
  assert.equal(options.anthropic, true);
});

test("short aliases match their long forms", () => {
  assert.equal(parse(["x", "-m", "ask"]).options.mode, "ask");
  assert.equal(parse(["x", "-q"]).options.quiet, true);
  assert.equal(parse(["x", "-C", "/tmp/repo"]).options.cwd, "/tmp/repo");
  assert.equal(parse(["-h"]).options.help, true);
  assert.equal(parse(["-V"]).options.version, true);
});

test("max-steps takes a positive integer and ignores nonsense", () => {
  assert.equal(parse(["x", "--max-steps", "200"]).options.maxSteps, 200);
  assert.equal(parse(["x", "--max-steps", "abc"]).options.maxSteps, 50, "fall back rather than run zero steps");
  assert.equal(parse(["x", "--max-steps", "0"]).options.maxSteps, 50);
  assert.equal(parse(["x", "--max-steps", "-5"]).options.maxSteps, 50);
});

// ------------------------------------------------------------- validation

test("help and version short-circuit validation", () => {
  for (const flag of ["--help", "--version"]) {
    const { errors } = parseArgs([flag], {} as NodeJS.ProcessEnv);
    assert.deepEqual(errors, [], `${flag} should not demand a prompt or endpoint`);
  }
});

test("a missing prompt, model and endpoint are all reported at once", () => {
  const { errors } = parseArgs([], {} as NodeJS.ProcessEnv, false);
  assert.equal(errors.length, 3, `expected all three, got ${JSON.stringify(errors)}`);
  assert.match(errors.join(" "), /prompt is required/);
  assert.match(errors.join(" "), /no model/);
  assert.match(errors.join(" "), /no endpoint/);
});

test("a bare invocation on a TTY opens a session", () => {
  const { options, errors } = parse([], ENV, true);
  assert.deepEqual(errors, []);
  assert.equal(options.interactive, true);
});

test("a bare invocation without a TTY demands a prompt", () => {
  const { errors } = parse([], ENV, false);
  assert.match(errors.join(" "), /prompt is required/);
});

test("a prompt with no endpoint still fails", () => {
  const { errors } = parseArgs(["do it"], { YARGIX_MODEL: "m" } as NodeJS.ProcessEnv);
  assert.match(errors.join(" "), /no endpoint/);
});

// ------------------------------------------------------------------- modes

test("executing modes are exactly the ones that can change files", () => {
  for (const mode of ["agent", "debug", "multitask", "project"] as const) {
    assert.equal(isExecutingMode(mode), true, `${mode} can change the workspace`);
  }
  for (const mode of ["ask", "plan", "review"] as const) {
    assert.equal(isExecutingMode(mode), false, `${mode} is read-only`);
  }
});

test("the usage text documents every mode and the --auto requirement", () => {
  for (const mode of MODES) {
    assert.ok(USAGE.includes(mode), `usage should mention ${mode}`);
  }
  assert.match(USAGE, /--auto/);
  assert.match(USAGE, /YARGIX_API_KEY/);
  assert.match(USAGE, /--file/);
  assert.match(USAGE, /--stdin/);
  assert.match(USAGE, /--output/);
  assert.match(USAGE, /--system/);
  assert.match(USAGE, /--timeout/);
  assert.match(USAGE, /--log-file/);
});

test("--file supplies the prompt so argv is optional", () => {
  const { options, errors } = parse(["--file", "task.md"]);
  assert.deepEqual(errors, []);
  assert.equal(options.file, "task.md");
  assert.equal(options.prompt, "");
});

test("--file - is stdin, matching the Unix convention", () => {
  const { options, errors } = parse(["--file", "-"]);
  assert.deepEqual(errors, []);
  assert.equal(options.stdin, true);
  assert.equal(options.file, "");
});

test("a lone dash positional prompt means stdin", () => {
  const { options, errors } = parse(["-"]);
  assert.deepEqual(errors, []);
  assert.equal(options.stdin, true);
  assert.equal(options.prompt, "");
});

test("a prompt and --file together is an error", () => {
  const { errors } = parse(["do it", "--file", "task.md"]);
  assert.match(errors.join(" "), /prompt or --file/);
});

test("--file and --stdin together is an error", () => {
  const { errors } = parse(["--file", "task.md", "--stdin"]);
  assert.match(errors.join(" "), /--file or --stdin/);
});

test("--stdin on a TTY is refused so the process cannot hang", () => {
  const { errors } = parse(["--stdin"], ENV, true);
  assert.match(errors.join(" "), /piped input/);
});

test("--stdin cannot be combined with --interactive", () => {
  const { errors } = parse(["--stdin", "-i"]);
  assert.match(errors.join(" "), /--interactive/);
});

test("--output - is refused because the answer already streams to stdout", () => {
  const { errors } = parse(["x", "--output", "-"]);
  assert.match(errors.join(" "), /output path cannot be/);
});

test("--log-file - is refused because --json already streams events", () => {
  const { errors } = parse(["x", "--log-file", "-"]);
  assert.match(errors.join(" "), /log file path cannot be/);
});

test("--log-file and --output cannot share a path", () => {
  const { errors } = parse(["x", "--log-file", "out/run.jsonl", "--output", "./out/run.jsonl"]);
  assert.match(errors.join(" "), /cannot be the same path/);
});

test("--log-file parses a relative path", () => {
  const { options, errors } = parse(["x", "--log-file", ".yargix/events.jsonl"]);
  assert.deepEqual(errors, []);
  assert.equal(options.logFile, ".yargix/events.jsonl");
});

test("--log-file without a value is reported", () => {
  assert.match(parse(["x", "--log-file"]).errors.join(" "), /--log-file needs a value/);
});

test("new flags parse with their short aliases", () => {
  const { options, errors } = parse([
    "--file",
    "task.md",
    "-o",
    "out.md",
    "--system",
    "be brief",
    "--timeout",
    "90",
  ]);
  assert.deepEqual(errors, []);
  assert.equal(options.file, "task.md");
  assert.equal(options.output, "out.md");
  assert.equal(options.system, "be brief");
  assert.equal(options.timeout, 90);
});

test("timeout ignores nonsense the way max-steps does", () => {
  assert.equal(parse(["x", "--timeout", "abc"]).options.timeout, 0);
  assert.equal(parse(["x", "--timeout", "0"]).options.timeout, 0);
  assert.equal(parse(["x", "--timeout", "-3"]).options.timeout, 0);
});

test("--file and -i together is a session that starts from the file", () => {
  const { options, errors } = parse(["-i", "--file", "task.md"]);
  assert.deepEqual(errors, []);
  assert.equal(options.interactive, true);
  assert.equal(options.file, "task.md");
});
