/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Prompt and answer I/O for the CLI.
 *
 * A CI job often has a prompt too long for argv (or one that must not appear
 * in `ps`) and wants the final answer as an artifact. These helpers are the
 * trust boundary for that: they reject empty/missing/oversized input, refuse
 * to treat a directory as a file, and never throw — callers get a result
 * object so every failure path can print one clear error and exit 2.
 */

import * as fs from "fs/promises";
import * as path from "path";

/** Hard cap so a redirected binary or a multi-GB dump cannot fill memory. */
export const MAX_PROMPT_BYTES = 1_000_000;

/**
 * Cap on an `--output --append` artifact. Overwrite stays uncapped so a single
 * large answer is not refused; a looping CI job must not be able to fill a disk.
 */
export const MAX_OUTPUT_BYTES = 5_000_000;

/** Inserted between successive `--output --append` answers. */
export const OUTPUT_APPEND_SEPARATOR = "\n---\n\n";

export type WriteTextOptions = {
  /** Add to the file instead of replacing it. Creates the file when missing. */
  append?: boolean;
};

export type IoErr = { error: string };
export type IoResult<T> = (T & { error?: undefined }) | IoErr;

export function isIoError<T>(r: IoResult<T>): r is IoErr {
  return typeof (r as IoErr).error === "string";
}

export type PromptSource =
  | { kind: "text"; text: string }
  | { kind: "file"; path: string }
  | { kind: "stdin" }
  | { kind: "none" };

/**
 * Decide where the prompt comes from. More than one source is an error —
 * silently concatenating a flag and a positional argument hides mistakes.
 */
export function promptSource(opts: { prompt: string; file: string; stdin: boolean }): PromptSource | IoErr {
  const sources = [
    opts.prompt ? "prompt" : "",
    opts.file ? "file" : "",
    opts.stdin ? "stdin" : "",
  ].filter(Boolean);
  if (sources.length > 1) {
    return { error: "pass a prompt, --file, or --stdin — not more than one" };
  }
  if (opts.file) return { kind: "file", path: opts.file };
  if (opts.stdin) return { kind: "stdin" };
  if (opts.prompt) return { kind: "text", text: opts.prompt };
  return { kind: "none" };
}

export async function loadPrompt(
  source: PromptSource,
  cwd: string,
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<IoResult<{ text: string }>> {
  if (source.kind === "none") return { error: "a prompt is required" };
  if (source.kind === "text") return { text: source.text };
  if (source.kind === "file") return readTextFile(source.path, cwd, "prompt file");
  return readStdin(stdin);
}

/** Read a UTF-8 text file relative to `cwd`. */
export async function readTextFile(
  filePath: string,
  cwd: string,
  label = "file",
  maxBytes = MAX_PROMPT_BYTES,
): Promise<IoResult<{ text: string; path: string }>> {
  if (!filePath.trim()) return { error: `${label} path is empty` };
  const resolved = path.resolve(cwd, filePath);
  let st;
  try {
    st = await fs.stat(resolved);
  } catch {
    return { error: `${label} not found: ${filePath}` };
  }
  if (st.isDirectory()) return { error: `${label} is a directory: ${filePath}` };
  if (st.size === 0) return { error: `${label} is empty: ${filePath}` };
  if (st.size > maxBytes) return { error: `${label} exceeds ${maxBytes} bytes: ${filePath}` };
  let text: string;
  try {
    text = await fs.readFile(resolved, "utf8");
  } catch (e) {
    return { error: `could not read ${label} ${filePath}: ${e instanceof Error ? e.message : String(e)}` };
  }
  text = text.replace(/^\uFEFF/, "").trim();
  if (!text) return { error: `${label} is empty: ${filePath}` };
  return { text, path: resolved };
}

/** Drain a stream up to `maxBytes` and return the trimmed UTF-8 text. */
export function readStdin(
  stream: NodeJS.ReadableStream,
  maxBytes = MAX_PROMPT_BYTES,
): Promise<IoResult<{ text: string }>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (r: IoResult<{ text: string }>) => {
      if (settled) return;
      settled = true;
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      resolve(r);
    };
    const onData = (c: Buffer | string) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      size += buf.length;
      if (size > maxBytes) {
        done({ error: `stdin exceeds ${maxBytes} bytes` });
        if (typeof (stream as NodeJS.ReadStream).destroy === "function") {
          (stream as NodeJS.ReadStream).destroy();
        }
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => {
      const text = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "").trim();
      if (!text) done({ error: "stdin was empty" });
      else done({ text });
    };
    const onError = (e: Error) => done({ error: e.message || "failed to read stdin" });
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    if (typeof stream.resume === "function") stream.resume();
  });
}

/** Bytes to add when appending `content` onto an existing file of `existingSize`. */
export function appendChunk(existingSize: number, endsWithNewline: boolean, content: string): string {
  if (existingSize <= 0) return content;
  const lead = endsWithNewline ? "" : "\n";
  return `${lead}${OUTPUT_APPEND_SEPARATOR}${content}`;
}

async function fileEndsWithNewline(resolved: string, size: number): Promise<boolean> {
  if (size <= 0) return true;
  const fh = await fs.open(resolved, "r");
  try {
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    await fh.close();
  }
}

/** Write UTF-8 text, creating parent directories. Refuses to overwrite a directory. */
export async function writeTextFile(
  filePath: string,
  cwd: string,
  content: string,
  opts: WriteTextOptions = {},
): Promise<IoResult<{ path: string }>> {
  if (!filePath.trim()) return { error: "output path is empty" };
  if (filePath.trim() === "-") {
    return { error: "output path cannot be '-' (the answer already streams to stdout)" };
  }
  const resolved = path.resolve(cwd, filePath);
  try {
    let st;
    try {
      st = await fs.stat(resolved);
    } catch {
      st = undefined;
    }
    if (st?.isDirectory()) return { error: `output path is a directory: ${filePath}` };
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    if (opts.append && st && st.size > 0) {
      if (st.size > MAX_OUTPUT_BYTES) {
        return { error: `output file exceeds ${MAX_OUTPUT_BYTES} bytes: ${filePath}` };
      }
      const chunk = appendChunk(st.size, await fileEndsWithNewline(resolved, st.size), content);
      const nextSize = st.size + Buffer.byteLength(chunk, "utf8");
      if (nextSize > MAX_OUTPUT_BYTES) {
        return { error: `output file exceeds ${MAX_OUTPUT_BYTES} bytes: ${filePath}` };
      }
      await fs.appendFile(resolved, chunk, "utf8");
    } else {
      await fs.writeFile(resolved, content, "utf8");
    }
    return { path: resolved };
  } catch (e) {
    return { error: `could not write ${filePath}: ${e instanceof Error ? e.message : String(e)}` };
  }
}
