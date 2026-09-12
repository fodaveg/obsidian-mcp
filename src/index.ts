#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatResult, kv, runCli, withVault, type CliResult } from "./cli.js";
import { buildCreatePath } from "./paths.js";

const DISABLE_EXEC = ["1", "true", "yes"].includes(
  (process.env.OBSIDIAN_MCP_DISABLE_EXEC || "").toLowerCase()
);

const server = new McpServer({
  name: "obsidian-mcp",
  version: "0.1.0",
});

/** Runs the CLI and turns the result into a CallToolResult. */
async function respond(args: string[]) {
  const result: CliResult = await runCli(withVault(args));
  return {
    isError: !result.ok,
    content: [{ type: "text" as const, text: formatResult(result) }],
  };
}

/** Builds an error CallToolResult without going near the CLI. */
function errorResult(text: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
  };
}

// ---------------------------------------------------------------------------
// Escape hatch: run any Obsidian CLI command verbatim.
// ---------------------------------------------------------------------------

if (!DISABLE_EXEC) {
  server.registerTool(
    "obsidian_exec",
    {
      title: "Run a raw Obsidian CLI command",
      description:
        "Runs `obsidian <args...>` directly against the Obsidian CLI (requires Obsidian to be open " +
        "with CLI support enabled). Use this for anything not covered by the dedicated tools below, e.g.:\n" +
        '  ["files", "folder=Projects"]\n' +
        '  ["folders", "format=tree"]\n' +
        '  ["links", "file=My Note"]\n' +
        '  ["unresolved"]\n' +
        '  ["orphans"]\n' +
        '  ["tags:rename", "old=meeting", "new=meetings"]\n' +
        '  ["plugin:enable", "id=dataview"]\n' +
        '  ["publish:list"]\n' +
        '  ["sync:status"]\n' +
        '  ["history", "file=My Note"]\n' +
        "Each element is one whitespace-free CLI token, exactly as you'd type it after `obsidian` " +
        '(key=value for parameters, e.g. "file=My Note", and --flag for booleans). ' +
        "CAUTION: this also gives access to developer commands like eval=<js> and dev:* which can run " +
        "arbitrary JavaScript inside the user's Obsidian app or inspect its UI -- only use those when the " +
        "user explicitly asks for them. Set OBSIDIAN_MCP_DISABLE_EXEC=1 in the server's environment to " +
        "remove this tool entirely and keep only the curated tools below.",
      inputSchema: {
        args: z
          .array(z.string())
          .min(1)
          .describe('CLI tokens after "obsidian", e.g. ["read", "file=My Note"]'),
      },
    },
    async ({ args }) => respond(args)
  );
}

// ---------------------------------------------------------------------------
// Files & folders
// ---------------------------------------------------------------------------

server.registerTool(
  "obsidian_read",
  {
    title: "Read a note",
    description: "Reads the contents of a note, by wikilink name or by vault-relative path.",
    inputSchema: {
      file: z.string().optional().describe('Note name / wikilink, e.g. "My Note"'),
      path: z.string().optional().describe('Vault-relative path, e.g. "Projects/Note.md"'),
    },
  },
  async ({ file, path }) => {
    if (!file && !path) return errorResult("Provide either `file` or `path`.");
    return respond(["read", ...kv({ file, path })]);
  }
);

server.registerTool(
  "obsidian_list_files",
  {
    title: "List files in the vault",
    description: "Lists notes/files in the vault, optionally filtered by folder or extension.",
    inputSchema: {
      folder: z.string().optional(),
      ext: z.string().optional().describe('File extension filter, e.g. "md"'),
      json: z.boolean().default(true).describe("Return machine-readable JSON output."),
    },
  },
  async ({ folder, ext, json }) =>
    respond(["files", ...kv({ folder, ext, format: json ? "json" : undefined })])
);

