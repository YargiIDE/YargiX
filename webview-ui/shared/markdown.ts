/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { Marked } from "marked";

// GFM markdown (tables, task lists, fenced code, etc.). marked passes raw HTML
// through, so we sanitize the output before injecting into the webview.
const marked = new Marked({ gfm: true, breaks: true });

// Drop dangerous nodes/attributes. AI output is semi-trusted; the webview CSP
// also blocks inline scripts, but defence in depth is cheap here.
function sanitize(html: string): string {
  return html
    .replace(/<\/?(script|style|iframe|object|embed|link|meta|base)\b[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
}

// Parsing + sanitizing is the single most expensive thing the webview does per
// frame: during streaming the same message is re-rendered on every delta, each
// time re-parsing the ENTIRE text from scratch (quadratic in message length).
// A small LRU keyed on the exact source makes repeat renders free, which covers
// both React re-renders that didn't change the text and scrollback redraws.
const CACHE_LIMIT = 240;
const cache = new Map<string, string>();

function cached(src: string, compute: () => string): string {
  const hit = cache.get(src);
  if (hit !== undefined) {
    // Refresh recency (Map preserves insertion order).
    cache.delete(src);
    cache.set(src, hit);
    return hit;
  }
  const html = compute();
  cache.set(src, html);
  if (cache.size > CACHE_LIMIT) {
    // Evict oldest.
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return html;
}

export function renderMarkdown(srcIn: string): string {
  const src = String(srcIn == null ? "" : srcIn);
  if (!src) return "";
  return cached(src, () => {
    try {
      return sanitize(marked.parse(src, { async: false }) as string);
    } catch {
      // Fallback: render as escaped plain text on parser failure.
      return "<p>" + src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</p>";
    }
  });
}

export function basename(p: string): string {
  if (!p) return "";
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
