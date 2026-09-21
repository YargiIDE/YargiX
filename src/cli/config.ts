/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Project-level CLI settings.
 *
 * A repo can commit `.yargix/config.json` so every CI job and every developer
 * shares the same model, endpoint, mode and step budget. Flags still win, and
 * the file is not allowed to approve writes or hold an API key — those have to
 * stay explicit on the command line / in the environment.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { Mode } from "../agent/types";
import { MODES, type CliOptions } from "./args";
import { isIoError, readTextFile, type IoResult } from "./io";

/** Workspace-relative path looked up when `--config` is omitted. */
export const DEFAULT_CONFIG_REL = ".yargix/config.json";
/** A committed config is a handful of keys; anything bigger is a mistake. */
export const MAX_CONFIG_BYTES = 64_000;
const MAX_STEPS = 10_000;
const MAX_TIMEOUT_SEC = 1_000_000;

export interface CliFileConfig {
  model?: string;
  baseUrl?: string;
  mode?: Mode;
  maxSteps?: number;
  timeout?: number;
  system?: string;
  anthropic?: boolean;
}

/** Fields a config file is allowed to set. Flags named here beat the file. */
export const CONFIG_OVERRIDE_KEYS = [
  "model",
  "baseUrl",
  "mode",
  "maxSteps",
  "timeout",
  "system",
  "anthropic",
] as const;

export type ConfigOverrideKey = (typeof CONFIG_OVERRIDE_KEYS)[number];

const KEY_ALIASES: Record<string, ConfigOverrideKey> = {
  model: "model",
  baseUrl: "baseUrl",
  "base-url": "baseUrl",
  mode: "mode",
  maxSteps: "maxSteps",
  "max-steps": "maxSteps",
  timeout: "timeout",
  system: "system",
  anthropic: "anthropic",
};

const FORBIDDEN: Record<string, string> = {
  apiKey: "api keys belong in YARGIX_API_KEY, not a committed config file",
  "api-key": "api keys belong in YARGIX_API_KEY, not a committed config file",
  auto: "a config file cannot enable --auto; pass it on the command line",
  prompt: "a config file cannot supply the prompt",
  file: "a config file cannot set --file",
  stdin: "a config file cannot set --stdin",
  output: "a config file cannot set --output",
  json: "a config file cannot set --json",
  quiet: "a config file cannot set --quiet",
  interactive: "a config file cannot set --interactive",
  cwd: "working directory is set with --cwd, not the config file",
};

/**
 * Parse a config document. Unknown / forbidden keys fail loudly so a typo
 * cannot silently disable the setting the user thought they wrote.
 */
export function parseConfigText(raw: string): IoResult<CliFileConfig> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: "config file is not valid JSON" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "config file must be a JSON object" };
  }

  const obj = data as Record<string, unknown>;
  const out: CliFileConfig = {};
  const seen = new Set<ConfigOverrideKey>();

  for (const [key, value] of Object.entries(obj)) {
    const forbidden = FORBIDDEN[key];
    if (forbidden) return { error: forbidden };

    const field = KEY_ALIASES[key];
    if (!field) {
      const allowed = ["model", "baseUrl", "mode", "maxSteps", "timeout", "system", "anthropic"];
      return { error: `unknown config key "${key}" (expected: ${allowed.join(", ")})` };
    }
    if (seen.has(field)) return { error: `config specifies ${field} more than once` };
    seen.add(field);

    const parsed = parseField(field, value);
    if (isIoError(parsed)) return parsed;
    Object.assign(out, parsed);
  }

  return out;
}

/**
 * Overlay file values onto options. Keys the user passed on the command line
 * stay as they are: flags > file > environment > defaults.
 */
export function applyConfig(
  options: CliOptions,
  config: CliFileConfig,
  explicit: ReadonlySet<string>,
): void {
  if (config.model !== undefined && !explicit.has("model")) options.model = config.model;
  if (config.baseUrl !== undefined && !explicit.has("baseUrl")) options.baseUrl = config.baseUrl;
  if (config.mode !== undefined && !explicit.has("mode")) options.mode = config.mode;
  if (config.maxSteps !== undefined && !explicit.has("maxSteps")) options.maxSteps = config.maxSteps;
  if (config.timeout !== undefined && !explicit.has("timeout")) options.timeout = config.timeout;
  if (config.system !== undefined && !explicit.has("system")) options.system = config.system;
  if (config.anthropic !== undefined && !explicit.has("anthropic")) options.anthropic = config.anthropic;
}

/**
 * Load `--config <path>` or, when omitted, `.yargix/config.json` under `--cwd`.
 * A missing default file is not an error; a missing `--config` path is.
 */
export async function loadCliConfig(opts: {
  file: string;
  noConfig: boolean;
  cwd: string;
  invokeCwd?: string;
}): Promise<IoResult<{ config: CliFileConfig; source: string }>> {
  if (opts.noConfig) return { config: {}, source: "" };

  const invokeCwd = opts.invokeCwd ?? process.cwd();
  const explicit = Boolean(opts.file.trim());
  const relative = explicit ? opts.file.trim() : DEFAULT_CONFIG_REL;
  const base = explicit ? invokeCwd : opts.cwd;
  const resolved = path.resolve(base, relative);

  if (!explicit) {
    try {
      const st = await fs.stat(resolved);
      if (st.isDirectory()) return { error: `config file is a directory: ${DEFAULT_CONFIG_REL}` };
    } catch {
      return { config: {}, source: "" };
    }
  }

  const loaded = await readTextFile(relative, base, "config file", MAX_CONFIG_BYTES);
  if (isIoError(loaded)) return loaded;
  const parsed = parseConfigText(loaded.text);
  if (isIoError(parsed)) return parsed;
  return { config: parsed, source: loaded.path };
}

function parseField(field: ConfigOverrideKey, value: unknown): IoResult<CliFileConfig> {
  switch (field) {
    case "model":
    case "baseUrl":
    case "system": {
      if (typeof value !== "string") return { error: `config ${field} must be a string` };
      const text = value.trim();
      if (!text) return { error: `config ${field} is empty` };
      return { [field]: text };
    }
    case "mode": {
      if (typeof value !== "string") return { error: "config mode must be a string" };
      const mode = value.trim().toLowerCase();
      if (!(MODES as readonly string[]).includes(mode)) {
        return { error: `unknown mode in config "${value}" (expected: ${MODES.join(", ")})` };
      }
      return { mode: mode as Mode };
    }
    case "maxSteps": {
      const n = readInt(value, "maxSteps", 1, MAX_STEPS);
      if (isIoError(n)) return n;
      return { maxSteps: n.value };
    }
    case "timeout": {
      const n = readInt(value, "timeout", 0, MAX_TIMEOUT_SEC);
      if (isIoError(n)) return n;
      return { timeout: n.value };
    }
    case "anthropic":
      if (typeof value !== "boolean") return { error: "config anthropic must be a boolean" };
      return { anthropic: value };
    default: {
      const _exhaustive: never = field;
      return { error: `unhandled config key ${String(_exhaustive)}` };
    }
  }
}

function readInt(
  value: unknown,
  key: string,
  min: number,
  max: number,
): IoResult<{ value: number }> {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return { error: `config ${key} must be an integer` };
  }
  if (value < min) return { error: `config ${key} must be >= ${min}` };
  if (value > max) return { error: `config ${key} is too large (max ${max})` };
  return { value };
}
