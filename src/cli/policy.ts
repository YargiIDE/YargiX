/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Least-privilege approvals for the CLI.
 *
 * The editor has a full policy UI. The terminal has flags: `--auto` still
 * means "allow everything", `--allow` / `--deny` name action types, and
 * `--strict` makes a blocked action fail the job instead of exiting 0 with
 * a polite note. Deny always wins, including over `--auto`.
 */

import {
  DEFAULT_APPROVAL,
  actionTypeForCall,
  deniedSubject,
  evaluateApproval,
  subjectFor,
  type ApprovalActionType,
  type ApprovalDecision,
  type ApprovalMode,
  type ApprovalPolicy,
} from "../agent/approvalPolicy";

export const ACTION_TYPES: readonly ApprovalActionType[] = [
  "shell",
  "edits",
  "delete",
  "mcp",
  "web",
  "outside",
];

/** Common aliases so `--allow write` does what people mean. */
const ALIASES: Record<string, ApprovalActionType> = {
  shell: "shell",
  command: "shell",
  commands: "shell",
  cmd: "shell",
  edits: "edits",
  edit: "edits",
  write: "edits",
  writes: "edits",
  files: "edits",
  delete: "delete",
  mcp: "mcp",
  web: "web",
  network: "web",
  fetch: "web",
  outside: "outside",
  external: "outside",
};

export type CliApproval = true | { approved: false; blockedSubject: string };

export function isActionType(value: string): value is ApprovalActionType {
  return (ACTION_TYPES as readonly string[]).includes(value);
}

/**
 * Parse a comma/space-separated list of action types.
 *
 * Unknown names are errors rather than silent ignores: a typo in CI would
 * otherwise leave the job running with the default (deny) and look like a
 * model failure.
 */
export function parseActionTypes(raw: string): { types: ApprovalActionType[] } | { error: string } {
  const parts = raw
    .split(/[,\s]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) return { error: "no action types (expected: " + ACTION_TYPES.join(", ") + ")" };
  const types: ApprovalActionType[] = [];
  const seen = new Set<ApprovalActionType>();
  for (const part of parts) {
    if (part === "all" || part === "*") {
      return { error: `"${part}" is not an action type (use --auto to allow everything; expected: ${ACTION_TYPES.join(", ")})` };
    }
    const type = ALIASES[part];
    if (!type) {
      return { error: `unknown action type "${part}" (expected: ${ACTION_TYPES.join(", ")})` };
    }
    if (!seen.has(type)) {
      seen.add(type);
      types.push(type);
    }
  }
  return { types };
}

export function uniqueTypes(types: readonly ApprovalActionType[]): ApprovalActionType[] {
  const seen = new Set<ApprovalActionType>();
  const out: ApprovalActionType[] = [];
  for (const type of types) {
    if (seen.has(type)) continue;
    seen.add(type);
    out.push(type);
  }
  return out;
}

/**
 * Build the policy the CLI will evaluate.
 *
 * Unattended runs still refuse "ask" (there is nobody to answer). Setting a
 * type to allow is what `--allow` / `--auto` actually do.
 */
export function buildCliPolicy(opts: {
  auto: boolean;
  allow: readonly ApprovalActionType[];
  deny: readonly ApprovalActionType[];
}): ApprovalPolicy {
  const allow = new Set(opts.allow);
  const deny = new Set(opts.deny);
  const policy = {} as ApprovalPolicy;
  for (const type of ACTION_TYPES) {
    let mode: ApprovalMode = opts.auto || allow.has(type) ? "allow" : "ask";
    if (deny.has(type)) mode = "deny";
    policy[type] = { mode, allowlist: [], denylist: [] };
  }
  // Keep any future action types on the default rather than crashing.
  for (const type of Object.keys(DEFAULT_APPROVAL) as ApprovalActionType[]) {
    if (!policy[type]) policy[type] = { ...DEFAULT_APPROVAL[type], allowlist: [], denylist: [] };
  }
  return policy;
}

export function resolveCliApproval(
  policy: ApprovalPolicy,
  toolName: string,
  input: unknown,
  workspaceRoot: string | undefined,
  kind: "unattended" | "ask",
): { decision: ApprovalDecision; type?: ApprovalActionType; reply?: CliApproval } {
  const decision = evaluateApproval(policy, toolName, input, workspaceRoot);
  const type = actionTypeForCall(toolName, input, workspaceRoot);
  if (decision === "allow") return { decision, type, reply: true };

  const named =
    deniedSubject(policy, toolName, input, workspaceRoot) ||
    (type ? subjectFor(type, toolName, input) : "") ||
    toolName;

  if (decision === "deny") {
    const hint = type ? `blocked by --deny ${type}` : "blocked by policy";
    return {
      decision,
      type,
      reply: { approved: false, blockedSubject: `${named} (${hint})` },
    };
  }

  if (kind === "unattended") {
    const hint = type
      ? `run with --auto or --allow ${type} to allow it`
      : "run with --auto to allow it";
    return {
      decision,
      type,
      reply: { approved: false, blockedSubject: `${toolName} (${hint})` },
    };
  }

  return { decision, type };
}

/**
 * Exit codes stay stable: 0 ok, 1 agent/timeout, 2 usage (caller), 3 denied
 * under `--strict`. A real failure beats a denial so CI sees the worse news.
 */
export function runExitCode(opts: { failed: boolean; denied: number; strict: boolean }): number {
  if (opts.failed) return 1;
  if (opts.strict && opts.denied > 0) return 3;
  return 0;
}
