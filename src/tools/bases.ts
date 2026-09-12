/**
 * Bases: Obsidian's database views over note properties.
 */
import { z } from "zod";

import { kv } from "../cli.js";
import { defineTool } from "./registry.js";
import { fileParam, pathParam } from "./params.js";

export const baseTools = [
  defineTool({
    name: "obsidian_bases",
    title: "List the vault's bases",
    description:
      "Lists the base files (.base) in the vault. A base is a saved, filtered table over note " +
      "properties, so it is the structured half of the vault: whatever the user curates there is " +
      "already scoped and sorted, and querying it beats rebuilding the same list with a search. " +
      "Start here to find out which bases exist, then query one with obsidian_base_query.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {},
    command: "bases",
    tier: "quick",
  }),

  defineTool({
    name: "obsidian_base_views",
    title: "List the views of the open base",
    description:
      "Lists the views (the saved table/card layouts) of the base file currently open in Obsidian. " +
      "The CLI command takes no file or path: it always reads the active base, so this only helps " +
      "when the user is looking at one. For any other base, call obsidian_base_query with `file`/" +
      "`path` and no `view`, which returns its default view.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {},
    command: "base:views",
    tier: "quick",
  }),

  defineTool({
    name: "obsidian_base_query",
    title: "Query a base",
    description:
      "Runs a base and returns its rows: the notes it selects, with the properties its view shows. " +
      "Identify the base with `file` (its name, e.g. \"Reading list\") or `path` (e.g. " +
      '"33.11 Notes/Reading list.base"); list them with obsidian_bases first. Omit `view` to get ' +
      "the base's default view. Use `format` to trade detail for size: `paths` returns only the " +
      "note paths, which is the cheapest way to then read a couple of them.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      file: fileParam,
      path: pathParam,
      view: z.string().optional().describe("Name of the view to run. Defaults to the base's first/default view."),
      format: z
        .enum(["json", "csv", "tsv", "md", "paths"])
        .default("json")
        .describe(
          "json (default, one object per row), csv/tsv (compact tables), md (a Markdown table) or " +
            "paths (just the vault-relative paths of the matching notes)."
        ),
    },
    requireTarget: true,
    command: "base:query",
    // A base runs a filter over the whole vault and can return every note it matches.
    tier: "slow",
    tokens: ({ file, path, view, format }) => kv({ file, path, view, format }),
  }),
];
