/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Per-action-type approval policy for agent tools.
 *
 * Each action type has a mode plus allow/deny pattern lists:
 *   - "allow"  → run without asking
 *   - "ask"    → prompt the user every time
 *   - "review" → auto-review: allow when it looks safe, ask when risky
 *   - "deny"   → always block
 * Deny list beats allow list beats mode.
 */

import * as nodePath from "path";
import { normalizePathInput, toWorkspacePath } from "../context/workspaceUtils";

export type ApprovalMode = "allow" | "ask" | "review" | "deny";

export interface ApprovalRule {
	mode: ApprovalMode;
	/** Patterns that always allow (command prefix/wildcard, or path glob). */
	allowlist: string[];
	/** Patterns that always deny. */
	denylist: string[];
}

export type ApprovalActionType = "shell" | "edits" | "delete" | "mcp" | "web" | "outside";

export type ApprovalPolicy = Record<ApprovalActionType, ApprovalRule>;

const rule = (mode: ApprovalMode): ApprovalRule => ({ mode, allowlist: [], denylist: [] });

/** Safe defaults: everything prompts until the user loosens it. */
export const DEFAULT_APPROVAL: ApprovalPolicy = {
	shell: rule("ask"),
	edits: rule("ask"),
	delete: rule("ask"),
	mcp: rule("ask"),
	web: rule("ask"),
	outside: rule("ask"),
};

/** Map a tool name to its approval action type (undefined = ungated). */
export function actionTypeFor(toolName: string): ApprovalActionType | undefined {
	if (toolName === "Shell") return "shell";
	if (toolName === "Delete") return "delete";
	if (toolName === "StrReplace" || toolName === "Write" || toolName === "EditNotebook") return "edits";
	// Browser drives a real browser at a URL — same trust question as fetching one.
	if (toolName === "WebSearch" || toolName === "WebFetch" || toolName === "Browser") return "web";
	if (toolName.startsWith("mcp__")) return "mcp";
	return undefined;
}

/** Path-bearing inputs by tool. Every filesystem traversal must use this map. */
const PATH_INPUTS: Record<string, string[]> = {
	Read: ["path"],
	ListDir: ["path"],
	Glob: ["target_directory"],
	Grep: ["path"],
	SemanticSearch: ["target_directories"],
	StrReplace: ["path"],
	Write: ["path"],
	Delete: ["path"],
	EditNotebook: ["target_notebook"],
	Shell: ["working_directory"],
};

/** True when a file path lands outside the workspace root. */
export function isOutsideWorkspace(path: string, root: string | undefined): boolean {
	if (!root || !path) return false;
	const candidate = normalizePathInput(path);
	const resolvedRoot = nodePath.resolve(root);
	const resolvedPath = nodePath.resolve(resolvedRoot, candidate);
	const relative = nodePath.relative(resolvedRoot, resolvedPath);
	return relative === ".." || relative.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relative);
}

function pathsForCall(toolName: string, input: any, root?: string): string[] {
	return (PATH_INPUTS[toolName] ?? []).flatMap((key) => {
		const value = input?.[key];
		const paths = Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)];
		return root ? paths.map((item) => toWorkspacePath(item, root)) : paths;
	});
}

/**
 * Action type for a concrete call: file tools targeting paths outside the
 * workspace escalate to "outside" (covers Read, which is otherwise ungated).
 */
export function actionTypeForCall(toolName: string, input: any, root: string | undefined): ApprovalActionType | undefined {
	if (pathsForCall(toolName, input, root).some((path) => isOutsideWorkspace(path, root))) return "outside";
	return actionTypeFor(toolName);
}

/** The string a rule's patterns match against, per action type. */
export function subjectFor(type: ApprovalActionType, toolName: string, input: any): string {
	switch (type) {
		case "shell": return String(input?.command ?? "");
		case "edits":
		case "delete": return String(input?.path ?? input?.target_notebook ?? "");
		case "outside": return pathsForCall(toolName, input).join(", ");
		case "web": return String(input?.url ?? input?.search_term ?? input?.query ?? "");
		case "mcp": return toolName;
	}
}

