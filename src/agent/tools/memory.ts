/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { defineTool } from "./types";
import {
  listMemories,
  readMemory,
  writeMemory,
  appendMemory,
  deleteMemory,
  MEMORY_DIR,
} from "../../context/memoryBank";

export const memoryTool = defineTool("Memory", true, async (input) => {
  const action = String(input?.action ?? "").trim().toLowerCase();
  const name = input?.name != null ? String(input.name) : "";

  try {
    switch (action) {
      case "list": {
        const notes = await listMemories();
        if (!notes.length) {
          return {
            output: `The memory bank is empty (${MEMORY_DIR.replace(/\\/g, "/")}/). Write a note when you learn something durable about this project.`,
          };
        }
        return { output: notes.map((n) => `${n.name} — ${n.path} (${n.bytes} bytes)`).join("\n") };
      }

      case "read": {
        if (!name) return { output: "error: read needs a `name`" };
        const body = await readMemory(name);
        return { output: body ?? `error: no memory note named "${name}"` };
      }

      case "write": {
        if (!name) return { output: "error: write needs a `name`" };
        const note = await writeMemory(name, String(input?.content ?? ""));
        return { output: `wrote ${note.path} (${note.bytes} bytes)` };
      }

      case "append": {
        if (!name) return { output: "error: append needs a `name`" };
        const note = await appendMemory(name, String(input?.content ?? ""));
        return { output: `appended to ${note.path} (now ${note.bytes} bytes)` };
      }

      case "delete": {
        if (!name) return { output: "error: delete needs a `name`" };
        const gone = await deleteMemory(name);
        return { output: gone ? `deleted memory note "${name}"` : `error: no memory note named "${name}"` };
      }

      default:
        return { output: `error: unknown action "${action}". Use list, read, write, append, or delete.` };
    }
  } catch (error) {
    return { output: `error: ${error instanceof Error ? error.message : String(error)}` };
  }
});
