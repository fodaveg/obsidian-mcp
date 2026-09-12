/**
 * Sync and version history.
 *
 * Reading history is exposed; restoring it is not. `history:restore` and `sync:restore`
 * overwrite a note (or a whole vault) with an older copy, which is the one operation here
 * that can destroy work the user never asked to touch. They stay behind obsidian_exec.
 */
import { z } from "zod";

import { kv } from "../cli.js";
import { defineTool } from "./registry.js";
import { fileParam, pathParam } from "./params.js";

export const historyTools = [
  defineTool({
    name: "obsidian_sync_status",
    title: "Show sync status",
    description:
      "Reports whether Obsidian Sync is connected and up to date. Worth checking before trusting " +
      "that what you just read is the latest version, and before telling the user a change of " +
      "yours has reached their other devices.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {},
    command: "sync:status",
    tier: "quick",
  }),

  defineTool({
    name: "obsidian_history",
    title: "List a note's versions",
    description:
      "Lists the stored versions of a note (Obsidian's file recovery / Sync history), newest " +
      "first, with the version numbers obsidian_history_read takes. Use it to answer \"when did " +
      "this note change?\" or to find the state a note was in before an edit.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { file: fileParam, path: pathParam },
    requireTarget: true,
    command: "history",
    tier: "quick",
    tokens: ({ file, path }) => kv({ file, path }),
  }),

  defineTool({
    name: "obsidian_history_read",
    title: "Read an old version of a note",
    description:
      "Returns the contents of one stored version of a note, as listed by obsidian_history. " +
      "Reading only: nothing here writes the old text back. To actually restore a version, tell " +
      "the user to use Obsidian's own version history, which shows them a diff before they commit " +
      "to it.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      file: fileParam,
      path: pathParam,
      version: z
        .number()
        .int()
        .positive()
        .default(1)
        .describe("Version number from obsidian_history. Defaults to 1, the most recent one."),
    },
    requireTarget: true,
    command: "history:read",
    tier: "quick",
    tokens: ({ file, path, version }) => kv({ file, path, version }),
  }),
];
