/**
 * Search: the two full-text commands. One returns the files that matched, the other the matching
 * lines with their context.
 */
import { z } from "zod";

import { kv } from "../cli.js";
import { jsonRows } from "../structured.js";
import { defineTool } from "./registry.js";
import { totalParam } from "./params.js";

export const searchTools = [
  defineTool({
    name: "obsidian_search",
    title: "Search the vault",
    description:
      "Full-text search across the vault; returns the matching files, not the matching lines " +
      "(use obsidian_search_context for those). Supports structured filters inside the query " +
      'string, e.g. "[tag:project]", "[status:active]", "[priority:>3]".',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      query: z.string(),
      path: z
        .string()
        .optional()
        .describe(
          'Limit the search to one folder, e.g. "33.11 Notes". The cheapest way to cut the noise ' +
            "when you already know where the answer lives."
        ),
      // `search` is the only exposed command with a limit: `tags` and `tasks` have none.
      limit: z
        .number()
        .int()
        .positive()
        .default(50)
        .describe("Max files to return. Defaults to 50 -- raise it when you need more."),
      caseSensitive: z
        .boolean()
        .default(false)
        .describe("Match upper/lower case exactly. Off by default, as in Obsidian's own search."),
      json: z.boolean().default(true).describe("Return machine-readable JSON output."),
      total: totalParam,
    },
    command: "search",
    tier: "slow",
    tokens: ({ query, path, limit, caseSensitive, json, total }) =>
      kv({ query, path, limit, case: caseSensitive, format: json ? "json" : undefined, total }),
    output: {
      key: "results",
      schema: jsonRows,
      description:
        "The matching files, as the CLI's own JSON. Absent when the call asked for plain text " +
        "or for `total`, and when the output had to be truncated.",
      when: ({ json }) => json,
    },
  }),

  defineTool({
    name: "obsidian_search_context",
    title: "Search the vault with matching lines",
    description:
      "Full-text search that returns the matching lines themselves, with the text around them, " +
      "instead of just the file names. Prefer it over obsidian_search whenever you want to know " +
      "what a note says about something: it usually answers the question outright and saves " +
      "reading the notes one by one. Use plain obsidian_search when you only need the list of " +
      "files, or when the query would match too much to read. Same query syntax, including " +
      'filters like "[tag:project]". This command has no `total`: count with obsidian_search.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      query: z.string(),
      path: z.string().optional().describe('Limit the search to one folder, e.g. "33.11 Notes".'),
      limit: z
        .number()
        .int()
        .positive()
        .default(20)
        .describe(
          "Max files to return. Defaults to 20, lower than obsidian_search because each hit " +
            "brings its surrounding lines along."
        ),
      caseSensitive: z.boolean().default(false).describe("Match upper/lower case exactly."),
      json: z
        .boolean()
        .default(true)
        .describe("Return machine-readable JSON instead of the CLI's plain-text rendering."),
    },
    command: "search:context",
    tier: "slow",
    tokens: ({ query, path, limit, caseSensitive, json }) =>
      kv({ query, path, limit, case: caseSensitive, format: json ? "json" : undefined }),
    output: {
      key: "results",
      schema: jsonRows,
      description:
        "The matches with their surrounding lines, as the CLI's own JSON. Absent when the call " +
        "asked for plain text, and when the output had to be truncated.",
      when: ({ json }) => json,
    },
  }),
];
