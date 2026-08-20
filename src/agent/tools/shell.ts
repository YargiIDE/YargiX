/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { safePath, getWorkspaceRoot } from "../../context/workspaceUtils";
import { defineTool } from "./types";
import {
  bgShells,
  nextShellId,
  waitForShell,
  renderShell,
  pushShellOutput,
  getShellSession,
  spawnShellCommand,
  killShellProcess,
  applyCwdSideEffect,
  type BgShell,
  type ShellNotify,
} from "./shared";
/** Default foreground wait for simple commands; hard max keeps the loop responsive. */
const DEFAULT_BLOCK_MS = 30_000;

const MAX_BLOCK_MS = 30_000;
const MAX_AWAIT_MS = 45_000;
/** Absolute hard wall even if block_until_ms is large / tool timeout is higher. */
const SHELL_HARD_WALL_MS = 45_000;

/** Build a notify_on_output config from the tool input, if present. */
function buildNotify(input: any, ctx: any): ShellNotify | undefined {
  const cfg = input?.notify_on_output;
  if (!cfg || !cfg.pattern) return undefined;
  let re: RegExp;
  try {
    re = new RegExp(String(cfg.pattern));
  } catch {
    return undefined;
  }
  return {
    re,
    reason: String(cfg.reason ?? "output"),
    debounceMs: Math.max(5000, Number(cfg.debounce_ms) || 0),
    lastNotified: 0,
    emit: ctx?.emitShellNotify,
  };
}

/**
 * Stream the rendered card to the UI while the command runs, throttled so a
 * chatty build can't flood the webview.
 */
function makeLiveStream(sh: BgShell, callId: string | undefined, ctx: any): (() => void) | undefined {
  const emit = ctx?.emitToolProgress;
  if (!emit || !callId) return undefined;
  let last = 0;
  let timer: NodeJS.Timeout | undefined;
  const send = () => {
    last = Date.now();
    timer = undefined;
    try { emit(callId, renderShell(sh)); } catch { /* ignore */ }
  };
  return () => {
    if (timer) return;
    const wait = Math.max(0, 120 - (Date.now() - last));
    timer = setTimeout(send, wait);
    timer.unref?.();
  };
}

