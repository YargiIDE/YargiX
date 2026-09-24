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
  /** Read the prompt from this file instead of argv. */
  file: string;
  /** Read the prompt from stdin. */
  stdin: boolean;
  /** Write the final answer to this path when the run finishes. */
  output: string;
  /** Extra user rules appended to the context block. */
  system: string;
  /** Wall-clock abort after this many seconds. 0 = no limit. */
  timeout: number;
  /**
   * Cap the model's reply. 0 = let the provider decide (same as the editor's
   * `yargix.maxResponseLength` default).
   */
  maxTokens: number;
  /** After a run that edited files, ask the model to re-read and check itself. */
  selfCheck: boolean;
  /**
   * Inject workspace rules, memory, skills, and recently viewed files.
   * Off is cheaper and more deterministic for isolated CI prompts.
   */
  workspace: boolean;
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
  -f, --file <path>      Read the prompt from a file (use - for stdin)
      --stdin            Read the prompt from stdin
  -o, --output <path>    Write the final answer to a file when the run finishes
      --system <text>    Extra instructions (user rules) for this run
      --timeout <sec>    Abort the run after this many seconds (0 = no limit)
      --max-tokens <n>   Cap the model's reply (0 = let the provider decide)
      --max-steps <n>    Stop after n agent steps (default: 50)
      --no-self-check    Skip the post-edit "verify your own work" turn
      --self-check       Force that turn on (the default)
      --no-workspace     Do not inject rules, memory, skills, or recent files
      --workspace        Inject workspace context (the default)
      --auto             Approve file writes and commands without asking.
                         Required for anything that changes the workspace.
      --json             Emit newline-delimited JSON events, for CI
  -i, --interactive      Open a session instead of answering once
  -q, --quiet            Only print the final answer
  -h, --help             Show this help
  -V, --version          Show the version

ENVIRONMENT
  YARGIX_API_KEY, YARGIX_BASE_URL, YARGIX_MODEL, YARGIX_MAX_TOKENS

EXIT CODES
  0 success   1 agent error   2 bad usage

EXAMPLES
  yargix "explain what this project does" --mode ask
  yargix "add a --verbose flag and update the README" --auto
  yargix "review the uncommitted changes" --mode review --json
  yargix --file task.md --output answer.md --auto --timeout 600
  yargix --file task.md --auto --no-self-check --max-tokens 2048
  cat prompt.txt | yargix --stdin --mode ask`;

function toInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 0 is a real value ("unset"), unlike {@link toInt} which treats it as missing. */
function toNatural(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * The subset of {@link CliOptions} that maps onto the agent loop.
 *
 * Kept next to the parser so a flag cannot exist without a field the loop
 * actually reads. `maxTokens` is omitted when unset so the provider default
 * stays in charge.
 */
export function loopFlags(opts: Pick<CliOptions, "maxTokens" | "selfCheck" | "workspace">): {
  maxTokens?: number;
  selfCheckEnabled: boolean;
  enableWorkspaceContext: boolean;
} {
  return {
    ...(opts.maxTokens > 0 ? { maxTokens: opts.maxTokens } : {}),
    selfCheckEnabled: opts.selfCheck,
    enableWorkspaceContext: opts.workspace,
  };
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
    file: "",
    stdin: false,
    output: "",
    system: "",
    timeout: 0,
    maxTokens: toNatural(env.YARGIX_MAX_TOKENS, 0),
    selfCheck: true,
    workspace: true,
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
  const value = (flag: string, next: string | undefined, allowDash = false): string => {
    if (next === undefined || (next.startsWith("-") && !(allowDash && next === "-"))) {
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
      case "-f":
      case "--file": {
        const v = value(arg, argv[++i], true);
        if (v === "-") options.stdin = true;
        else if (v) options.file = v;
        break;
      }
      case "--stdin":
        options.stdin = true;
        break;
      case "-o":
      case "--output":
        options.output = value(arg, argv[++i], true);
        break;
      case "--system":
        options.system = value(arg, argv[++i]);
        break;
      case "--timeout":
        options.timeout = toInt(value(arg, argv[++i]), 0);
        break;
      case "--max-tokens":
        options.maxTokens = toNatural(value(arg, argv[++i]), options.maxTokens);
        break;
      case "--no-self-check":
        options.selfCheck = false;
        break;
      case "--self-check":
        options.selfCheck = true;
        break;
      case "--no-workspace":
        options.workspace = false;
        break;
      case "--workspace":
        options.workspace = true;
        break;
      default:
        // A lone "-" is the Unix stdin placeholder, not an unknown flag.
        if (arg.startsWith("-") && arg !== "-") errors.push(`unknown option "${arg}"`);
        else positional.push(arg);
    }
  }

  options.prompt = positional.join(" ").trim();
  // Unix convention: a lone "-" means "read the prompt from stdin".
  if (options.prompt === "-") {
    options.stdin = true;
    options.prompt = "";
  }

  if (options.help || options.version) return { options, errors: [] };
  if (options.output === "-") errors.push("output path cannot be '-' (the answer already streams to stdout)");
  if (options.file && options.stdin) errors.push("pass --file or --stdin, not both");
  if (options.file && options.prompt) errors.push("pass a prompt or --file, not both");
  if (options.stdin && options.prompt) errors.push("pass a prompt or --stdin, not both");
  if (options.stdin && options.interactive) errors.push("--stdin cannot be used with --interactive");
  if (options.stdin && interactiveDefault) errors.push("--stdin needs piped input (stdin is a terminal)");
  // No prompt and a terminal attached: start a session rather than complain.
  const hasPrompt = Boolean(options.prompt || options.file || options.stdin);
  if (!hasPrompt && !options.interactive && interactiveDefault) options.interactive = true;
  if (!hasPrompt && !options.interactive) errors.push("a prompt is required");
  if (!options.model) errors.push("no model: pass --model or set YARGIX_MODEL");
  if (!options.baseUrl) errors.push("no endpoint: pass --base-url or set YARGIX_BASE_URL");

  return { options, errors };
}

/** Modes that can change the workspace, and therefore need --auto to do so. */
export function isExecutingMode(mode: Mode): boolean {
  return mode === "agent" || mode === "debug" || mode === "multitask" || mode === "project";
}
