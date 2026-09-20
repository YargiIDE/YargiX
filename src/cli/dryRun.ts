/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * `--dry-run`: validate a one-shot run without spending a model call.
 *
 * A CI job wants to fail fast on a missing prompt file, a bad working
 * directory, or an unset model — before it waits on a provider. A dry run
 * applies the same checks a real run would (prompt source, cwd, output path,
 * plus the model and endpoint presence the parser already enforced) and then
 * prints the resolved configuration instead of contacting anyone. It never
 * writes files and never touches the network; the API key is reported only
 * as set or unset, never echoed.
 */

import * as fs from "fs/promises";
import * as path from "path";

import { USAGE, type CliOptions } from "./args";
import { isIoError, loadPrompt, promptSource, type IoResult } from "./io";

export type DryRunPromptSource = "argv" | "file" | "stdin";

/** Everything a dry run reports. `apiKey` is set/unset, never the value. */
export interface DryRunInfo {
  mode: string;
  model: string;
  endpoint: string;
  apiKey: "set" | "unset";
  anthropic: boolean;
  promptBytes: number;
  promptFrom: DryRunPromptSource;
  /** The prompt file as passed, when `--file` was used. */
  promptFile: string;
  systemBytes: number;
  /** Resolved output path, or "" when no `--output` was passed. */
  output: string;
  cwd: string;
  timeoutSec: number;
  maxSteps: number;
  auto: boolean;
}

export interface DryRunStreams {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream;
}

/** Where the prompt comes from. Mirrors `promptSource` without reading anything. */
export function promptSourceKind(options: Pick<CliOptions, "file" | "stdin">): DryRunPromptSource {
  if (options.file) return "file";
  if (options.stdin) return "stdin";
  return "argv";
}

/**
 * Human-readable report. Output stays ASCII: the default Windows console code
 * page mangles box glyphs and dashes (see `describe` in main.ts).
 */
export function describeDryRun(info: DryRunInfo): string {
  const prompt =
    info.promptFrom === "file"
      ? `${info.promptBytes} bytes from --file ${info.promptFile}`
      : info.promptFrom === "stdin"
        ? `${info.promptBytes} bytes from stdin`
        : `${info.promptBytes} bytes from argv`;
  const lines = [
    "dry run ok: the run would start (no model call was made)",
    `mode: ${info.mode}`,
    `model: ${info.model}`,
    `endpoint: ${info.endpoint}`,
    `api-key: ${info.apiKey}`,
    `anthropic: ${info.anthropic ? "on" : "off"}`,
    `prompt: ${prompt}`,
    `system: ${info.systemBytes} bytes`,
    `output: ${info.output || "(none)"}`,
    `cwd: ${info.cwd}`,
    `timeout: ${info.timeoutSec > 0 ? `${info.timeoutSec}s` : "none"}`,
    `max-steps: ${info.maxSteps}`,
    `auto: ${info.auto ? "on" : "off"}`,
  ];
  return `${lines.join("\n")}\n`;
}

/** Single-line JSON report, matching the `--json` newline-delimited convention. */
export function dryRunJson(info: DryRunInfo): string {
  return JSON.stringify({ dryRun: true, ok: true, ...info });
}

/** Assemble the report from validated inputs. Pure, so tests need no filesystem. */
export function buildDryRunInfo(
  options: Pick<
    CliOptions,
    | "mode"
    | "model"
    | "baseUrl"
    | "apiKey"
    | "anthropic"
    | "file"
    | "stdin"
    | "system"
    | "timeout"
    | "maxSteps"
    | "auto"
  >,
  promptText: string,
  resolved: { output: string; cwd: string },
): DryRunInfo {
  return {
    mode: options.mode,
    model: options.model,
    endpoint: options.baseUrl,
    apiKey: options.apiKey ? "set" : "unset",
    anthropic: options.anthropic ?? false,
    promptBytes: Buffer.byteLength(promptText, "utf8"),
    promptFrom: promptSourceKind(options),
    promptFile: options.file,
    systemBytes: Buffer.byteLength(options.system, "utf8"),
    output: resolved.output,
    cwd: resolved.cwd,
    timeoutSec: options.timeout,
    maxSteps: options.maxSteps,
    auto: options.auto,
  };
}

async function resolveCwd(cwd: string): Promise<IoResult<{ cwd: string }>> {
  const resolved = path.resolve(cwd);
  let st;
  try {
    st = await fs.stat(resolved);
  } catch {
    return { error: `working directory not found: ${cwd}` };
  }
  if (!st.isDirectory()) return { error: `working directory is not a directory: ${cwd}` };
  return { cwd: resolved };
}

/**
 * Check the `--output` target without writing anything: a missing file is
 * fine (a real run would create it, parents included), a directory is not.
 */
async function resolveOutput(output: string, cwd: string): Promise<IoResult<{ output: string }>> {
  if (!output) return { output: "" };
  const resolved = path.resolve(cwd, output);
  try {
    const st = await fs.stat(resolved);
    if (st.isDirectory()) return { error: `output path is a directory: ${output}` };
  } catch {
    // Missing: a real run would create it.
  }
  return { output: resolved };
}

/**
 * Validate the run and print the resolved configuration.
 * Returns a process exit code: 0 when the run would start, 2 on any failure.
 */
export async function runDryRun(
  options: CliOptions,
  streams: DryRunStreams = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin },
): Promise<number> {
  const fail = (message: string, withUsage = false): number => {
    streams.stderr.write(withUsage ? `error: ${message}\n\n${USAGE}\n` : `error: ${message}\n`);
    return 2;
  };

  // Same resolution a real run applies, so a dry run proves the run would start.
  const source = promptSource(options);
  if ("error" in source) return fail(source.error, true);
  const loaded = await loadPrompt(source, options.cwd, streams.stdin);
  if (isIoError(loaded)) return fail(loaded.error);

  const checkedCwd = await resolveCwd(options.cwd);
  if (isIoError(checkedCwd)) return fail(checkedCwd.error);
  const checkedOutput = await resolveOutput(options.output, options.cwd);
  if (isIoError(checkedOutput)) return fail(checkedOutput.error);

  const info = buildDryRunInfo(options, loaded.text, {
    output: checkedOutput.output,
    cwd: checkedCwd.cwd,
  });
  streams.stdout.write(options.json ? `${dryRunJson(info)}\n` : describeDryRun(info));
  return 0;
}