/**
 * Split a shell command line into the individual commands it will run.
 * `git add -A; git commit -m "x"` must be checked as two commands — otherwise a
 * deny rule on `git commit` is bypassed by chaining it behind another command.
 * Quoted sections are ignored so separators inside strings don't split.
 */
export function splitShellCommands(command: string): string[] {
	const out: string[] = [];
	let buf = "";
	let quote: '"' | "'" | "`" | null = null;
	let depth = 0;
	const push = () => {
		const s = buf.trim();
		if (s) out.push(s);
		buf = "";
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		const next = command[i + 1];
		if (quote) {
			buf += c;
			// Inside single quotes POSIX has no escape character, so a `'` always
			// closes. Treating `\'` as escaped there would swallow the rest of the
			// line into one "command" and let a denied command ride along unchecked.
			const escaped = quote !== "'" && command[i - 1] === "\\";
			if (c === quote && !escaped) quote = null;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			quote = c;
			buf += c;
			continue;
		}
		// Sub-shells / command substitution: `$(...)`, `(...)`, `{...}`.
		if (c === "(" || c === "{") {
			depth++;
			buf += c;
			continue;
		}
		if (c === ")" || c === "}") {
			depth = Math.max(0, depth - 1);
			buf += c;
			continue;
		}
		if (depth === 0) {
			if (c === "\n" || c === ";") {
				push();
				continue;
			}
			if ((c === "&" || c === "|") && next === c) {
				push();
				i++;
				continue;
			}
			if (c === "|") {
				push();
				continue;
			}
		}
		buf += c;
	}
	push();
	// A sub-shell body still has to be checked: unwrap one level and re-split.
	return out.flatMap((part) => {
		const m = /^[$@&]?\s*[({]\s*([\s\S]*?)\s*[)}]\s*$/.exec(part);
		return m && m[1].trim() ? splitShellCommands(m[1]) : [part];
	});
}

/**
 * Wildcard pattern match. `prefixOk` distinguishes command-like subjects
 * (shell/mcp/web: `*` = any chars, exact/prefix match) from path-like ones
 * (edits/delete: glob semantics with `*` vs `**` + basename fallback).
 */
export function matchPattern(pattern: string, subject: string, prefixOk: boolean): boolean {
	const p = pattern.trim();
	if (!p) return false;
	const s = subject.replace(/\\/g, "/");
	if (p.includes("*")) {
		const esc = p.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		if (prefixOk) {
			// Command-like: `*` crosses everything (slashes included).
			const re = new RegExp(`^(?:${esc.replace(/\*+/g, ".*")})$`, "i");
			return re.test(s);
		}
		// Path-like: `**` crosses dirs, `*` stays within a segment.
		const rx = esc.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
		// Also try matching the basename so "*.md" works without "**/".
		const base = s.split("/").pop() ?? s;
		const re = new RegExp(`^(?:${rx})$`, "i");
		if (re.test(s) || re.test(base)) return true;
		// `dir/**` should also allow the directory itself (ListDir on that folder).
		if (p.endsWith("/**")) {
			const dir = p.slice(0, -3).replace(/\\/g, "/").toLowerCase();
			if (dir && (s === dir || s.startsWith(dir + "/"))) return true;
		}
		return false;
	}
	const pl = p.toLowerCase();
	const sl = s.toLowerCase();
	if (sl === pl) return true;
	if (!prefixOk) return sl.endsWith("/" + pl);
	// Command/URL-like prefix match, but only on a token boundary: an allowlist
	// entry of "git" must cover `git status` and `https://x.com` must cover
	// `https://x.com/a`, while never silently allowing `gitfoo` or `git-crypt`.
	if (!sl.startsWith(pl)) return false;
	// `.` counts as a continuation too, so an allowlisted "https://example.com"
	// never covers the look-alike host "https://example.com.evil.test".
	return !/[a-z0-9_.-]/i.test(sl.charAt(pl.length));
}

