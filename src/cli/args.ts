/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX - AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { Mode } from "../agent/types";

export const MODES: Mode[] = ["agent", "ask", "plan", "debug", "review", "multitask", "project"];

export interface CliOptions {
  prompt: string;
  mode: Mode;
  model: string;
  baseUrl: string;
  apiKey: string;
  anthropic?: boolean;
  cwd: string;
  maxSteps: number;
  /** Approve tool actions the policy would otherwise stop on. */
  auto: boolean;
  /** Emit one JSON object per event instead of human-readable text. */
  json: boolean;
  quiet: boolean;
  /** Hold a session open instead of answering once and exiting. */
  interactive: boolean;
  help: boolean;
  version: boolean;
}

export interface ParseResult {
  options: CliOptions;
  errors: string[];
}

export const USAGE = `yargix - run the YargiX coding agent from the terminal

USAGE
  yargix "<prompt>" [options]     answer once and exit
  yargix [options]                open an interactive session

OPTIONS
  -m, --mode <mode>      agent | ask | plan | debug | review | multitask | project  (default: agent)
      --model <id>       Model id. Default: $YARGIX_MODEL
      --base-url <url>   OpenAI-compatible base URL. Default: $YARGIX_BASE_URL
      --api-key <key>    API key. Default: $YARGIX_API_KEY  (prefer the env var)
      --anthropic        Talk to the base URL as an Anthropic Messages endpoint
  -C, --cwd <dir>        Directory to work in (default: the current directory)
      --max-steps <n>    Stop after n agent steps (default: 50)
      --auto             Approve file writes and commands without asking.
                         Required for anything that changes the workspace.
      --json             Emit newline-delimited JSON events, for CI
  -i, --interactive      Open a session instead of answering once
  -q, --quiet            Only print the final answer
  -h, --help             Show this help
  -V, --version          Show the version

ENVIRONMENT
  YARGIX_API_KEY, YARGIX_BASE_URL, YARGIX_MODEL

EXIT CODES
  0 success   1 agent error   2 bad usage

EXAMPLES
  yargix "explain what this project does" --mode ask
  yargix "add a --verbose flag and update the README" --auto
  yargix "review the uncommitted changes" --mode review --json`;

function toInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Parse argv (without node/script) into options.
 *
 * Errors are collected rather than thrown so the caller can print all of them
 * at once alongside the usage text.
 */
export function parseArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  /** True when stdin is a terminal, so a bare invocation can open a session. */
  interactiveDefault = Boolean(process.stdin.isTTY),
): ParseResult {
  const errors: string[] = [];
  const positional: string[] = [];
  const options: CliOptions = {
    prompt: "",
    mode: "agent",
    model: env.YARGIX_MODEL ?? "",
    baseUrl: env.YARGIX_BASE_URL ?? "",
    apiKey: env.YARGIX_API_KEY ?? "",
    cwd: process.cwd(),
    maxSteps: 50,
    auto: false,
    json: false,
    quiet: false,
    interactive: false,
    help: false,
    version: false,
  };

  /** Read the value that follows a flag, recording an error when it is missing. */
  const value = (flag: string, next: string | undefined): string => {
    if (next === undefined || next.startsWith("-")) {
      errors.push(`${flag} needs a value`);
      return "";
    }
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-V":
      case "--version":
        options.version = true;
        break;
      case "--auto":
        options.auto = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "-q":
      case "--quiet":
        options.quiet = true;
        break;
      case "--anthropic":
        options.anthropic = true;
        break;
      case "-i":
      case "--interactive":
        options.interactive = true;
        break;
      case "-m":
      case "--mode": {
        const v = value(arg, argv[++i]).toLowerCase();
        if (v && !MODES.includes(v as Mode)) errors.push(`unknown mode "${v}" (expected: ${MODES.join(", ")})`);
        else if (v) options.mode = v as Mode;
        break;
      }
      case "--model":
        options.model = value(arg, argv[++i]) || options.model;
        break;
      case "--base-url":
        options.baseUrl = value(arg, argv[++i]) || options.baseUrl;
        break;
      case "--api-key":
        options.apiKey = value(arg, argv[++i]) || options.apiKey;
        break;
      case "-C":
      case "--cwd":
        options.cwd = value(arg, argv[++i]) || options.cwd;
        break;
      case "--max-steps":
        options.maxSteps = toInt(value(arg, argv[++i]), options.maxSteps);
        break;
      default:
        if (arg.startsWith("-")) errors.push(`unknown option "${arg}"`);
        else positional.push(arg);
    }
  }

  options.prompt = positional.join(" ").trim();

  if (options.help || options.version) return { options, errors: [] };
  // No prompt and a terminal attached: start a session rather than complain.
  if (!options.prompt && !options.interactive && interactiveDefault) options.interactive = true;
  if (!options.prompt && !options.interactive) errors.push("a prompt is required");
  if (!options.model) errors.push("no model: pass --model or set YARGIX_MODEL");
  if (!options.baseUrl) errors.push("no endpoint: pass --base-url or set YARGIX_BASE_URL");

  return { options, errors };
}

/** Modes that can change the workspace, and therefore need --auto to do so. */
export function isExecutingMode(mode: Mode): boolean {
  return mode === "agent" || mode === "debug" || mode === "multitask" || mode === "project";
}
