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
 *
 * WITH `total`, THE COUNT WINS. Measured on CLI 1.14.1: `tags total format=json` answers `467`
 * and `tags total` answers `467`; `unresolved total format=json` and `unresolved total` both
 * answer `433`; `backlinks total format=json` answers `1`. The format is simply ignored, so the
 * pair is predictable rather than confusing and is documented instead of refused -- and since a
 * bare count is not JSON, structuredContent is the empty object, as it is for any `total` call.
 */
const jsonParam = z
  .boolean()
  .default(true)
  .describe(
    "Return machine-readable JSON instead of the CLI's tab-separated rendering. Ignored when " +
      "`total` is set: that answers with the count either way."
  );

/**
 * `all` as `orphans` and `deadends` both take it. The CLI's help calls it "include non-markdown
 * files" for either command.
 *
 * Measured on 1.14.1 in a vault whose attachments are already in both listings (images show up
 * without it), the counts did not move: orphans 4361 with and without, deadends 4783 with and
 * without. So it is exposed as the CLI documents it, not as a promise about what it changes.
 */
const allParam = z
  .boolean()
  .default(false)
  .describe("Include non-Markdown files (images, PDFs…) as well as notes.");

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
    // What the CLI actually does, measured on 1.14.1 against a 5k-note vault: `orphans` returned
    // 4361 files and `deadends` 4783, sharing 4081 -- neither set contains the other, so they are
    // not two names for one thing. A file listed only by `orphans` had 3 outgoing links and 0
    // backlinks; one listed only by `deadends` had 0 outgoing links and 1 backlink.
    description:
      "Lists notes that NOTHING links to (no incoming links). Their own outgoing links do not " +
      "matter: a note that links out but that no note links back to is an orphan. For the " +
      "opposite question -- notes that link to nothing -- use obsidian_deadends; the two lists " +
      "overlap without either containing the other, and a note in both is disconnected either way.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { all: allParam, total: totalParam },
    command: "orphans",
    tier: "slow",
    tokens: ({ all, total }) => kv({ all, total }),
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
    inputSchema: { all: allParam, total: totalParam },
    command: "deadends",
    tier: "slow",
    tokens: ({ all, total }) => kv({ all, total }),
  }),
];