// ---- Shell (stateful session; backgrounds a command past block_until_ms) ----
export const runTerminalTool = defineTool("Shell", true, async (input, abortSignal, callId, ctx) => {
  const root = getWorkspaceRoot();
  const requestedBlock = Number(input.block_until_ms);
  const rawBlock = Number.isFinite(requestedBlock) ? requestedBlock : DEFAULT_BLOCK_MS;
  const blockMs = rawBlock <= 0 ? 0 : Math.min(Math.max(0, rawBlock), MAX_BLOCK_MS);
  const command = String(input.command ?? "").trim();
  if (!command) return { output: "error: command is required" };

  // Prune finished shells older than 10 minutes to bound the registry.
  for (const [k, v] of bgShells) {
    if (v.done && Date.now() - v.startedAt > 600_000) bgShells.delete(k);
  }

  const sessionKey = (ctx as any)?.shellSessionKey ?? "default";
  const session = getShellSession(sessionKey, root);

  // Serialize foreground commands per run so their output can't interleave.
  // Always settle the queue slot even if this command errors/times out.
  let releaseQueue!: () => void;
  const prev = session.queue.catch(() => {});
  session.queue = new Promise<void>((r) => {
    releaseQueue = r;
  });
  await Promise.race([
    prev,
    new Promise<void>((resolve) => {
      setTimeout(resolve, MAX_BLOCK_MS + 5_000).unref?.();
    }),
  ]);

  let cwd = session.cwd || root;
  if (input.working_directory) {
    try {
      cwd = safePath(String(input.working_directory));
    } catch (e) {
      releaseQueue();
      return {
        output: `error: invalid working_directory: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  const sh: BgShell = {
    id: nextShellId(),
    command,
    output: "",
    done: false,
    exitCode: null,
    startedAt: Date.now(),
    status: "running",
    cwd,
    notify: buildNotify(input, ctx),
  };
  bgShells.set(sh.id, sh);
  const live = makeLiveStream(sh, callId, ctx);
  if (live) sh.onChunk = () => live();

  /** Single place that settles a command so status/exit/timing stay consistent. */
  const settle = (status: BgShell["status"], code: number | null, note?: string) => {
    if (sh.done) return;
    if (note) sh.output += `\n${note}`;
    sh.exitCode = code;
    sh.status = status;
    sh.done = true;
    sh.endedAt = Date.now();
    live?.();
  };

  // Spawn the command verbatim in its own shell: it owns its exit code and the
  // shell dies with it, so there is nothing left to wait on once it finishes.
  let proc: ReturnType<typeof spawnShellCommand>;
  try {
    proc = spawnShellCommand(command, cwd);
  } catch (e) {
    releaseQueue();
    settle("failed", 1);
    return { output: `error: failed to start shell: ${e instanceof Error ? e.message : String(e)}` };
  }
  sh.proc = proc;
  session.running.add(proc);

  const kill = () => killShellProcess(proc);
  const onAbort = () => {
    settle("aborted", sh.exitCode ?? 130, "(aborted)");
    kill();
  };
  abortSignal?.addEventListener("abort", onAbort);

  const onData = (d: Buffer | string) => {
    try { pushShellOutput(sh, d.toString()); } catch { /* ignore */ }
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  proc.on("error", (error) => {
    settle("failed", sh.exitCode ?? 1, `(failed to run command: ${error.message})`);
  });
  // 'close' (not 'exit') so all stdio has been flushed before we settle.
  proc.on("close", (code, signal) => {
    session.running.delete(proc);
    if (signal) sh.signal = String(signal);
    const exit = code ?? (signal ? 143 : 0);
    if (sh.status === "aborted" || sh.done) {
      sh.exitCode = sh.exitCode ?? exit;
      return;
    }
    settle(exit === 0 ? "completed" : "failed", exit);
  });
  // Output is pushed by the stream listeners; pump only refreshes timing.
  sh.pump = () => { /* event-driven; nothing to pull */ };

  const waitMs = blockMs <= 0 ? 0 : Math.min(blockMs, SHELL_HARD_WALL_MS);
  try {
    await waitForShell(sh, waitMs, undefined, abortSignal);

    if (abortSignal?.aborted && !sh.done) {
      settle("aborted", sh.exitCode ?? 130, "(aborted / timed out)");
      kill();
    } else if (!sh.done) {
      // Foreground expiry is not a failure: the command keeps running and stays
      // observable through AwaitShell (dev servers, watchers, long builds).
      sh.status = "backgrounded";
      live?.();
      setTimeout(() => {
        if (!sh.done) {
          settle("timeout", sh.exitCode ?? 124, "(background limit reached after 10m — command killed)");
          kill();
        }
      }, 600_000).unref?.();
    } else if (sh.status === "completed") {
      // Only a clean `cd` moves the run's working directory.
      applyCwdSideEffect(session, command);
    }

    return { output: renderShell(sh) };
  } catch (e) {
    settle("failed", 1, `(error: ${e instanceof Error ? e.message : String(e)})`);
    kill();
    return { output: renderShell(sh) };
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
    releaseQueue();
  }
});

// ---- AwaitShell (poll a backgrounded shell, or just sleep) ----
export const awaitShellTool = defineTool("AwaitShell", false, async (input, abortSignal, callId, ctx) => {
  const requestedBlock = Number(input?.block_until_ms);
  const raw = Number.isFinite(requestedBlock) ? requestedBlock : 15_000;
  const blockMs = raw <= 0 ? 0 : Math.min(raw, MAX_AWAIT_MS);
  const id = input?.shell_id ? String(input.shell_id) : "";

  if (!id) {
    if (blockMs <= 0) return { output: "error: shell_id is required when block_until_ms is 0" };
    const startedAt = Date.now();
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        abortSignal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => finish();
      const timer = setTimeout(finish, blockMs);
      if (abortSignal?.aborted) finish();
      else abortSignal?.addEventListener("abort", onAbort, { once: true });
    });
    if (abortSignal?.aborted) return { output: `Sleep aborted after ${Date.now() - startedAt}ms.` };
    return { output: `Slept for ${blockMs}ms.` };
  }

  const sh = bgShells.get(id);
  if (!sh) {
    if (/^toolu_|^call_/i.test(id)) {
      return {
        output: `error: "${id}" looks like a subagent/Task call id, not a background shell. Subagents are not shells — do not poll them with AwaitShell.`,
      };
    }
    return { output: `error: no background shell with id ${id}` };
  }

  let pattern: RegExp | undefined;
  if (input?.pattern) {
    try {
      pattern = new RegExp(String(input.pattern), "m");
    } catch (e) {
      return { output: `error: invalid pattern: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  const prevChunk = sh.onChunk;
  const live = makeLiveStream(sh, callId, ctx);
  if (live) {
    sh.onChunk = (chunk) => {
      try { prevChunk?.(chunk); } catch { /* ignore */ }
      live();
    };
  }
  try {
    await waitForShell(sh, blockMs, pattern, abortSignal);
    try {
      sh.pump?.();
    } catch {
      /* ignore */
    }
    return { output: renderShell(sh) };
  } catch (e) {
    return {
      output: `error: AwaitShell failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    sh.onChunk = prevChunk;
  }
});
