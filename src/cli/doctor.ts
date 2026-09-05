/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Local health check for the CLI.
 *
 * A missing model or a dead endpoint should be found here, before a CI job
 * spends a minute starting a run that cannot talk to anything. Probes never
 * print secrets: an API key is only reported as set or unset.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { parseSession, DEFAULT_SESSION_JSON } from "./session";

export const DOCTOR_TIMEOUT_MS = 4_000;
export const OLLAMA_TAGS_URL = "http://127.0.0.1:11434/api/tags";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  version: string;
  node: string;
  cwd: string;
  ok: boolean;
  failures: number;
  warnings: number;
  checks: DoctorCheck[];
}

export interface DoctorInput {
  version: string;
  node: string;
  cwd: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  anthropic?: boolean;
}

export type DoctorFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface DoctorDeps {
  fetch?: DoctorFetch;
  stat?: (p: string) => Promise<{ isDirectory(): boolean }>;
  readFile?: (p: string) => Promise<string>;
}

const MIN_NODE_MAJOR = 20;

export async function runDoctor(input: DoctorInput, deps: DoctorDeps = {}): Promise<DoctorReport> {
  const facts = await collectFacts(input, deps);
  return evaluateDoctor(facts);
}

export function formatDoctor(report: DoctorReport): string {
  const lines = [
    `YargiX doctor  ${report.version}  node ${report.node.replace(/^v/, "")}`,
    `cwd  ${report.cwd}`,
    "",
  ];
  const width = Math.max(...report.checks.map((c) => c.id.length), 8);
  for (const check of report.checks) {
    const id = check.id.padEnd(width);
    const status = check.status.padEnd(4);
    lines.push(`${status}  ${id}  ${check.detail}`);
  }
  lines.push("");
  const summary = report.ok
    ? `${report.warnings} warning(s), 0 failure(s)`
    : `${report.warnings} warning(s), ${report.failures} failure(s)`;
  lines.push(summary);
  return `${lines.join("\n")}\n`;
}

export interface DoctorFacts {
  version: string;
  node: string;
  nodeMajor: number;
  cwd: string;
  cwdOk: boolean;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  endpoint?: { ok: boolean; status?: number; models?: string[]; error?: string };
  ollama?: { ok: boolean; models?: string[]; error?: string };
  session?: { present: boolean; valid?: boolean; steps?: number; error?: string };
}

export function evaluateDoctor(facts: DoctorFacts): DoctorReport {
  const checks: DoctorCheck[] = [];

  if (facts.nodeMajor > 0 && facts.nodeMajor < MIN_NODE_MAJOR) {
    checks.push({
      id: "runtime",
      title: "Node.js",
      status: "fail",
      detail: `node ${facts.node} (need ${MIN_NODE_MAJOR}+)`,
    });
  } else {
    checks.push({
      id: "runtime",
      title: "Node.js",
      status: "ok",
      detail: `node ${facts.node}, yargix ${facts.version}`,
    });
  }

  checks.push(
    facts.cwdOk
      ? { id: "cwd", title: "Working directory", status: "ok", detail: facts.cwd }
      : { id: "cwd", title: "Working directory", status: "fail", detail: `not a directory: ${facts.cwd}` },
  );

  checks.push(
    facts.model
      ? { id: "model", title: "Configured model", status: "ok", detail: facts.model }
      : {
          id: "model",
          title: "Configured model",
          status: "fail",
          detail: "unset (pass --model or set YARGIX_MODEL)",
        },
  );

  checks.push(
    facts.baseUrl
      ? { id: "endpoint", title: "Configured endpoint", status: "ok", detail: facts.baseUrl }
      : {
          id: "endpoint",
          title: "Configured endpoint",
          status: "fail",
          detail: "unset (pass --base-url or set YARGIX_BASE_URL)",
        },
  );

  checks.push(
    facts.hasApiKey
      ? { id: "api-key", title: "API key", status: "ok", detail: "set" }
      : {
          id: "api-key",
          title: "API key",
          status: "warn",
          detail: "unset (local servers often do not need one)",
        },
  );

  if (!facts.baseUrl) {
    checks.push({ id: "reachability", title: "Endpoint reachability", status: "skip", detail: "no endpoint configured" });
  } else if (!facts.endpoint) {
    checks.push({ id: "reachability", title: "Endpoint reachability", status: "skip", detail: "not probed" });
  } else if (facts.endpoint.ok) {
    const n = facts.endpoint.models?.length ?? 0;
    checks.push({
      id: "reachability",
      title: "Endpoint reachability",
      status: "ok",
      detail: n ? `${n} model(s)` : `HTTP ${facts.endpoint.status ?? 200}`,
    });
    if (facts.model && facts.endpoint.models && facts.endpoint.models.length) {
      const found = facts.endpoint.models.includes(facts.model);
      checks.push(
        found
          ? { id: "model-available", title: "Model on endpoint", status: "ok", detail: `${facts.model} is listed` }
          : {
              id: "model-available",
              title: "Model on endpoint",
              status: "warn",
              detail: `${facts.model} is not in the /models list`,
            },
      );
    }
  } else {
    checks.push({
      id: "reachability",
      title: "Endpoint reachability",
      status: "fail",
      detail: facts.endpoint.error ?? `HTTP ${facts.endpoint.status ?? "error"}`,
    });
  }

  if (!facts.ollama) {
    checks.push({ id: "ollama", title: "Ollama", status: "skip", detail: "not probed" });
  } else if (facts.ollama.ok) {
    const n = facts.ollama.models?.length ?? 0;
    checks.push({
      id: "ollama",
      title: "Ollama",
      status: "ok",
      detail: n ? `${n} local model(s) on 127.0.0.1:11434` : "running on 127.0.0.1:11434",
    });
  } else {
    checks.push({
      id: "ollama",
      title: "Ollama",
      status: "warn",
      detail: facts.ollama.error ?? "not running on 127.0.0.1:11434",
    });
  }

  if (!facts.session || !facts.session.present) {
    checks.push({
      id: "session",
      title: "Saved session",
      status: "skip",
      detail: `no ${DEFAULT_SESSION_JSON}`,
    });
  } else if (facts.session.valid) {
    checks.push({
      id: "session",
      title: "Saved session",
      status: "ok",
      detail: `${facts.session.steps ?? 0} step(s) in ${DEFAULT_SESSION_JSON}`,
    });
  } else {
    checks.push({
      id: "session",
      title: "Saved session",
      status: "fail",
      detail: facts.session.error ?? `invalid ${DEFAULT_SESSION_JSON}`,
    });
  }

  const failures = checks.filter((c) => c.status === "fail").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  return {
    version: facts.version,
    node: facts.node,
    cwd: facts.cwd,
    ok: failures === 0,
    failures,
    warnings,
    checks,
  };
}

