/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * The YargiX CLI: the same agent, driven from a terminal or a CI job.
 *
 * There is no one to answer an approval prompt here, so anything that would
 * normally ask is denied unless `--auto` was passed. That keeps a pipeline from
 * silently gaining write access to a checkout.
 */

import { configureShim } from "./vscodeShim";
import { parseArgs, isExecutingMode, USAGE, type CliOptions } from "./args";
import { isIoError, loadPrompt, promptSource, writeTextFile } from "./io";
import { createFallbackResolver, isUnsafeToRetryTool, runWithRetries } from "./retry";
import type { AgentEvent } from "../agent/types";
import { browserSession } from "../integrations/browser";

const VERSION = "0.1.0";

/** Settings the agent core reads through `workspace.getConfiguration`. */
function shimSettings(opts: CliOptions): Record<string, unknown> {
  return {
    "yargix.agent.selfCheck": true,
    // No editor to review in, so the plan gate would have nobody to ask.
    "yargix.plan.requireApproval": false,
    "yargix.inlineCompletions.enabled": false,
    "yargix.mcpServer.enabled": false,
    "yargix.browser.headless": true,
    "yargix.terminal.showFixButton": false,
    "yargix.model": opts.model,
  };
}

/**
 * Human-readable one-liner for an event, or undefined to stay silent.
 *
 * Output stays ASCII: the default Windows console code page mangles box glyphs
 * and dashes, and a CLI that looks broken in cmd.exe is a CLI that looks broken.
 *
 * `announced` exists because `tool-call-started` is an upsert, not an
 * occurrence — the loop emits it repeatedly for one call to enrich it (name,
 * then parsed input, then the start time). A chat UI keyed by callId shows one
 * card; a line-oriented log would print the same tool three times.
 */
function describe(ev: AgentEvent, announced: Set<string>): string | undefined {
  switch (ev.type) {
    case "tool-call-started": {
      if (announced.has(ev.callId)) return undefined;
      announced.add(ev.callId);
      return `- ${ev.name}`;
    }
    case "tool-call-completed":
      return ev.status === "error" ? `  x ${ev.name} failed` : undefined;
    case "run-status":
      return ev.status === "running" ? undefined : `- ${ev.status}`;
    case "error":
      return `x ${ev.message}`;
    case "retry":
      return `- retrying (${ev.attempt}/${ev.max})`;
    case "compaction":
      return ev.status === "running" ? "- summarizing context" : undefined;
    case "shell-notify":
      return `- ${ev.message}`;
    case "max-steps":
      return `- stopped at the ${ev.steps}-step limit (raise it with --max-steps)`;
    default:
      return undefined;
  }
}