server.registerTool(
  "obsidian_list_folders",
  {
    title: "List folders in the vault",
    description: "Lists the vault's folder structure.",
    inputSchema: {
      tree: z.boolean().default(false).describe("Render as a hierarchical tree instead of a flat list."),
    },
  },
  async ({ tree }) => respond(["folders", ...kv({ format: tree ? "tree" : undefined })])
);

server.registerTool(
  "obsidian_create",
  {
    title: "Create a note",
    description:
      "Creates a new note, optionally from a template and/or with initial content. The note is " +
      "written at `path`/`name`.md: the name may contain dots, accents, dashes or parentheses, and " +
      "folders whose name carries an ID (e.g. \"33.11 Notes/\") work as typed. Missing folders are " +
      "created. Paths are relative to the vault root.",
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
  },
  async ({ name, path, content, template, overwrite }) => {
    let target: string;
    try {
      // The CLI mangles `name`+`path`, so we always hand it the finished path. See src/paths.ts.
      target = buildCreatePath(name, path);
    } catch (err) {
      return errorResult((err as Error).message);
    }
    return respond(["create", ...kv({ path: target, content, template, overwrite })]);
  }
);

server.registerTool(
  "obsidian_append",
  {
    title: "Append to a note",
    description: "Appends content to the end of an existing note.",
    inputSchema: {
      file: z.string().describe("Note name / wikilink."),
      content: z.string(),
    },
  },
  async ({ file, content }) => respond(["append", ...kv({ file, content })])
);

server.registerTool(
  "obsidian_prepend",
  {
    title: "Prepend to a note",
    description: "Inserts content at the start of an existing note.",
    inputSchema: {
      file: z.string().describe("Note name / wikilink."),
      content: z.string(),
    },
  },
  async ({ file, content }) => respond(["prepend", ...kv({ file, content })])
);

server.registerTool(
  "obsidian_move",
  {
    title: "Move or rename a note",
    description:
      "Moves a note to a different folder (or renames it). Wikilinks pointing to it are updated automatically.",
    inputSchema: {
      file: z.string().describe("Note name / wikilink to move."),
      to: z.string().describe('Destination folder or path, e.g. "Archive/2026/".'),
    },
  },
  async ({ file, to }) => respond(["move", ...kv({ file, to })])
);

server.registerTool(
  "obsidian_delete",
  {
    title: "Delete a note",
    description: "Deletes a note. By default it goes to Obsidian's trash unless `permanent` is set.",
    inputSchema: {
      file: z.string().describe("Note name / wikilink to delete."),
      permanent: z.boolean().default(false),
    },
  },
  async ({ file, permanent }) => respond(["delete", ...kv({ file, permanent })])
);

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

server.registerTool(
  "obsidian_search",
  {
    title: "Search the vault",
    description:
      "Full-text search across the vault. Supports structured filters inside the query string, e.g. " +
      '"[tag:project]", "[status:active]", "[priority:>3]".',
    inputSchema: {
      query: z.string(),
      limit: z.number().int().positive().optional(),
      json: z.boolean().default(true).describe("Return machine-readable JSON output."),
    },
  },
  async ({ query, limit, json }) =>
    respond(["search", ...kv({ query, limit, format: json ? "json" : undefined })])
);

// ---------------------------------------------------------------------------
// Daily notes
// ---------------------------------------------------------------------------

server.registerTool(
  "obsidian_daily_read",
  {
    title: "Read today's daily note",
    description: "Reads the content of today's daily note (or a specific date's).",
    inputSchema: {
      date: z.string().optional().describe("ISO date, e.g. 2026-07-20. Defaults to today."),
    },
  },
  async ({ date }) => respond(["daily:read", ...kv({ date })])
);

server.registerTool(
  "obsidian_daily_append",
  {
    title: "Append to today's daily note",
    description: "Appends content to the end of today's daily note.",
    inputSchema: { content: z.string() },
  },
  async ({ content }) => respond(["daily:append", ...kv({ content })])
);