async function collectFacts(input: DoctorInput, deps: DoctorDeps): Promise<DoctorFacts> {
  const fetchFn = deps.fetch ?? (globalThis.fetch as DoctorFetch);
  const statFn = deps.stat ?? ((p: string) => fs.stat(p));
  const readFn = deps.readFile ?? ((p: string) => fs.readFile(p, "utf8"));

  let cwdOk = false;
  try {
    cwdOk = (await statFn(input.cwd)).isDirectory();
  } catch {
    cwdOk = false;
  }

  const facts: DoctorFacts = {
    version: input.version,
    node: input.node,
    nodeMajor: nodeMajor(input.node),
    cwd: input.cwd,
    cwdOk,
    model: input.model.trim(),
    baseUrl: input.baseUrl.replace(/\/+$/, ""),
    hasApiKey: Boolean(input.apiKey.trim()),
  };

  if (facts.baseUrl) {
    facts.endpoint = await probeModels(fetchFn, facts.baseUrl, input.apiKey, input.anthropic);
  }
  facts.ollama = await probeOllama(fetchFn);

  const sessionPath = path.resolve(input.cwd, DEFAULT_SESSION_JSON);
  try {
    const raw = await readFn(sessionPath);
    const parsed = parseSession(raw);
    if ("error" in parsed) {
      facts.session = { present: true, valid: false, error: parsed.error };
    } else {
      facts.session = { present: true, valid: true, steps: parsed.snapshot.steps.length };
    }
  } catch {
    facts.session = { present: false };
  }

  return facts;
}

async function probeModels(
  fetchFn: DoctorFetch,
  baseUrl: string,
  apiKey: string,
  anthropic?: boolean,
): Promise<NonNullable<DoctorFacts["endpoint"]>> {
  const headers: Record<string, string> = anthropic
    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    : apiKey
      ? { authorization: `Bearer ${apiKey}` }
      : {};
  try {
    const r = await fetchFn(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(DOCTOR_TIMEOUT_MS) });
    if (!r.ok) {
      const body = (await r.text().catch(() => "")).trim();
      return { ok: false, status: r.status, error: body ? `HTTP ${r.status}: ${clip(body)}` : `HTTP ${r.status}` };
    }
    const data = await r.json();
    return { ok: true, status: r.status, models: modelIds(data) };
  } catch (e) {
    return { ok: false, error: probeError(e) };
  }
}

async function probeOllama(fetchFn: DoctorFetch): Promise<NonNullable<DoctorFacts["ollama"]>> {
  try {
    const r = await fetchFn(OLLAMA_TAGS_URL, { signal: AbortSignal.timeout(DOCTOR_TIMEOUT_MS) });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const data = await r.json();
    const models = ollamaNames(data);
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: probeError(e) };
  }
}

function modelIds(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const raw = (data as { data?: unknown }).data;
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => (m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string" ? (m as { id: string }).id : "")).filter(Boolean);
}

function ollamaNames(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const raw = (data as { models?: unknown }).models;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m) => (m && typeof m === "object" && typeof (m as { name?: unknown }).name === "string" ? (m as { name: string }).name : ""))
    .filter(Boolean);
}

function nodeMajor(version: string): number {
  const m = /^v?(\d+)/.exec(version);
  return m ? Number(m[1]) : 0;
}

function probeError(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "TimeoutError" || e.name === "AbortError") return `timed out after ${DOCTOR_TIMEOUT_MS}ms`;
    const msg = e.message || e.name;
    if (/fetch|ECONNREFUSED|ENOTFOUND|ECONNRESET|network/i.test(msg)) return "not reachable";
    return clip(msg);
  }
  return "not reachable";
}

function clip(text: string, max = 120): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}
