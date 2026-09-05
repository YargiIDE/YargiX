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

import { parseArgs, isExecutingMode, MODES, USAGE, DEFAULT_RESUME } from "../../cli/args";

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
  assert.match(USAGE, /--resume/);
  assert.match(USAGE, /doctor/);
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

test("a lone doctor command does not need a model or endpoint", () => {
  const { options, errors } = parseArgs(["doctor"], {} as NodeJS.ProcessEnv, false);
  assert.deepEqual(errors, []);
  assert.equal(options.doctor, true);
  assert.equal(options.prompt, "");
});

test("--doctor matches the doctor command", () => {
  const { options, errors } = parseArgs(["--doctor"], {} as NodeJS.ProcessEnv, false);
  assert.deepEqual(errors, []);
  assert.equal(options.doctor, true);
});

test("doctor plus extra words is a prompt, not the health check", () => {
  const { options, errors } = parse(["doctor", "the", "patient"]);
  assert.equal(options.doctor, false);
  assert.equal(options.prompt, "doctor the patient");
  assert.deepEqual(errors, []);
});

test("doctor cannot be combined with a prompt or --resume", () => {
  assert.match(parse(["--doctor", "fix it"]).errors.join(" "), /cannot be combined/);
  assert.match(parse(["--doctor", "--resume"]).errors.join(" "), /cannot be combined/);
});

test("doctor still rejects unknown options", () => {
  const { errors } = parseArgs(["doctor", "--yolo"], {} as NodeJS.ProcessEnv);
  assert.match(errors.join(" "), /unknown option "--yolo"/);
});

test("a bare --resume uses the default session path", () => {
  const { options, errors } = parse(["keep going", "--resume"]);
  assert.deepEqual(errors, []);
  assert.equal(options.resume, DEFAULT_RESUME);
  assert.equal(options.prompt, "keep going");
});

test("--resume takes an explicit path and does not swallow the next flag", () => {
  const { options, errors } = parse(["--resume", "notes/run.json", "--json", "continue"]);
  assert.deepEqual(errors, []);
  assert.equal(options.resume, "notes/run.json");
  assert.equal(options.json, true);
  assert.equal(options.prompt, "continue");
});

test("--resume before another flag uses the default path", () => {
  const { options, errors } = parse(["--resume", "--auto", "continue"]);
  assert.deepEqual(errors, []);
  assert.equal(options.resume, DEFAULT_RESUME);
  assert.equal(options.auto, true);
});

test("--resume can omit the model because the snapshot may supply it", () => {
  const { options, errors } = parseArgs(["go", "--resume"], { YARGIX_BASE_URL: "http://local/v1" } as NodeJS.ProcessEnv, false);
  assert.deepEqual(errors, []);
  assert.equal(options.model, "");
  assert.equal(options.resume, DEFAULT_RESUME);
});

test("--mode on the command line is marked explicit so resume cannot override it", () => {
  assert.equal(parse(["x", "--mode", "ask"]).options.modeExplicit, true);
  assert.equal(parse(["x"]).options.modeExplicit, false);
});