server.registerTool(
  "obsidian_daily_prepend",
  {
    title: "Prepend to today's daily note",
    description: "Inserts content at the start of today's daily note.",
    inputSchema: { content: z.string() },
  },
  async ({ content }) => respond(["daily:prepend", ...kv({ content })])
);

// ---------------------------------------------------------------------------
// Properties (YAML frontmatter)
// ---------------------------------------------------------------------------

server.registerTool(
  "obsidian_properties_get",
  {
    title: "Get a note's properties",
    description: "Reads the YAML frontmatter/properties of a note.",
    inputSchema: { file: z.string() },
  },
  async ({ file }) => respond(["properties", ...kv({ file })])
);

server.registerTool(
  "obsidian_properties_set",
  {
    title: "Set note properties",
    description:
      "Sets one or more frontmatter properties on a note, e.g. { status: 'active', tags: 'pkm,obsidian' }.",
    inputSchema: {
      file: z.string(),
      properties: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .describe('Property name -> value, e.g. { "status": "active" }'),
    },
  },
  async ({ file, properties }) =>
    respond(["properties:set", ...kv({ file }), ...kv(properties)])
);

server.registerTool(
  "obsidian_properties_remove",
  {
    title: "Remove a note property",
    description: "Removes a single frontmatter key from a note.",
    inputSchema: { file: z.string(), key: z.string() },
  },
  async ({ file, key }) => respond(["properties:remove", ...kv({ file, key })])
);

// ---------------------------------------------------------------------------
// Tags, links & backlinks
// ---------------------------------------------------------------------------

server.registerTool(
  "obsidian_tags",
  {
    title: "List tags",
    description: "Lists all tags used in the vault, optionally sorted by usage count.",
    inputSchema: {
      byCount: z.boolean().default(false).describe("Sort tags by how often they're used."),
    },
  },
  async ({ byCount }) => respond(["tags", ...kv({ sort: byCount ? "count" : undefined })])
);

server.registerTool(
  "obsidian_backlinks",
  {
    title: "List backlinks to a note",
    description: "Lists every note that links to the given note.",
    inputSchema: { file: z.string() },
  },
  async ({ file }) => respond(["backlinks", ...kv({ file })])
);

server.registerTool(
  "obsidian_links",
  {
    title: "List a note's outgoing links",
    description: "Lists every link found inside the given note.",
    inputSchema: { file: z.string() },
  },
  async ({ file }) => respond(["links", ...kv({ file })])
);

server.registerTool(
  "obsidian_orphans",
  {
    title: "List orphan notes",
    description: "Lists notes that have no incoming or outgoing links.",
    inputSchema: {},
  },
  async () => respond(["orphans"])
);

server.registerTool(
  "obsidian_unresolved_links",
  {
    title: "List unresolved links",
    description: "Lists links in the vault that don't resolve to an existing note.",
    inputSchema: {},
  },
  async () => respond(["unresolved"])
);

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

server.registerTool(
  "obsidian_tasks_list",
  {
    title: "List tasks",
    description: "Lists tasks (checkboxes) found across the vault.",
    inputSchema: {
      json: z.boolean().default(true),
    },
  },
  async ({ json }) => respond(["tasks", ...kv({ format: json ? "json" : undefined })])
);

server.registerTool(
  "obsidian_task_create",
  {
    title: "Create a task",
    description: "Creates a new task, optionally tagged.",
    inputSchema: {
      content: z.string(),
      tags: z.string().optional().describe('Comma-separated tags, e.g. "work,urgent".'),
    },
  },
  async ({ content, tags }) => respond(["task:create", ...kv({ content, tags })])
);

server.registerTool(
  "obsidian_task_complete",
  {
    title: "Complete a task",
    description: "Marks a task as done by its task id (as returned by obsidian_tasks_list).",
    inputSchema: { task: z.string() },
  },
  async ({ task }) => respond(["task:complete", ...kv({ task })])
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("obsidian-mcp failed to start:", err);
  process.exit(1);
});
