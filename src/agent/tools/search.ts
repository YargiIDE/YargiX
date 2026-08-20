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
import { spawn } from "child_process";
import { safePath, getWorkspaceRoot } from "../../context/workspaceUtils";
import { defineTool } from "./types";
import { STOP, rgCommand } from "./shared";
import { scanFilesCached, compileGlob, normalizeGlobPattern } from "./fileScan";
import { BINARY_EXTS, isNoisePath, NOISE_GLOBS } from "./ignore";
import { search as semanticIndexSearch, buildIndex, isIndexing, isIndexingEnabled } from "../semanticIndex";
import { searchDocs, listDocSources } from "../docsIndex";

// Minimal ripgrep --type -> file-extension map for the node fallback.
const TYPE_EXTS: Record<string, string[]> = {
  js: [".js", ".jsx", ".mjs", ".cjs"],
  ts: [".ts", ".tsx", ".mts", ".cts"],
  py: [".py", ".pyi"],
  rust: [".rs"],
  go: [".go"],
  java: [".java"],
  c: [".c", ".h"],
  cpp: [".cpp", ".cc", ".cxx", ".hpp", ".hh"],
  cs: [".cs"],
  rb: [".rb"],
  php: [".php"],
  json: [".json"],
  md: [".md", ".markdown"],
  html: [".html", ".htm"],
  css: [".css", ".scss", ".sass"],
  sh: [".sh", ".bash"],
  yaml: [".yaml", ".yml"],
};

/** Trim very long lines (minified bundles) so one line cannot flood the output. */
function clip(line: string, max = 500): string {
  return line.length > max ? line.slice(0, max) + " …[truncated]" : line;
}

/** Count newlines without allocating a split array. */
function countLines(s: string): number {
  let n = 0;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) n++;
  return n;
}

