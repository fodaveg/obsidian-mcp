/**
 * Daily notes.
 */
import { z } from "zod";

import { kv } from "../cli.js";
import { defineTool } from "./registry.js";

export const dailyTools = [
  defineTool({
    name: "obsidian_daily_read",
    title: "Read today's daily note",
    description: "Reads the content of today's daily note (or a specific date's).",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      date: z.string().optional().describe("ISO date, e.g. 2026-07-20. Defaults to today."),
    },
    command: "daily:read",
    tier: "quick",
    tokens: ({ date }) => kv({ date }),
  }),

  defineTool({
    name: "obsidian_daily_append",
    title: "Append to today's daily note",
    description: "Appends content to the end of today's daily note.",
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: { content: z.string() },
    writes: true,
    command: "daily:append",
    tokens: ({ content }) => kv({ content }),
  }),

  defineTool({
    name: "obsidian_daily_prepend",
    title: "Prepend to today's daily note",
    description: "Inserts content at the start of today's daily note.",
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: { content: z.string() },
    writes: true,
    command: "daily:prepend",
    tokens: ({ content }) => kv({ content }),
  }),
];
