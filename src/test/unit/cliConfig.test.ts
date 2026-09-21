/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Project CLI config files.
 *
 * A committed `.yargix/config.json` is how a repo shares model/endpoint/mode
 * with CI. The file is a trust boundary: unknown keys, `--auto`, and API keys
 * must fail the run instead of being ignored or applied.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { parseArgs, withConnectionErrors } from "../../cli/args";
import {
  DEFAULT_CONFIG_REL,
  MAX_CONFIG_BYTES,
  applyConfig,
  loadCliConfig,
  parseConfigText,
} from "../../cli/config";
import { isIoError } from "../../cli/io";

const ENV = { YARGIX_API_KEY: "k", YARGIX_BASE_URL: "https://api.test/v1", YARGIX_MODEL: "m" };

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "yargix-cfg-"));
}

function parse(argv: string[], env: NodeJS.ProcessEnv = ENV) {
  return parseArgs(argv, env, false);
}

// ----------------------------------------------------------- parseConfigText

test("an empty object is a valid no-op config", () => {
  const parsed = parseConfigText("{}");
  assert.equal(isIoError(parsed), false);
  assert.deepEqual(parsed, {});
});

test("known keys are accepted, including kebab-case aliases", () => {
  const parsed = parseConfigText(
    JSON.stringify({
      model: "local",
      "base-url": "http://127.0.0.1:8080/v1",
      mode: "ask",
      "max-steps": 12,
      timeout: 30,
      system: "be terse",
      anthropic: true,
    }),
  );
  if (isIoError(parsed)) assert.fail(parsed.error);
  assert.equal(parsed.model, "local");
  assert.equal(parsed.baseUrl, "http://127.0.0.1:8080/v1");
  assert.equal(parsed.mode, "ask");
  assert.equal(parsed.maxSteps, 12);
  assert.equal(parsed.timeout, 30);
  assert.equal(parsed.system, "be terse");
  assert.equal(parsed.anthropic, true);
});

test("strings are trimmed", () => {
  const parsed = parseConfigText(JSON.stringify({ model: "  local  ", system: "  hi  " }));
  if (isIoError(parsed)) assert.fail(parsed.error);
  assert.equal(parsed.model, "local");
  assert.equal(parsed.system, "hi");
});

test("invalid JSON is an error", () => {
  const parsed = parseConfigText("{");
  assert.ok(isIoError(parsed));
  assert.match(parsed.error, /not valid JSON/);
});

test("a top-level array is refused", () => {
  const parsed = parseConfigText("[]");
  assert.ok(isIoError(parsed));
  assert.match(parsed.error, /JSON object/);
});

test("an unknown key is an error, not ignored", () => {
  const parsed = parseConfigText(JSON.stringify({ model: "x", yolo: true }));
  assert.ok(isIoError(parsed));
  assert.match(parsed.error, /unknown config key "yolo"/);
});

test("an API key in the file is refused", () => {
  for (const raw of [{ apiKey: "sk-secret" }, { "api-key": "sk-secret" }]) {
    const parsed = parseConfigText(JSON.stringify(raw));
    assert.ok(isIoError(parsed));
    assert.match(parsed.error, /YARGIX_API_KEY/);
    assert.equal(JSON.stringify(parsed).includes("sk-secret"), false);
  }
});

test("auto in the file is refused so writes cannot be pre-approved", () => {
  const parsed = parseConfigText(JSON.stringify({ auto: true }));
  assert.ok(isIoError(parsed));
  assert.match(parsed.error, /--auto/);
});

test("an unknown mode is an error", () => {
  const parsed = parseConfigText(JSON.stringify({ mode: "sudo" }));
  assert.ok(isIoError(parsed));
  assert.match(parsed.error, /unknown mode/);
});