// Risky-looking subjects for "review" mode. ponytail: heuristic regexes; swap for
// an LLM judge (autoJudgeModel) if pattern coverage proves too coarse.
const RISKY_SHELL = /(\brm\s+-\w*[rf]|\brmdir\b|\bdel\s+\/|\bformat\b|\bmkfs|\bdd\s+if=|\bshutdown\b|\breboot\b|\bsudo\b|\bchmod\s+777|\bchown\b|\bgit\s+push\s+--force|\bgit\s+reset\s+--hard|\bgit\s+clean|\bnpm\s+publish|\bcurl[^|]*\|\s*(ba)?sh|\bwget[^|]*\|\s*(ba)?sh|Remove-Item.*-Recurse|Stop-Computer|Restart-Computer|\breg\s+delete|\btaskkill)/i;
const RISKY_PATH = /(^|[\\/])(\.env[^\\/]*|.*\.(pem|key|pfx|p12)|id_rsa[^\\/]*|credentials[^\\/]*|secrets?[^\\/]*|\.git[\\/])$/i;

function looksRisky(type: ApprovalActionType, subject: string): boolean {
	if (type === "shell") return RISKY_SHELL.test(subject);
	if (type === "edits" || type === "delete") return type === "delete" || RISKY_PATH.test(subject);
	if (type === "outside") return true; // outside-workspace access is always worth asking about in review mode
	return false; // mcp/web reviewed as safe by default
}

export type ApprovalDecision = "allow" | "ask" | "deny";

/** Decide one subject against a rule. */
function decideSubject(r: ApprovalRule, type: ApprovalActionType, subject: string, prefixOk: boolean): ApprovalDecision {
	if ((r.denylist ?? []).some((p) => matchPattern(p, subject, prefixOk))) return "deny";
	if ((r.allowlist ?? []).some((p) => matchPattern(p, subject, prefixOk))) return "allow";

	const mode: ApprovalMode = r.mode ?? "ask";
	if (mode === "allow") return "allow";
	if (mode === "deny") return "deny";
	if (mode === "review") return looksRisky(type, subject) ? "ask" : "allow";
	return "ask";
}

/**
 * Every subject a call must clear. A shell command line is checked per chained
 * command so a denied command can't ride along behind an allowed one.
 */
export function subjectsFor(type: ApprovalActionType, toolName: string, input: any): string[] {
	const subject = subjectFor(type, toolName, input);
	if (type !== "shell") return [subject];
	const parts = splitShellCommands(subject);
	return parts.length ? parts : [subject];
}

/**
 * Evaluate the policy for a tool call: deny list > allow list > mode.
 * The strictest decision across all of the call's subjects wins.
 */
export function evaluateApproval(policy: ApprovalPolicy, toolName: string, input: any, workspaceRoot?: string): ApprovalDecision {
	const type = actionTypeForCall(toolName, input, workspaceRoot);
	if (!type) return "allow";
	const r = policy[type] ?? DEFAULT_APPROVAL[type];
	const prefixOk = type === "shell" || type === "mcp" || type === "web";

	let decision: ApprovalDecision = "allow";
	for (const subject of subjectsFor(type, toolName, input)) {
		const d = decideSubject(r, type, subject, prefixOk);
		if (d === "deny") return "deny";
		if (d === "ask") decision = "ask";
	}
	return decision;
}

/** The chained command that triggered a deny (for the message shown to the model). */
export function deniedSubject(policy: ApprovalPolicy, toolName: string, input: any, workspaceRoot?: string): string | undefined {
	const type = actionTypeForCall(toolName, input, workspaceRoot);
	if (!type) return undefined;
	const r = policy[type] ?? DEFAULT_APPROVAL[type];
	const prefixOk = type === "shell" || type === "mcp" || type === "web";
	return subjectsFor(type, toolName, input).find((s) => decideSubject(r, type, s, prefixOk) === "deny");
}
