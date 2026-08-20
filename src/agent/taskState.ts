/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { TodoItem } from "./tools";

/**
 * Durable run memory that lives outside the message history.
 *
 * History may be summarized or trimmed at the budget ceiling; this ledger does not. It records
 * one short line per tool call — what was done, to what, and how it ended — so a
 * compacted conversation still knows everything that happened, without carrying
 * a single line of file content. Rendered fresh on every step, so it costs the
 * same handful of tokens no matter how long the run gets.
 */

/** One recorded action: the shape of a tool card, minus its payload. */
interface Entry {
	name: string;
	target: string;
	ok: boolean;
	note: string;
}

/** Path-ish argument keys, in the order they identify a tool's target. */
const TARGET_KEYS = ["path", "target_notebook", "target_directory", "file", "url", "glob_pattern", "pattern", "query", "command", "description"];

function targetOf(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const o = input as Record<string, unknown>;
	for (const k of TARGET_KEYS) {
		const v = o[k];
		if (typeof v === "string" && v.trim()) return v.trim().replace(/\s+/g, " ").slice(0, 90);
	}
	return "";
}

function firstLine(s: string, max: number): string {
	const line = (s || "").split(/\r?\n/).find((l) => l.trim()) ?? "";
	return line.trim().slice(0, max);
}

function countLines(s: unknown): number {
	return typeof s === "string" && s ? s.split(/\r?\n/).length : 0;
}

/** Short outcome note per tool — the useful part of a card, never the payload. */
function noteFor(name: string, input: unknown, ok: boolean, output: string): string {
	if (!ok) return `failed: ${firstLine(output.replace(/^error:\s*/i, ""), 120)}`;
	const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	switch (name) {
		case "Write":
			return `wrote ${countLines(o.contents)} lines`;
		case "StrReplace": {
			const before = countLines(o.old_string);
			const after = countLines(o.new_string);
			const plus = Math.max(0, after - before);
			const minus = Math.max(0, before - after);
			return plus || minus ? `edited +${plus} -${minus}` : "edited";
		}
		case "EditNotebook":
			return o.is_new_cell ? `added cell ${String(o.cell_idx ?? "")}` : `edited cell ${String(o.cell_idx ?? "")}`;
		case "Delete":
			return "deleted";
		case "Read": {
			const m = /^\s*\.{3}\s*(\d+)/.exec(output);
			return m ? `read (${m[1]} lines skipped)` : "read";
		}
		case "Shell":
		case "AwaitShell":
			return firstLine(output, 120) || "ran";
		case "WritePlan":
			return `plan written${o.title ? `: ${String(o.title).slice(0, 60)}` : ""}`;
		case "Task":
			return `subagent ${String(o.subagent_type || "generalPurpose")} → ${firstLine(output, 90)}`;
		case "TodoWrite":
			return "todos updated";
		case "SwitchMode":
			return `mode → ${String(o.target_mode_id ?? "")}`;
		case "AskQuestion":
			return "asked the user";
		default: {
			const n = output.length;
			return n > 400 ? `ok (${n} chars)` : firstLine(output, 90) || "ok";
		}
	}
}

/** Tools whose result adds nothing once recorded (pure navigation noise). */
const SKIP = new Set(["TodoRead", "ListMcpResources"]);

export class ActivityLedger {
	private readonly entries: Entry[] = [];
	/** path -> cumulative +added/-removed, so the file ledger stays one line each. */
	private readonly files = new Map<string, { plus: number; minus: number; deleted: boolean }>();
	private plan = "";

	/** Record a settled tool call. Consecutive identical actions collapse. */
	record(name: string, input: unknown, status: "completed" | "error", output: string): void {
		if (SKIP.has(name)) return;
		const ok = status === "completed";
		const target = targetOf(input);
		const entry: Entry = { name, target, ok, note: noteFor(name, input, ok, output || "") };
		const last = this.entries[this.entries.length - 1];
		if (last && last.name === entry.name && last.target === entry.target && last.note === entry.note) return;
		this.entries.push(entry);

		if (ok && (name === "Write" || name === "StrReplace" || name === "EditNotebook" || name === "Delete")) {
			const path = target;
			if (path) {
				const cur = this.files.get(path) ?? { plus: 0, minus: 0, deleted: false };
				if (name === "Delete") cur.deleted = true;
				else {
					const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
					const before = countLines(o.old_string);
					const after = name === "Write" ? countLines(o.contents) : countLines(o.new_string);
					cur.plus += Math.max(0, after - before);
					cur.minus += Math.max(0, before - after);
				}
				this.files.set(path, cur);
			}
		}
		if (ok && name === "WritePlan") {
			const m = /\.plans\/[^\s`"']+/.exec(output);
			if (m) this.plan = m[0];
		}
	}

	get isEmpty(): boolean {
		return this.entries.length === 0 && this.files.size === 0;
	}

	/**
	 * Render the durable state block: the request, the todo list, the files
	 * touched, and the action log (most recent last, older entries counted).
	 */
	render(opts: { request: string; todos: TodoItem[]; maxActions?: number }): string {
		const maxActions = opts.maxActions ?? 60;
		const parts: string[] = [];

		const request = opts.request.trim().replace(/\s+/g, " ");
		if (request) parts.push(`Original request: ${request.length > 600 ? `${request.slice(0, 600)}…` : request}`);

		if (opts.todos.length) {
			const mark = (s: TodoItem["status"]) => (s === "completed" ? "x" : s === "in_progress" ? ">" : s === "cancelled" ? "-" : " ");
			parts.push(`Todos:\n${opts.todos.map((t) => `  [${mark(t.status)}] ${t.content}`).join("\n")}`);
		}

		if (this.files.size) {
			const lines = [...this.files.entries()].map(([path, d]) =>
				`  ${path}${d.deleted ? " (deleted)" : ` +${d.plus} -${d.minus}`}`,
			);
			parts.push(`Files changed this run:\n${lines.join("\n")}`);
		}

		if (this.plan) parts.push(`Plan file: ${this.plan}`);

		if (this.entries.length) {
			const shown = this.entries.slice(-maxActions);
			const hidden = this.entries.length - shown.length;
			const lines = shown.map((e) => `  ${e.ok ? "✓" : "✗"} ${e.name}${e.target ? ` ${e.target}` : ""} — ${e.note}`);
			parts.push(
				`Actions so far (${this.entries.length} total${hidden ? `, ${hidden} older omitted` : ""}):\n${lines.join("\n")}`,
			);
		}

		if (!parts.length) return "";
		return `<task_state>\nDurable record of this run. It survives context compaction, so trust it over your recollection. Notes are brief — re-read a file or re-run a command if you need its full content again.\n\n${parts.join("\n\n")}\n</task_state>`;
	}
}
