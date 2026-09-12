/**
 * The escape hatch: run any Obsidian CLI command verbatim.
 *
 * It is the one tool whose command is not declared here, because the model chooses it -- which is
 * exactly why it is opt-in (see ENABLE_EXEC in index.ts).
 */
import { z } from "zod";

import { defineTool } from "./registry.js";

export const execTools = [
  defineTool({
    name: "obsidian_exec",
    title: "Run a raw Obsidian CLI command",
    description:
      "Runs `obsidian <args...>` directly against the Obsidian CLI (requires Obsidian to be open " +
      "with CLI support enabled). Use this for anything not covered by the dedicated tools below, e.g.:\n" +
      '  ["files", "folder=Projects"]\n' +
      '  ["folders", "folder=Projects"]\n' +
      '  ["links", "file=My Note"]\n' +
      '  ["unresolved"]\n' +
      '  ["orphans"]\n' +
      '  ["tags:rename", "old=meeting", "new=meetings"]\n' +
      '  ["plugin:enable", "id=dataview"]\n' +
      '  ["publish:list"]\n' +
      '  ["sync:status"]\n' +
      '  ["history", "file=My Note"]\n' +
      "Each element is one CLI token, exactly as you'd type it after `obsidian`: `key=value` for " +
      'parameters (e.g. "file=My Note", quotes not needed here) and the bare word for boolean ' +
      'options (e.g. "total", "verbose", "overwrite" -- never "--overwrite", which the CLI ignores). ' +
      "CAUTION: this also gives access to developer commands like eval=<js> and dev:* which can run " +
      "arbitrary JavaScript inside the user's Obsidian app or inspect its UI -- only use those when the " +
      "user explicitly asks for them. Set OBSIDIAN_MCP_DISABLE_EXEC=1 in the server's environment to " +
      "remove this tool entirely and keep only the curated tools below.",
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      args: z
        .array(z.string())
        .min(1)
        .describe('CLI tokens after "obsidian", e.g. ["read", "file=My Note"]'),
    },
    writes: true,
    // The command is whatever the model put first, and the rest of its tokens follow verbatim.
    command: ({ args }) => args[0],
    tokens: ({ args }) => args.slice(1),
    // No way to tell what an arbitrary command costs, so it gets the most generous timeout.
    tier: "slow",
  }),
];