// ---- Grep (ripgrep with a node fallback) ----
export const grepTool = defineTool("Grep", false, async (input, abortSignal) => {
  try {
  if (abortSignal?.aborted) return { output: "(grep aborted)" };
  const root = getWorkspaceRoot();
  const mode: string = input.output_mode || "content";
  let target = ".";
  if (input.path) {
    try {
      target = safePath(input.path); // spawn arg — spaces OK without shell quoting
    } catch (e) {
      return { output: `error: invalid path: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const cap = Math.max(1, Math.min(Number(input.head_limit) || 200, 2000));
  const skip = Math.max(0, Number(input.offset) || 0);
  const pattern = String(input.pattern ?? "");
  if (!pattern) return { output: "error: pattern is required" };

  // Validate the regex up front so a bad pattern fails fast with a clear
  // message instead of an opaque non-zero rg exit.
  try {
    new RegExp(pattern);
  } catch (e) {
    return { output: `error: invalid pattern: ${e instanceof Error ? e.message : String(e)}` };
  }

  const rgBin = await rgCommand();
  if (rgBin) {
    const args = [
      "--color=never",
      "--hidden",
      "--no-messages",
      // Emit forward slashes so output matches the node fallback and the paths
      // the model passes back to Read/StrReplace.
      "--path-separator", "/",
      "--glob", "!**/.git/**",
      "--glob", "!**/node_modules/**",
      // Bound worst-case cost on generated/vendored blobs.
      "--max-filesize", "8M",
      "--max-columns", "500",
      "--max-columns-preview",
    ];
    // Keep both backends in agreement about what counts as searchable code.
    for (const g of NOISE_GLOBS) args.push("--glob", `!${g}`);
    if (mode === "files_with_matches") {
      args.push("--files-with-matches");
    } else if (mode === "count") {
      args.push("--count");
    } else {
      args.push("--line-number", "--no-heading", "--with-filename");
      const ctxA = input["-A"] ?? input["-C"];
      const ctxB = input["-B"] ?? input["-C"];
      if (ctxA != null) args.push("-A", String(Math.max(0, Math.min(Number(ctxA) || 0, 50))));
      if (ctxB != null) args.push("-B", String(Math.max(0, Math.min(Number(ctxB) || 0, 50))));
    }
    if (input["-i"]) args.push("-i");
    if (input.multiline) args.push("-U", "--multiline-dotall");
    if (input.glob) args.push("--glob", String(input.glob));
    if (input.type) args.push("--type", String(input.type));
    // Paginated calls must see a stable order; --sort=path costs parallelism,
    // so only pay for it when the caller is actually paging through results.
    if (skip > 0) args.push("--sort=path");
    args.push("--regexp", pattern, "--", target);

    const out = await new Promise<string>((res) => {
      let settled = false;
      let o = "";
      let c: ReturnType<typeof spawn>;
      const finish = (v: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { abortSignal?.removeEventListener("abort", onAbort); } catch { /* ignore */ }
        res(v);
      };
      const onAbort = () => {
        try { c.kill("SIGTERM"); } catch { /* ignore */ }
        finish(o ? o.slice(0, 12_000) + "\n(grep aborted)" : "(grep aborted)");
      };
      // Hard kill hung rg even if AbortSignal is missing/ignored.
      const timer = setTimeout(() => {
        try { c.kill("SIGKILL"); } catch {
          try { c.kill("SIGTERM"); } catch { /* ignore */ }
        }
        finish(o ? o.slice(0, 12_000) + "\n(grep timed out)" : "(grep timed out)");
      }, 15_000);
      try {
        c = spawn(rgBin, args, { cwd: root, windowsHide: true });
      } catch (e) {
        finish(`(grep failed: ${e instanceof Error ? e.message : String(e)})`);
        return;
      }
      if (abortSignal?.aborted) {
        onAbort();
        return;
      }
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      let flooded = false;
      c.stdout?.on("data", (d) => {
        o += d;
        // Stop early once we clearly have more than the caller can consume,
        // instead of buffering an entire repo-wide match set.
        if (!flooded && (o.length > 4_000_000 || countLines(o) > skip + cap + 1_000)) {
          flooded = true;
          try { c.kill("SIGTERM"); } catch { /* ignore */ }
        }
      });
      let stderr = "";
      c.stderr?.on("data", (d) => { if (stderr.length < 2_000) stderr += d; });
      c.on("error", (e) => finish(`(grep failed: ${e instanceof Error ? e.message : String(e)})`));
      c.on("close", (code) => {
        // rg prefixes results with "./" when searching the cwd; strip it so the
        // model gets plain workspace-relative paths it can feed back to Read.
        const all = o.split("\n").filter(Boolean).map((l) => (l.startsWith("./") ? l.slice(2) : l));
        // rg exits 1 for "no matches" and >1 for real errors.
        if (!all.length && code != null && code > 1 && stderr.trim()) {
          finish(`error: ripgrep failed: ${stderr.trim().split("\n")[0]}`);
          return;
        }
        const lines = skip ? all.slice(skip) : all;
        const shown = lines.slice(0, cap);
        if (!shown.length) return finish("(no matches)");
        const rest = lines.length - shown.length;
        const note = rest > 0 || flooded ? `\n… (at least ${lines.length + (flooded ? 1 : 0)} results${flooded ? "+" : ""}, truncated — refine the pattern, glob, or use head_limit/offset)` : "";
        finish(shown.join("\n") + note);
      });
    });
    return { output: out };
  }

  // Node fallback (no ripgrep available). Honor path/glob/type/-A/-B/-C/multiline.
  let scopeRoot = root;
  if (input.path) {
    try {
      scopeRoot = safePath(input.path);
    } catch (e) {
      return { output: `error: invalid path: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  let lineRe: RegExp;
  let multiRe: RegExp | null = null;
  try {
    const flags = input["-i"] ? "i" : "";
    lineRe = new RegExp(pattern, flags);
    multiRe = input.multiline ? new RegExp(pattern, flags + "s") : null;
  } catch (e) {
    return { output: `error: invalid pattern: ${e instanceof Error ? e.message : String(e)}` };
  }
  const glob = input.glob ? compileGlob(normalizeGlobPattern(String(input.glob))) : null;
  const typeExts = input.type ? TYPE_EXTS[String(input.type)] : null;
  const aCtx = Math.max(0, Math.min(Number(input["-A"] ?? input["-C"] ?? 0), 50));
  const bCtx = Math.max(0, Math.min(Number(input["-B"] ?? input["-C"] ?? 0), 50));

  const { files: scanned, truncated: scanTruncated } = await scanFilesCached(scopeRoot, {
    signal: abortSignal,
    maxFiles: 40_000,
    timeMs: 10_000,
  });
  if (abortSignal?.aborted) return { output: "(grep aborted)" };

  // Cheap metadata filters first — avoids opening files we can never match.
  const candidates = scanned.filter((f) => {
    const rel = path.relative(root, f.abs).split(path.sep).join("/");
    if (glob && !glob.test(rel)) return false;
    if (typeExts && !typeExts.includes(path.extname(f.abs).toLowerCase())) return false;
    if (BINARY_EXTS.has(path.extname(f.abs).toLowerCase())) return false;
    if (isNoisePath(rel)) return false;
    if (f.size > 4_000_000 || f.size === 0) return false;
    return true;
  });
  // Deterministic order so head_limit/offset paginate consistently.
  candidates.sort((a, b) => a.rel.localeCompare(b.rel));

  const hitsByFile: Record<string, string[]> = {};
  const countByFile: Record<string, number> = {};
  const order: string[] = [];
  let filesTruncated = candidates.length > 20_000;

  // Read files concurrently; regex matching stays on the main thread but I/O
  // no longer serializes, which was the dominant cost in the old fallback.
  const CONCURRENCY = 16;
  const list = candidates.slice(0, 20_000);
  let cursor = 0;
  let stopped = false;

  const processFile = async (f: (typeof list)[number]): Promise<void> => {
    const rel = path.relative(root, f.abs).split(path.sep).join("/");
    let txt: string;
    try {
      const buf = await fs.readFile(f.abs);
      // NUL byte in the head => binary; skip like ripgrep does.
      const probe = buf.subarray(0, Math.min(buf.length, 8192));
      if (probe.includes(0)) return;
      txt = buf.toString("utf8");
    } catch {
      return; // unreadable
    }
    // Register the file as a match exactly once, regardless of output mode.
    const mark = () => {
      if (!hitsByFile[rel]) {
        hitsByFile[rel] = [];
        order.push(rel);
        countByFile[rel] = 0;
      }
    };
    const push = (line: string) => {
      mark();
      hitsByFile[rel].push(line);
    };
    if (multiRe) {
      if (multiRe.test(txt)) {
        mark();
        countByFile[rel]++;
        if (mode === "content") push(`${rel}:${clip(txt.replace(/\n/g, "\\n"))}`);
      }
      return;
    }

    // files_with_matches only needs to know whether ANY line matches.
    if (mode === "files_with_matches") {
      lineRe.lastIndex = 0;
      if (lineRe.test(txt)) {
        mark();
        countByFile[rel]++;
      }
      return;
    }

    const lines = txt.split("\n");
    for (let idx = 0; idx < lines.length; idx++) {
      const l = lines[idx];
      if (!lineRe.test(l)) continue;
      mark();
      countByFile[rel]++;
      if (mode !== "content") continue; // count mode: tally only
      for (let b = bCtx; b >= 1; b--) {
        if (idx - b >= 0) push(`${rel}-${idx + 1 - b}-${clip(lines[idx - b])}`);
      }
      push(`${rel}:${idx + 1}:${clip(l)}`);
      for (let a = 1; a <= aCtx; a++) {
        if (idx + a < lines.length) push(`${rel}-${idx + 1 + a}-${clip(lines[idx + a])}`);
      }
    }
  };

  const totalHits = (): number => {
    if (mode === "content") {
      let n = 0;
      for (const f of order) n += hitsByFile[f].length;
      return n;
    }
    return order.length;
  };

  const worker = async (): Promise<void> => {
    while (cursor < list.length && !stopped) {
      if (abortSignal?.aborted) {
        stopped = true;
        return;
      }
      const f = list[cursor++];
      await processFile(f);
      // Enough material to satisfy the request — stop scanning the rest.
      if (order.length > 0 && totalHits() > skip + cap + 500) {
        stopped = true;
        filesTruncated = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
  if (abortSignal?.aborted) return { output: "(grep aborted)" };

  order.sort((a, b) => a.localeCompare(b));
  let result: string[];
  if (mode === "files_with_matches") result = order;
  else if (mode === "count") result = order.map((f) => `${f}:${countByFile[f]}`);
  else result = order.flatMap((f) => hitsByFile[f]);
  if (skip) result = result.slice(skip);
  const truncated = result.length > cap || filesTruncated || scanTruncated;
  const shown = result.slice(0, cap);
  if (!shown.length) {
    return { output: truncated ? "(no matches in the scanned subset — search was truncated)" : "(no matches)" };
  }
  const note = truncated
    ? `\n… (at least ${result.length} results, truncated — refine the pattern, glob, or use head_limit/offset)`
    : "";
  return { output: shown.join("\n") + note };
  } catch (e) {
    return { output: `error: Grep failed: ${e instanceof Error ? e.message : String(e)}` };
  }
});

// ---- SemanticSearch ----
// Real local semantic search: embed the query and cosine-rank against the
// on-disk embedding index (see semanticIndex.ts). Falls back to keyword
// OR-grep when the index/embedder is unavailable (no model yet, etc.).
function keywordFallback(input: any, abortSignal?: AbortSignal, callId?: string, ctx?: any) {
  const words = String(input.query || "")
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w))
    .slice(0, 6);
  if (!words.length) return Promise.resolve({ output: "(no searchable terms)" });
  const dirs: string[] = Array.isArray(input.target_directories) ? input.target_directories : [];
  const scope = dirs.length === 1 ? String(dirs[0]) : undefined;
  return grepTool.execute({ pattern: words.join("|"), "-i": true, path: scope }, abortSignal, callId, ctx);
}

const AUTO_BUILD_MIN_INTERVAL_MS = 5 * 60_000;
let lastAutoBuild = 0;

export const semanticSearchTool = defineTool("SemanticSearch", false, async (input, abortSignal, callId, ctx) => {
  try {
  if (abortSignal?.aborted) return { output: "(search aborted)" };
  const query = String(input.query || "").trim();
  if (!query) return { output: "(no query)" };
  const root = getWorkspaceRoot();

  // Build/refresh index on demand (incremental; cheap if already fresh).
  // Never await a full rebuild here — that hung explore tools for minutes.
  // Throttled: the watcher already keeps the index current, so a full workspace
  // scan on every single SemanticSearch call is pure overhead.
  if (isIndexingEnabled() && !isIndexing() && Date.now() - lastAutoBuild > AUTO_BUILD_MIN_INTERVAL_MS) {
    lastAutoBuild = Date.now();
    void buildIndex(root).catch(() => {});
  }

  // Scope by target_directories (prefix match on workspace-relative paths).
  const dirs: string[] = Array.isArray(input.target_directories) ? input.target_directories : [];
  const prefixes = dirs
    .map((d) => {
      try {
        return path.relative(root, safePath(String(d))).split(path.sep).join("/");
      } catch {
        return "";
      }
    })
    .filter((p) => p && !p.startsWith(".."));
  const filter = prefixes.length
    ? (rel: string) => prefixes.some((p) => rel === p || rel.startsWith(p + "/"))
    : undefined;

  let hits: Awaited<ReturnType<typeof semanticIndexSearch>> = [];
  try {
    hits = await semanticIndexSearch(root, query, 8, filter);
  } catch {
    hits = [];
  }
  if (!hits.length) return keywordFallback(input, abortSignal, callId, ctx);

  // Cap each chunk so a few large hits don't blow the context budget.
  const snip = (t: string) => (t.length > 1200 ? t.slice(0, 1200) + "\n... (trimmed - Read the file for full context)" : t);
  const out = hits
    .map((h) => `${h.path}:${h.start}-${h.end} (${h.score.toFixed(2)})\n${snip(h.text)}`)
    .join("\n\n---\n\n");
  return { output: out };
  } catch (e) {
    return { output: `error: SemanticSearch failed: ${e instanceof Error ? e.message : String(e)}` };
  }
});

// ---- SearchDocs (user-indexed external documentation) ----
export const searchDocsTool = defineTool("SearchDocs", false, async (input) => {
  try {
  const query = String(input.query || "").trim();
  if (!query) return { output: "(no query)" };
  const k = Math.max(1, Math.min(Number(input.num_results) || 6, 12));
  const sources = listDocSources().filter((d) => (d.pages ?? 0) > 0);
  if (!sources.length) return { output: "(no indexed doc sources - add them in Settings > Indexing & Docs)" };

  const want = String(input.doc || "").trim().toLowerCase();
  const targets = want
    ? sources.filter((d) => d.id.toLowerCase() === want || d.name.toLowerCase() === want)
    : sources;
  if (!targets.length) {
    return { output: `(no indexed doc source matching "${input.doc}". Available: ${sources.map((d) => d.name).join(", ")})` };
  }

  const all: { doc: string; url: string; title: string; text: string; score: number }[] = [];
  for (const d of targets) {
    const hits = await searchDocs(d.id, query, k).catch(() => []);
    for (const h of hits) all.push({ doc: d.name, ...h });
  }
  all.sort((a, b) => b.score - a.score);
  const top = all.slice(0, k);
  if (!top.length) return { output: "(no matching excerpts)" };
  const snip = (t: string) => (t.length > 1200 ? t.slice(0, 1200) + "\n... (trimmed)" : t);
  return {
    output: top
      .map((h) => `[${h.doc}] ${h.title} - ${h.url} (${h.score.toFixed(2)})\n${snip(h.text)}`)
      .join("\n\n---\n\n"),
  };
  } catch (e) {
    return { output: `error: SearchDocs failed: ${e instanceof Error ? e.message : String(e)}` };
  }
});
