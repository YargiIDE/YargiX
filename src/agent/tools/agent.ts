/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { Mode } from "../types";
import { getWorkspaceRoot } from "../../context/workspaceUtils";
import { pendingChanges } from "../../stores/pendingChanges";
import { defineTool, type AskQuestionItem, type TodoItem } from "./types";
import {
  getSubagentRunner,
  getQuestionAsker,
  planApprovalRequired,
  slugify,
  makeDiff,
  firstDiffLine,
} from "./shared";

/** The most recent plan written this session, used by the approval gate. */
let lastPlan: { title: string; path: string } | undefined;

// ---- TodoWrite ----
export const todoWriteTool = defineTool("TodoWrite", false, async (input, _abortSignal, _callId, ctx) => {
  if (!ctx) return { output: "error: todo context unavailable" };
  const incoming: TodoItem[] = Array.isArray(input.todos) ? input.todos : [];
  if (input.merge) {
    const byId = new Map(ctx.todos.map((t) => [t.id, t]));
    for (const t of incoming) byId.set(t.id, { ...byId.get(t.id), ...t });
    ctx.todos = [...byId.values()];
  } else {
    ctx.todos = incoming;
  }
  const render = ctx.todos
    .map((t) => {
      const mark =
        t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : t.status === "cancelled" ? "[-]" : "[ ]";
      return `${mark} ${t.content}`;
    })
    .join("\n");
  return { output: `Updated todos:\n${render}` };
});

// ---- TodoRead ----
export const todoReadTool = defineTool("TodoRead", false, async (_input, _abortSignal, _callId, ctx) => {
  if (!ctx) return { output: "error: todo context unavailable" };
  if (!ctx.todos.length) return { output: "(no todos)" };
  return { output: ctx.todos.map((t) => `- [${t.status}] ${t.content}`).join("\n") };
});

// ---- AskQuestion (interactive wizard form in the chat UI) ----
export const askQuestionTool = defineTool("AskQuestion", false, async (input, abortSignal, callId, ctx) => {
  const asker = ctx?.askUser ?? getQuestionAsker();
  if (!asker) return { output: "error: cannot ask questions in this context" };

  // Cursor shape: questions:[{id, prompt, options:[{id,label}], allow_multiple}], title.
  // Back-compat: also accept {question, options:[string], multiple} and header.
  const questions: AskQuestionItem[] = Array.isArray(input?.questions)
    ? input.questions
        .map((q: any) => ({
          question: String(q?.prompt ?? q?.question ?? ""),
          options: Array.isArray(q?.options)
            ? q.options.map((o: any) => (typeof o === "string" ? o : String(o?.label ?? o?.id ?? "")))
            : undefined,
          multiple: !!(q?.allow_multiple ?? q?.multiple),
        }))
        .filter((q: AskQuestionItem) => q.question)
    : [];
  if (!questions.length) return { output: "error: no questions provided" };

  try {
    const answers = await asker(callId || "", input?.title ?? input?.header ? String(input.title ?? input.header) : undefined, questions, abortSignal);
    const lines = questions.map((q, i) => {
      const a = answers[String(i)] ?? answers[q.question] ?? [];
      return `Q${i + 1}: ${q.question}\nA: ${a.length ? a.join(", ") : "(skipped)"}`;
    });
    return { output: "The user answered:\n\n" + lines.join("\n\n") };
  } catch (e: any) {
    if (e?.name === "AbortError") return { output: "error: cancelled" };
    return { output: "error: " + String(e?.message || e) };
  }
});

