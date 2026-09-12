/**
 * Files and folders: reading a note, listing the vault, the four writers that change where a
 * note lives or what it holds, and the inventory tools that answer questions ABOUT a file, a
 * folder or the vault without reading any of it.
 */
import { z } from "zod";

import { kv } from "../cli.js";
import { buildCreatePath } from "../paths.js";
import { jsonRows } from "../structured.js";
import { defineTool } from "./registry.js";
import { fileParam, pathParam, totalParam } from "./params.js";

export const fileTools = [
  defineTool({
    name: "obsidian_read",
    title: "Read a note",
    description: "Reads the contents of a note, by wikilink name or by vault-relative path.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      file: z.string().optional().describe('Note name / wikilink, e.g. "My Note"'),
      path: z.string().optional().describe('Vault-relative path, e.g. "Projects/Note.md"'),
    },
    requireTarget: "Provide either `file` or `path`.",
    command: "read",
    tier: "quick",
    tokens: ({ file, path }) => kv({ file, path }),
  }),

  defineTool({
    name: "obsidian_outline",
    title: "Show a note's headings",
    description:
      "Returns the heading tree of a note without its body. Use it before obsidian_read on a long " +
      "note: it shows what is in there for a fraction of the context, and tells you whether the " +
      "note is worth reading whole at all.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      file: fileParam,
      path: pathParam,
      format: z
        .enum(["tree", "md", "json"])
        .default("tree")
        .describe(
          "tree (default, indented outline), md (the heading lines as Markdown) or json (level " +
            "and text per heading, for when you need to process them)."
        ),
      total: totalParam,
    },
    requireTarget: true,
    command: "outline",
    tier: "quick",
    tokens: ({ file, path, format, total }) => kv({ file, path, format, total }),
    output: {
      key: "headings",
      schema: jsonRows,
      description:
        "One entry per heading, as the CLI's own JSON. Absent unless `format` is json, and when " +
        "the call asked for `total` or the output had to be truncated.",
      when: ({ format }) => format === "json",
    },
  }),

  defineTool({
    name: "obsidian_list_files",
    title: "List files in the vault",
    description:
      "Lists notes/files in the vault, optionally filtered by folder or extension. The output is " +
      "plain text, one vault-relative path per line (this command has no JSON format).",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      folder: z.string().optional().describe('Limit to a folder, e.g. "33.11 Notes".'),
      ext: z.string().optional().describe('File extension filter, e.g. "md"'),
      total: totalParam,
    },
    command: "files",
    tier: "slow",
    tokens: ({ folder, ext, total }) => kv({ folder, ext, total }),
  }),

  defineTool({
    name: "obsidian_list_folders",
    title: "List folders in the vault",
    description:
      "Lists the vault's folder structure, one folder per line, or only what hangs below one " +
      "folder when `folder` is given.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      folder: z
        .string()
        .optional()
        .describe(
          'Only this folder and the ones under it, e.g. "33 Notes". Omit for the whole vault.'
        ),
      tree: z.boolean().default(false).describe("Render as a hierarchical tree instead of a flat list."),
      total: totalParam,
    },
    command: "folders",
    tier: "slow",
    tokens: ({ folder, tree, total }) => kv({ folder, format: tree ? "tree" : undefined, total }),
  }),

  defineTool({
    name: "obsidian_create",
    title: "Create a note",
    description:
      "Creates a new note, optionally from a template and/or with initial content. The note is " +
      "written at `path`/`name`.md: the name may contain dots, accents, dashes or parentheses, and " +
      "folders whose name carries an ID (e.g. \"33.11 Notes/\") work as typed. Missing folders are " +
      "created. Paths are relative to the vault root.",
    // `overwrite` can replace an existing note, so this counts as destructive.
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      name: z
        .string()
        .optional()
        .describe(
          'Name of the new note, with or without the ".md" suffix, e.g. "Smart Notes - Summary (Ahrens)". ' +
            "Dots are kept. Ignored when `path` already ends in \".md\"."
        ),
      path: z
        .string()
        .optional()
        .describe(
          'Destination folder, relative to the vault root, e.g. "33.11 Notes/" (a trailing slash is ' +
            'optional). If it already ends in ".md" it is used as the full destination path and `name` ' +
            "is ignored."
        ),
      content: z.string().optional(),
      template: z.string().optional().describe("Name of an existing template note to apply."),
      overwrite: z.boolean().default(false).describe("Overwrite if a note with this name already exists."),
    },
    writes: true,
    command: "create",
    // The CLI mangles `name`+`path`, so we always hand it the finished path. See src/paths.ts.
    // buildCreatePath throws for a path that is not usable, and the registry answers with its message.
    tokens: ({ name, path, content, template, overwrite }) =>
      kv({ path: buildCreatePath(name, path), content, template, overwrite }),
  }),

  defineTool({
    name: "obsidian_append",
    title: "Append to a note",
    description: "Appends content to the end of an existing note, addressed by name or by path.",
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      file: fileParam,
      path: pathParam,
      content: z.string(),
    },
    writes: true,
    requireTarget: true,
    command: "append",
    tokens: ({ file, path, content }) => kv({ file, path, content }),
  }),

  defineTool({
    name: "obsidian_prepend",
    title: "Prepend to a note",
    description: "Inserts content at the start of an existing note, addressed by name or by path.",
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      file: fileParam,
      path: pathParam,
      content: z.string(),
    },
    writes: true,
    requireTarget: true,
    command: "prepend",
    tokens: ({ file, path, content }) => kv({ file, path, content }),
  }),

  defineTool({
    name: "obsidian_move",
    title: "Move or rename a note",
    description:
      "Moves a note to a different folder (or renames it). Wikilinks pointing to it are updated automatically.",
    // Rewrites wikilinks across the whole vault and no single command undoes that; a second
    // identical call no longer finds the source, so it is not idempotent either.
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      file: fileParam,
      path: pathParam,
      to: z.string().describe('Destination folder or path, e.g. "Archive/2026/".'),
    },
    writes: true,
    requireTarget: true,
    command: "move",
    // Moving rewrites every wikilink pointing at the note, so it is vault-wide work.
    tier: "slow",
    tokens: ({ file, path, to }) => kv({ file, path, to }),
  }),

  defineTool({
    name: "obsidian_rename",
    title: "Rename a note",
    description:
      "Renames a note in place, keeping it in its folder. Always rename through this tool (or " +
      "obsidian_move) rather than by creating a copy and deleting the original: Obsidian rewrites " +
      "every wikilink pointing at the note as part of the rename, and a rename done outside the " +
      "app leaves all of those links broken. Use obsidian_move when the note also changes folder.",
    // Rewrites wikilinks across the vault, and a second identical call no longer finds the source.
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      file: fileParam,
      path: pathParam,
      name: z
        .string()
        .describe(
          'New name for the note, e.g. "Smart Notes - Summary". Never put : * ? " < > | / \\ in a ' +
            "filename: Obsidian Sync's cross-platform rules choke on them."
        ),
    },
    writes: true,
    requireTarget: true,
    command: "rename",
    // Same as move: the link rewrite spans the whole vault.
    tier: "slow",
    tokens: ({ file, path, name }) => kv({ file, path, name }),
  }),

  defineTool({
    name: "obsidian_delete",
    title: "Delete a note",
    description: "Deletes a note. By default it goes to Obsidian's trash unless `permanent` is set.",
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      file: fileParam,
      path: pathParam,
      permanent: z.boolean().default(false).describe("Skip the trash and delete permanently."),
    },
    writes: true,
    requireTarget: true,
    command: "delete",
    tokens: ({ file, path, permanent }) => kv({ file, path, permanent }),
  }),

  // -------------------------------------------------------------------------
  // Inventory: metadata about a file, a folder or the vault
  // -------------------------------------------------------------------------

  defineTool({
    name: "obsidian_file_info",
    title: "Show a note's metadata",
    description:
      "Returns what Obsidian knows about a file -- its path, size and dates -- without its " +
      "contents. Use it to check that a note exists, or how recently it changed, before deciding " +
      "to read it.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { file: fileParam, path: pathParam },
    requireTarget: true,
    command: "file",
    tier: "quick",
    tokens: ({ file, path }) => kv({ file, path }),
  }),

  defineTool({
    name: "obsidian_folder_info",
    title: "Show a folder's metadata",
    description:
      "Returns a summary of a folder: how many files and subfolders it holds and how much space " +
      "it takes. Use `info` to get one of those numbers on its own; it is much cheaper than " +
      "listing the folder with obsidian_list_files and counting.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      path: z.string().describe('Folder path relative to the vault root, e.g. "33.11 Notes". Required.'),
      info: z
        .enum(["files", "folders", "size"])
        .optional()
        .describe("Return only the file count, the subfolder count or the size. Omit for all of them."),
    },
    command: "folder",
    tier: "quick",
    tokens: ({ path, info }) => kv({ path, info }),
  }),

  defineTool({
    name: "obsidian_wordcount",
    title: "Count a note's words and characters",
    description:
      "Counts the words and characters of a note. Use it to size a note before reading it, or to " +
      "answer \"how long is this?\" without pulling the text into context.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      file: fileParam,
      path: pathParam,
      only: z
        .enum(["words", "characters"])
        .optional()
        .describe("Return just one of the two counts. Omit to get both."),
    },
    requireTarget: true,
    command: "wordcount",
    tier: "quick",
    tokens: ({ file, path, only }) =>
      kv({ file, path, words: only === "words", characters: only === "characters" }),
  }),

  defineTool({
    name: "obsidian_aliases",
    title: "List aliases",
    description:
      "Lists the aliases declared in note frontmatter, across the vault or for one note when " +
      "`file`/`path` is given. Aliases are the other names a note answers to in wikilinks, so " +
      "this is what to check when a link or a search by title finds nothing.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      file: fileParam,
      path: pathParam,
      verbose: z.boolean().default(false).describe("Include the path of the note each alias belongs to."),
      total: totalParam,
    },
    // Both targets are optional: with neither, the CLI covers the whole vault.
    command: "aliases",
    tier: "slow",
    tokens: ({ file, path, verbose, total }) => kv({ file, path, verbose, total }),
  }),

  defineTool({
    name: "obsidian_recents",
    title: "List recently opened notes",
    description:
      "Lists the notes the user opened most recently, newest first. This is the fastest way to " +
      'pick up "the note I was just working on" without guessing its name.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { total: totalParam },
    command: "recents",
    tier: "quick",
    tokens: ({ total }) => kv({ total }),
  }),
];