async function main(): Promise<number> {
  const { options, errors } = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`yargix ${VERSION}\n`);
    return 0;
  }
  if (errors.length) {
    process.stderr.write(`${errors.map((e) => `error: ${e}`).join("\n")}\n\n${USAGE}\n`);
    return 2;
  }

  const resolved = await resolvePrompt(options);
  if (typeof resolved === "number") return resolved;
  options.prompt = resolved;

  configureShim({ root: options.cwd, settings: shimSettings(options) });
  // Imported after the shim is configured: these modules read the workspace
  // root at import time through the aliased `vscode` module.
  const { runAgent } = await import("../agent/loop.js");
  const resolveFallback = createFallbackResolver({
    models: options.fallbackModels,
    apiBaseUrl: options.baseUrl,
    apiKey: options.apiKey,
    anthropic: options.anthropic,
  });

  // No prompt on the command line means an interactive session.
  if (options.interactive) {
    const { runRepl } = await import("./repl.js");
    const { toolsForMode } = await import("../agent/tools/index.js");
    return runRepl(options, {
      runAgent: (o) =>
        runAgent({
          apiBaseUrl: options.baseUrl,
          apiKey: options.apiKey,
          anthropic: options.anthropic,
          maxSteps: options.maxSteps,
          extraInstructions: options.system || undefined,
          enableFileReading: true,
          enableTerminalSuggestions: true,
          enableWorkspaceContext: true,
          resolveFallback,
          ...o,
        } as Parameters<typeof runAgent>[0]),
      toolNamesFor: (mode) => toolsForMode(mode).map((t) => t.schema.function.name),
    });
  }

  // --json stays a faithful copy of the event stream; only the readable output
  // collapses the repeated tool-call upserts.
  const announced = new Set<string>();
  // The answer streams to stdout and status lines go to stderr; in a terminal
  // they share one screen, so a status line must not land mid-sentence.
  let midLine = false;
  const endLine = () => {
    if (!midLine) return;
    process.stdout.write("\n");
    midLine = false;
  };

  const writeEvent = (ev: AgentEvent) => {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(ev)}\n`);
      return;
    }
    if (ev.type === "text-delta") {
      process.stdout.write(ev.text);
      midLine = !ev.text.endsWith("\n");
      return;
    }
    if (options.quiet) return;
    const line = describe(ev, announced);
    if (!line) return;
    endLine();
    process.stderr.write(`${line}\n`);
  };

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let timedOut = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  if (options.timeout > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeout * 1000);
    timeoutTimer.unref();
  }

  let failed = false;
  let denied = 0;
  let finalText = "";
  let gotResult = false;
  try {
    const shot = await runWithRetries({
      retries: options.retry,
      signal: controller.signal,
      timedOut: () => timedOut,
      run: async () => {
        const attempt = {
          failed: false,
          denied: 0,
          finalText: "",
          gotResult: false,
          mutated: false,
          aborted: false,
          error: undefined as string | undefined,
        };
        announced.clear();
        try {
          await runAgent({
            apiBaseUrl: options.baseUrl,
            apiKey: options.apiKey,
            model: options.model,
            anthropic: options.anthropic,
            mode: options.mode,
            prompt: options.prompt,
            extraInstructions: options.system || undefined,
            history: [],
            maxSteps: options.maxSteps,
            enableFileReading: true,
            enableTerminalSuggestions: isExecutingMode(options.mode),
            enableWorkspaceContext: true,
            resolveFallback,
            // Nobody can answer a prompt here: --auto approves, otherwise refuse and
            // tell the model why, so it reports the blocker instead of looping.
            approve: async (toolName: string) => {
              if (options.auto) return true;
              attempt.denied++;
              return { approved: false as const, blockedSubject: `${toolName} (run with --auto to allow it)` };
            },
            signal: controller.signal,
            emit: (ev: AgentEvent) => {
              if (ev.type === "tool-call-started" && isUnsafeToRetryTool(ev.name)) {
                attempt.mutated = true;
              }
              if (ev.type === "error") {
                attempt.failed = true;
                attempt.error = ev.message;
              }
              if (ev.type === "run-status" && ev.status === "error") {
                attempt.failed = true;
                attempt.error ??= "run failed";
              }
              if (ev.type === "run-result") {
                attempt.finalText = ev.text;
                attempt.gotResult = true;
              }
              writeEvent(ev);
            },
          });
        } catch (error) {
          attempt.failed = true;
          attempt.error = error instanceof Error ? error.message : String(error);
          if (controller.signal.aborted) attempt.aborted = true;
          if (!options.json) {
            endLine();
            process.stderr.write(`x ${attempt.error}\n`);
          }
        }
        if (controller.signal.aborted) attempt.aborted = true;
        return attempt;
      },
      inspect: (attempt) => ({
        ok: !attempt.failed && attempt.gotResult,
        mutated: attempt.mutated,
        aborted: attempt.aborted,
        error: attempt.error,
      }),
      onRetry: ({ attempt, max, delayMs, error }) => {
        writeEvent({ type: "retry", attempt, max, delayMs, error });
      },
    });
    failed = shot.failed;
    denied = shot.denied;
    finalText = shot.finalText;
    gotResult = shot.gotResult;
  } catch (error) {
    process.stderr.write(`x ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (!options.json) endLine();
  }

  if (timedOut) {
    if (!options.quiet && !options.json) {
      process.stderr.write(`- timed out after ${options.timeout}s\n`);
    }
    failed = true;
  }

  if (options.output && !timedOut && gotResult) {
    const written = await writeTextFile(options.output, options.cwd, finalText);
    if (isIoError(written)) {
      process.stderr.write(`error: ${written.error}\n`);
      return 1;
    }
    if (!options.quiet && !options.json) {
      process.stderr.write(`- wrote ${written.path}\n`);
    }
  }

  if (denied && !options.quiet && !options.json) {
    process.stderr.write(`- ${denied} action(s) were blocked. Re-run with --auto to allow them.\n`);
  }
  return failed ? 1 : 0;
}

/**
 * Turn `--file` / `--stdin` / a positional prompt into the text the agent sees.
 * File and stdin failures are usage errors (exit 2): the run never starts.
 */
async function resolvePrompt(options: CliOptions): Promise<string | number> {
  const source = promptSource(options);
  if ("error" in source) {
    process.stderr.write(`error: ${source.error}\n\n${USAGE}\n`);
    return 2;
  }
  if (source.kind === "none") return "";
  const loaded = await loadPrompt(source, options.cwd);
  if (isIoError(loaded)) {
    process.stderr.write(`error: ${loaded.error}\n`);
    return 2;
  }
  return loaded.text;
}

/**
 * End the process without racing its own teardown.
 *
 * Calling `process.exit()` the instant the run resolves can land while a keep-
 * alive socket or child process handle is still closing, which aborts Node with
 * a libuv assertion instead of the exit code a CI job is waiting for. Setting
 * `exitCode` lets a clean drain win; the timer is the backstop for anything
 * still holding the loop open.
 */
function finish(code: number): void {
  process.exitCode = code;
  try {
    browserSession.dispose();
  } catch {
    // Nothing was opened, or it is already gone.
  }
  try {
    // An interactive session leaves stdin readable; releasing it lets the loop
    // drain instead of exiting on top of a handle that is still closing.
    process.stdin.pause();
  } catch {
    // stdin is not a stream we own.
  }
  // Unref'd on purpose: if nothing else holds the loop open, Node exits cleanly
  // on its own with the code above and this never fires. If something *is*
  // stuck, the loop is alive, so the timer still runs and forces the exit.
  setTimeout(() => process.exit(code), 2000).unref();
}

main()
  .then(finish)
  .catch((error) => {
    process.stderr.write(`x ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    finish(1);
  });