// ---- Task (launch a subagent) ----
export const taskTool = defineTool("Task", false, async (input, abortSignal, callId, ctx) => {
  const runner = ctx?.runSubagent ?? getSubagentRunner();
  if (!runner) return { output: "error: subagents are not available" };
  // Read-only subagent types or an explicit readonly flag run in ask mode.
  const roTypes = new Set(["explore", "cursor-guide", "docs-researcher", "code-reviewer", "bugbot", "security-review", "ci-investigator"]);
  const subType = String(input.subagent_type || "");
  const readonly = input.readonly === true || roTypes.has(subType);
  const subName = subType || undefined;
  const fileAttachments = Array.isArray(input.file_attachments)
    ? input.file_attachments.map((f: any) => String(f))
    : undefined;
  const result = await runner(String(input.prompt || ""), readonly, subName, abortSignal, callId, {
    model: input.model ? String(input.model) : undefined,
    runInBackground: input.run_in_background === true,
    description: input.description ? String(input.description) : undefined,
    fileAttachments,
    resume: input.resume ? String(input.resume) : undefined,
    interrupt: input.interrupt === true,
  });
  return { output: result };
});

// ---- SwitchMode ----
/** Modes that can change the workspace — entering one ends the planning phase. */
const EXECUTING_MODES = new Set(["agent", "multitask", "project", "debug"]);

export const switchModeTool = defineTool("SwitchMode", false, async (input, signal, callId, ctx) => {
  const target = String(input?.target_mode_id ?? "").trim().toLowerCase();
  const allowed = ["plan", "agent", "multitask", "project", "debug", "review"];
  if (!allowed.includes(target)) {
    return { output: `error: target_mode_id must be one of ${allowed.map((m) => `'${m}'`).join(", ")}` };
  }
  if (!ctx?.switchMode) return { output: "error: mode switching is not available in this run" };

  // Plan review gate. Leaving plan mode is the moment work starts touching the
  // workspace, so the user signs off on the plan first — the agent must never
  // approve its own plan and start implementing.
  const leavingPlan = ctx.getMode?.() === "plan" && EXECUTING_MODES.has(target);
  const asker = ctx.askUser ?? getQuestionAsker();
  if (leavingPlan && planApprovalRequired() && asker) {
    const APPROVE = "Approve — start implementing";
    const REVISE = "Not yet — keep planning";
    const named = lastPlan ? ` “${lastPlan.title}”` : "";
    let picked = "";
    try {
      const answers = await asker(
        callId ?? `plan-approval-${Date.now()}`,
        "Plan review",
        [{
          question: `Approve the plan${named} and start implementing it in ${target} mode?`,
          options: [APPROVE, REVISE],
        }],
        signal,
      );
      picked = Object.values(answers)[0]?.[0] ?? "";
    } catch {
      // The user dismissed or the run was cancelled — treat as "not approved".
      picked = "";
    }
    if (picked !== APPROVE) {
      return {
        output:
          "The user did not approve the plan, so the mode was NOT switched and you are still in plan mode. " +
          "Do not implement anything. Ask what should change, revise the plan with WritePlan, then request approval again.",
      };
    }
  }

  return { output: ctx.switchMode(target as Mode) };
});

// ---- WritePlan (plan mode only) ----
export const writePlanTool = defineTool("WritePlan", false, async (input) => {
  const root = getWorkspaceRoot();
  const dir = path.join(root, ".plans");
  await fs.mkdir(dir, { recursive: true });
  const file = `${slugify(input.title)}.md`;
  const rel = `.plans/${file}`;
  const p = path.join(dir, file);
  const body = `# ${String(input.title || "Plan").trim()}\n\n${String(input.content || "").trim()}\n`;
  let existedBefore = false;
  let original = "";
  try {
    original = await fs.readFile(p, "utf8");
    existedBefore = true;
  } catch {}
  await fs.writeFile(p, body, "utf8");
  pendingChanges.record(rel, original, body, existedBefore);
  // Remembered so the approval prompt can name the plan the user is signing off on.
  lastPlan = { title: String(input.title || "Plan").trim(), path: rel };
  return {
    output: `wrote plan to ${rel}. The user must approve it before implementation starts — call SwitchMode when you are ready to ask.`,
    diff: makeDiff(rel, original, body),
    startLine: firstDiffLine(original, body),
  };
});
