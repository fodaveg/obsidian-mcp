/**
 * Tags, links and backlinks: the vault seen as a graph, plus the three views of its link health
 * (orphans, unresolved links, dead ends).
 */
import { z } from "zod";

import { kv } from "../cli.js";
import { jsonRows } from "../structured.js";
import { defineTool } from "./registry.js";
import { fileParam, pathParam, totalParam } from "./params.js";

/**
 * The `format=json` switch for the three commands here that have one. Their own default is TSV;
 * this server asks for JSON like it does everywhere else, so the client also gets the rows parsed
 * as structuredContent instead of a table it has to split.
 */
const jsonParam = z
  .boolean()
  .default(true)
  .describe("Return machine-readable JSON instead of the CLI's tab-separated rendering.");

export const linkTools = [
  defineTool({
    name: "obsidian_tags",
    title: "List tags",
    description:
      "Lists the tags used in the vault, or only those of one note when `file` or `path` is given, " +
      "optionally sorted by usage count.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      file: fileParam,
      path: pathParam,
      byCount: z.boolean().default(false).describe("Sort tags by how often they're used."),
      json: jsonParam,
      total: totalParam,
    },
    // Both targets are optional here: with neither, the CLI lists the whole vault.
    command: "tags",
    tier: "slow",
    tokens: ({ file, path, byCount, json, total }) =>
      kv({
        file,
        path,
        sort: byCount ? "count" : undefined,
        format: json ? "json" : undefined,
        total,
      }),
    output: {
      key: "tags",
      schema: jsonRows,
      description:
        "One entry per tag, as the CLI's own JSON. Absent when the call asked for plain text or " +
        "for `total`, and when the output had to be truncated.",
      when: ({ json }) => json,
    },
  }),

  defineTool({
    name: "obsidian_tag_info",
    title: "Show where one tag is used",
    description:
      "Reports how often a single tag is used and, with `verbose`, in which notes. Use it instead " +
      "of obsidian_tags when you already know the tag and want its notes; obsidian_tags is for " +
      "discovering which tags exist. Searching for the tag with obsidian_search and the " +
      '"[tag:name]" filter is the way to combine it with other criteria.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      name: z.string().describe('Tag name, with or without the leading #, e.g. "project".'),
      verbose: z.boolean().default(false).describe("Include the list of notes carrying the tag, with counts."),
      total: totalParam,
    },
    command: "tag",
    tier: "slow",
    tokens: ({ name, verbose, total }) => kv({ name, verbose, total }),
  }),

  defineTool({
    name: "obsidian_backlinks",
    title: "List backlinks to a note",
    description: "Lists every note that links to the given note.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { file: fileParam, path: pathParam, json: jsonParam, total: totalParam },
    requireTarget: true,
    command: "backlinks",
    // Backlinks are found by looking at every other note in the vault.
    tier: "slow",
    tokens: ({ file, path, json, total }) =>
      kv({ file, path, format: json ? "json" : undefined, total }),
    output: {
      key: "backlinks",
      schema: jsonRows,
      description:
        "One entry per note linking to the target, as the CLI's own JSON. Absent when the call " +
        "asked for plain text or for `total`, and when the output had to be truncated.",
      when: ({ json }) => json,
    },
  }),

  defineTool({
    name: "obsidian_links",
    title: "List a note's outgoing links",
    description: "Lists every link found inside the given note.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { file: fileParam, path: pathParam, total: totalParam },
    requireTarget: true,
    command: "links",
    tier: "quick",
    tokens: ({ file, path, total }) => kv({ file, path, total }),
  }),

  defineTool({
    name: "obsidian_orphans",
    title: "List orphan notes",
    description: "Lists notes that have no incoming or outgoing links.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { total: totalParam },
    command: "orphans",
    tier: "slow",
    tokens: ({ total }) => kv({ total }),
  }),

  defineTool({
    name: "obsidian_unresolved_links",
    title: "List unresolved links",
    description: "Lists links in the vault that don't resolve to an existing note.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { json: jsonParam, total: totalParam },
    command: "unresolved",
    tier: "slow",
    tokens: ({ json, total }) => kv({ format: json ? "json" : undefined, total }),
    output: {
      key: "links",
      schema: jsonRows,
      description:
        "One entry per unresolved link, as the CLI's own JSON. Absent when the call asked for " +
        "plain text or for `total`, and when the output had to be truncated.",
      when: ({ json }) => json,
    },
  }),

  defineTool({
    name: "obsidian_deadends",
    title: "List dead-end notes",
    description:
      "Lists notes that link to nothing. Together with obsidian_orphans (nothing links to them) " +
      "and obsidian_unresolved_links (links pointing nowhere), this is the third view of a vault's " +
      "link health: dead ends are usually notes that were captured and never connected.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      all: z
        .boolean()
        .default(false)
        .describe("Include non-Markdown files (images, PDFs…), which by definition link to nothing."),
      total: totalParam,
    },
    command: "deadends",
    tier: "slow",
    tokens: ({ all, total }) => kv({ all, total }),
  }),
];