test("maxSteps must be a positive integer", () => {
  for (const maxSteps of [0, -1, 1.5, "12", true, null]) {
    const parsed = parseConfigText(JSON.stringify({ maxSteps }));
    assert.ok(isIoError(parsed), `${JSON.stringify(maxSteps)} should fail`);
  }
  const ok = parseConfigText(JSON.stringify({ maxSteps: 8 }));
  if (isIoError(ok)) assert.fail(ok.error);
  assert.equal(ok.maxSteps, 8);
});

test("timeout 0 is allowed (no limit); negatives and fractions are not", () => {
  const zero = parseConfigText(JSON.stringify({ timeout: 0 }));
  if (isIoError(zero)) assert.fail(zero.error);
  assert.equal(zero.timeout, 0);
  for (const timeout of [-1, 1.25, "30"]) {
    const parsed = parseConfigText(JSON.stringify({ timeout }));
    assert.ok(isIoError(parsed), `${JSON.stringify(timeout)} should fail`);
  }
});

test("empty strings are refused", () => {
  const parsed = parseConfigText(JSON.stringify({ model: "   " }));
  assert.ok(isIoError(parsed));
  assert.match(parsed.error, /empty/);
});

test("duplicate aliases for the same field are an error", () => {
  const parsed = parseConfigText(JSON.stringify({ baseUrl: "http://a", "base-url": "http://b" }));
  assert.ok(isIoError(parsed));
  assert.match(parsed.error, /more than once/);
});

test("camelCase and kebab-case are equivalent", () => {
  const a = parseConfigText(JSON.stringify({ baseUrl: "http://a", maxSteps: 3 }));
  const b = parseConfigText(JSON.stringify({ "base-url": "http://a", "max-steps": 3 }));
  if (isIoError(a)) assert.fail(a.error);
  if (isIoError(b)) assert.fail(b.error);
  assert.deepEqual(a, b);
});

// -------------------------------------------------------------- applyConfig

test("a config file beats the environment but loses to flags", () => {
  const fromEnv = parse(["do it"]);
  applyConfig(fromEnv.options, { model: "from-file" }, fromEnv.explicit);
  assert.equal(fromEnv.options.model, "from-file");

  const fromFlag = parse(["do it", "--model", "from-flag"]);
  applyConfig(fromFlag.options, { model: "from-file" }, fromFlag.explicit);
  assert.equal(fromFlag.options.model, "from-flag");
});

test("unset config keys leave existing values alone", () => {
  const { options, explicit } = parse(["do it", "--mode", "review"]);
  applyConfig(options, {}, explicit);
  assert.equal(options.mode, "review");
  assert.equal(options.model, "m");
  assert.equal(options.baseUrl, "https://api.test/v1");
});

test("config can supply the connection when env and flags do not", () => {
  const parsed = parse(["do it"], {} as NodeJS.ProcessEnv);
  assert.equal(parsed.options.model, "");
  assert.equal(parsed.options.baseUrl, "");
  applyConfig(parsed.options, { model: "local", baseUrl: "http://127.0.0.1:8080/v1" }, parsed.explicit);
  const finished = withConnectionErrors(parsed);
  assert.deepEqual(finished.errors, []);
  assert.equal(finished.options.model, "local");
  assert.equal(finished.options.baseUrl, "http://127.0.0.1:8080/v1");
});

test("config cannot turn on auto even if applyConfig is asked to", () => {
  // parseConfigText already rejects `auto`; applyConfig has no such field.
  const { options, explicit } = parse(["do it"]);
  applyConfig(options, { model: "x" }, explicit);
  assert.equal(options.auto, false);
});

test("an explicit --timeout  keeps 0 (no limit) against a file value", () => {
  const { options, explicit } = parse(["do it", "--timeout", "0"]);
  applyConfig(options, { timeout: 90 }, explicit);
  assert.equal(options.timeout, 0);
});

// ------------------------------------------------------------- loadCliConfig

test("a missing default config file is not an error", async () => {
  const root = await tempDir();
  const loaded = await loadCliConfig({ file: "", noConfig: false, cwd: root, invokeCwd: root });
  if (isIoError(loaded)) assert.fail(loaded.error);
  assert.deepEqual(loaded.config, {});
  assert.equal(loaded.source, "");
});

