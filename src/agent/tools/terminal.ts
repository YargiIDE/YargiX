/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { defineTool } from "./types";
import { recentExecutions, formatExecutions, isEmpty } from "../../integrations/terminalCapture";

/**
 * Read-only view of the user's own terminal activity. Pairs with the Shell tool:
 * Shell runs new commands, ReadTerminal observes the ones the user already ran.
 */
export const readTerminalTool = defineTool("ReadTerminal", false, async (input) => {
  const runs = recentExecutions({
    terminal: input?.terminal ? String(input.terminal) : undefined,
    onlyFailed: input?.only_failed === true,
    limit: typeof input?.limit === "number" ? input.limit : undefined,
  });

  if (!runs.length) {
    // Distinguish "nothing captured at all" from "nothing matched the filter" so
    // the model doesn't conclude the user ran no commands.
    return {
      output: isEmpty()
        ? "No terminal activity captured. Commands run before this session started, or in terminals without shell integration, are not visible. Ask the user to paste the output, or run the command yourself with the Shell tool."
        : "No captured commands matched that filter.",
    };
  }

  return { output: formatExecutions(runs) };
});
