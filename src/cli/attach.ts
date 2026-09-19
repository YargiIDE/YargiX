/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Files the user pins onto a CLI turn.
 *
 * The editor already sends attachments on the first user step; the terminal
 * had no equivalent, so a CI job that wanted the model to see `task.md` plus
 * two fixtures had to hope the agent would Read them. These helpers are the
 * trust boundary: missing, empty, oversized, binary, or directory paths fail
 * loudly instead of becoming a silent empty attach.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { Attachment } from "../agent/types";
import type { IoResult } from "./io";

export const MAX_ATTACHMENTS = 16;
export const MAX_ATTACH_TEXT_BYTES = 512_000;
export const MAX_ATTACH_IMAGE_BYTES = 2_000_000;
export const MAX_ATTACH_TOTAL_BYTES = 2_000_000;

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Split a `--attach` value. Commas separate paths; spaces stay in the name. */
export function splitPathList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Split a REPL `/attach` argument list (commas or whitespace). */
export function splitAttachArgs(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Repo rules from `--system-file`, then the one-off `--system` text. */
export function mergeSystem(fromFile: string, inline: string): string {
  const file = fromFile.trim();
  const extra = inline.trim();
  if (file && extra) return `${file}\n\n${extra}`;
  return file || extra;
}

export function describeAttachment(a: Attachment): string {
  return `${a.name} (${a.kind})`;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8_000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export async function loadAttachments(
  paths: string[],
  cwd: string,
  idPrefix = "att",
): Promise<IoResult<{ attachments: Attachment[] }>> {
  if (paths.length === 0) return { attachments: [] };
  if (paths.length > MAX_ATTACHMENTS) {
    return { error: `too many attachments (max ${MAX_ATTACHMENTS})` };
  }

  const attachments: Attachment[] = [];
  const seen = new Set<string>();
  let total = 0;

  for (let i = 0; i < paths.length; i++) {
    const filePath = paths[i];
    if (!filePath.trim()) return { error: "attach path is empty" };
    if (filePath.trim() === "-") {
      return { error: "attach path cannot be '-' (stdin is only for --file/--stdin)" };
    }

    const resolved = path.resolve(cwd, filePath);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    let st;
    try {
      st = await fs.stat(resolved);
    } catch {
      return { error: `attachment not found: ${filePath}` };
    }
    if (st.isDirectory()) return { error: `attachment is a directory: ${filePath}` };
    if (st.size === 0) return { error: `attachment is empty: ${filePath}` };

    const name = path.basename(resolved);
    const ext = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
    const imageMime = IMAGE_MIME[ext];
    const cap = imageMime ? MAX_ATTACH_IMAGE_BYTES : MAX_ATTACH_TEXT_BYTES;
    if (st.size > cap) return { error: `attachment exceeds ${cap} bytes: ${filePath}` };
    if (total + st.size > MAX_ATTACH_TOTAL_BYTES) {
      return { error: `attachments exceed ${MAX_ATTACH_TOTAL_BYTES} bytes in total` };
    }

    let buf: Buffer;
    try {
      buf = await fs.readFile(resolved);
    } catch (e) {
      return { error: `could not read attachment ${filePath}: ${e instanceof Error ? e.message : String(e)}` };
    }
    total += buf.length;

    if (imageMime) {
      attachments.push({
        id: `${idPrefix}_${i}`,
        name,
        mime: imageMime,
        data: `data:${imageMime};base64,${buf.toString("base64")}`,
        kind: "image",
      });
      continue;
    }

    if (looksBinary(buf)) return { error: `attachment is not a text file: ${filePath}` };
    const text = buf.toString("utf8").replace(/^\uFEFF/, "");
    if (!text.trim()) return { error: `attachment is empty: ${filePath}` };
    attachments.push({
      id: `${idPrefix}_${i}`,
      name,
      mime: "text/plain",
      data: text,
      kind: "text",
    });
  }

  return { attachments };
}