test("--no-config ignores a file that is sitting in the workspace", async () => {
  const root = await tempDir();
  await fs.mkdir(path.join(root, ".yargix"));
  await fs.writeFile(path.join(root, DEFAULT_CONFIG_REL), JSON.stringify({ model: "hidden" }));
  const loaded = await loadCliConfig({ file: "", noConfig: true, cwd: root, invokeCwd: root });
  if (isIoError(loaded)) assert.fail(loaded.error);
  assert.deepEqual(loaded.config, {});
  assert.equal(loaded.source, "");
});

test("the default path is discovered under --cwd", async () => {
  const root = await tempDir();
  await fs.mkdir(path.join(root, ".yargix"));
  const dest = path.join(root, DEFAULT_CONFIG_REL);
  await fs.writeFile(dest, JSON.stringify({ model: "workspace-model", mode: "ask" }));
  const loaded = await loadCliConfig({ file: "", noConfig: false, cwd: root, invokeCwd: os.tmpdir() });
  if (isIoError(loaded)) assert.fail(loaded.error);
  assert.equal(loaded.config.model, "workspace-model");
  assert.equal(loaded.config.mode, "ask");
  assert.equal(loaded.source, dest);
});

test("an explicit --config path is resolved from the invocation directory", async () => {
  const invoke = await tempDir();
  const workspace = await tempDir();
  const file = path.join(invoke, "ci.json");
  await fs.writeFile(file, JSON.stringify({ maxSteps: 7 }));
  const loaded = await loadCliConfig({
    file: "ci.json",
    noConfig: false,
    cwd: workspace,
    invokeCwd: invoke,
  });
  if (isIoError(loaded)) assert.fail(loaded.error);
  assert.equal(loaded.config.maxSteps, 7);
  assert.equal(loaded.source, file);
});

test("a missing --config path is an error", async () => {
  const root = await tempDir();
  const loaded = await loadCliConfig({
    file: "nope.json",
    noConfig: false,
    cwd: root,
    invokeCwd: root,
  });
  assert.ok(isIoError(loaded));
  assert.match(loaded.error, /not found/);
});

test("an empty config file is an error", async () => {
  const root = await tempDir();
  await fs.writeFile(path.join(root, "empty.json"), "   \n");
  const loaded = await loadCliConfig({
    file: "empty.json",
    noConfig: false,
    cwd: root,
    invokeCwd: root,
  });
  assert.ok(isIoError(loaded));
  assert.match(loaded.error, /empty/);
});

test("a directory used as --config is refused", async () => {
  const root = await tempDir();
  await fs.mkdir(path.join(root, "cfg"));
  const loaded = await loadCliConfig({ file: "cfg", noConfig: false, cwd: root, invokeCwd: root });
  assert.ok(isIoError(loaded));
  assert.match(loaded.error, /directory/);
});

test("an oversized config file is refused", async () => {
  const root = await tempDir();
  const huge = `${"{\n"}${" ".repeat(MAX_CONFIG_BYTES + 10)}\n}`;
  await fs.writeFile(path.join(root, "huge.json"), huge);
  const loaded = await loadCliConfig({
    file: "huge.json",
    noConfig: false,
    cwd: root,
    invokeCwd: root,
  });
  assert.ok(isIoError(loaded));
  assert.match(loaded.error, /exceeds/);
});

test("a discovered config that is invalid JSON fails the run", async () => {
  const root = await tempDir();
  await fs.mkdir(path.join(root, ".yargix"));
  await fs.writeFile(path.join(root, DEFAULT_CONFIG_REL), "{not json");
  const loaded = await loadCliConfig({ file: "", noConfig: false, cwd: root, invokeCwd: root });
  assert.ok(isIoError(loaded));
  assert.match(loaded.error, /not valid JSON/);
});
