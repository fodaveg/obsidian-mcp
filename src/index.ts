#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatResult, kv, runCli, withVault, type CliResult } from "./cli.js";
import { buildCreatePath } from "./paths.js";
import { buildTaskLine } from "./tasks.js";

/** Reads a boolean-ish environment variable: `1`, `true` or `yes`, case-insensitive. */
function envFlag(name: string): boolean {
  return ["1", "true", "yes"].includes((process.env[name] || "").trim().toLowerCase());
}

// The escape hatch forwards arbitrary CLI tokens -- including `eval` and `dev:*`, which run
// JavaScript inside the user's Obsidian -- so it is opt-in: a fresh install exposes only the
// curated tools. OBSIDIAN_MCP_DISABLE_EXEC stays recognised as an explicit off switch (so an
// existing configuration keeps working) and wins over the enable flag.
const ENABLE_EXEC =
  envFlag("OBSIDIAN_MCP_ENABLE_EXEC") && !envFlag("OBSIDIAN_MCP_DISABLE_EXEC");

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

// Every CLI command that targets a note accepts `file=` (resolved by name, like a
// wikilink) or `path=` (exact). Names repeat across folders, so `path` is the
// unambiguous one; both are declared optional and each tool checks that it got one.
const fileParam = z.string().optional().describe('Note name / wikilink, e.g. "My Note".');
const pathParam = z
  .string()
  .optional()
  .describe(
    'Exact vault-relative path, e.g. "33.11 Notes/My Note.md". Use it when several notes share a name.'
  );
const MISSING_TARGET = "Provide either `file` (note name, like a wikilink) or `path` (exact vault-relative path).";

// The CLI's listing commands all take a bare `total` token that returns the count instead of the
// list. It is the cheapest answer there is to "how many?", so every tool that lists exposes it.
const totalParam = z
  .boolean()
  .default(false)
  .describe(
    'Return only how many results there are, not the results themselves. Use it for "how many …?" ' +
      "questions: it answers them without paying for the whole listing."
  );

// Every tool declares `annotations`, because the spec tells clients to assume the worst when
// they are missing -- without them, reading a note asks the user for the same confirmation as
// deleting one. The criteria used here:
//   readOnlyHint    -- the tool never writes to the vault.
//   destructiveHint -- only meaningful when readOnlyHint is false. `true` means it can lose
//                      existing content (delete, move, create with overwrite, property:remove);
//                      `false` is reserved for the purely additive writers (append/prepend).
//                      Where a call overwrites a value in place it is left undeclared, so the
//                      client keeps its cautious default.
//   idempotentHint  -- only meaningful when readOnlyHint is false, and only declared when
//                      repeating the exact same call leaves the vault in the same state.
//   openWorldHint   -- true everywhere: every result depends on a vault this server does not
//                      own and the user can change under it at any moment.

// ---------------------------------------------------------------------------
// Escape hatch: run any Obsidian CLI command verbatim.
// ---------------------------------------------------------------------------

if (ENABLE_EXEC) {
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
    annotations: { readOnlyHint: true, openWorldHint: true },
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
    description:
      "Lists notes/files in the vault, optionally filtered by folder or extension. The output is " +
      "plain text, one vault-relative path per line (this command has no JSON format).",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      folder: z.string().optional().describe('Limit to a folder, e.g. "33.11 Notes".'),
      ext: z.string().optional().describe('File extension filter, e.g. "md"'),
      total: totalParam,
    },
  },
  async ({ folder, ext, total }) => respond(["files", ...kv({ folder, ext, total })])
);

server.registerTool(
  "obsidian_list_folders",
  {
    title: "List folders in the vault",
    description: "Lists the vault's folder structure.",
    annotations: { readOnlyHint: true, openWorldHint: true },
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
    description: "Appends content to the end of an existing note, addressed by name or by path.",
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      file: fileParam,
      path: pathParam,
      content: z.string(),
    },
  },
  async ({ file, path, content }) => {
    if (!file && !path) return errorResult(MISSING_TARGET);
    return respond(["append", ...kv({ file, path, content })]);
  }
);

server.registerTool(
  "obsidian_prepend",
  {
    title: "Prepend to a note",
    description: "Inserts content at the start of an existing note, addressed by name or by path.",
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      file: fileParam,
      path: pathParam,
      content: z.string(),
    },
  },
  async ({ file, path, content }) => {
    if (!file && !path) return errorResult(MISSING_TARGET);
    return respond(["prepend", ...kv({ file, path, content })]);
  }
);

server.registerTool(
  "obsidian_move",
  {
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
  },
  async ({ file, path, to }) => {
    if (!file && !path) return errorResult(MISSING_TARGET);
    return respond(["move", ...kv({ file, path, to })]);
  }
);

server.registerTool(
  "obsidian_delete",
  {
    title: "Delete a note",
    description: "Deletes a note. By default it goes to Obsidian's trash unless `permanent` is set.",
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      file: fileParam,
      path: pathParam,
      permanent: z.boolean().default(false).describe("Skip the trash and delete permanently."),
    },
  },
  async ({ file, path, permanent }) => {
    if (!file && !path) return errorResult(MISSING_TARGET);
    return respond(["delete", ...kv({ file, path, permanent })]);
  }
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
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      query: z.string(),
      // `search` is the only exposed command with a limit: `tags` and `tasks` have none.
      limit: z
        .number()
        .int()
        .positive()
        .default(50)
        .describe("Max files to return. Defaults to 50 -- raise it when you need more."),
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
    annotations: { readOnlyHint: true, openWorldHint: true },
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
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: { content: z.string() },
  },
  async ({ content }) => respond(["daily:append", ...kv({ content })])
);

server.registerTool(
  "obsidian_daily_prepend",
  {
    title: "Prepend to today's daily note",
    description: "Inserts content at the start of today's daily note.",
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { file: fileParam, path: pathParam },
  },
  async ({ file, path }) => {
    if (!file && !path) return errorResult(MISSING_TARGET);
    return respond(["properties", ...kv({ file, path })]);
  }
);

server.registerTool(
  "obsidian_properties_set",
  {
    title: "Set note properties",
    description:
      "Sets one or more frontmatter properties on a note, e.g. { status: 'active', tags: 'pkm,obsidian' }. " +
      "The CLI sets one property per call, so this runs one call per key and reports them all together.",
    // A key that already existed keeps no copy of its old value, so destructiveHint is left
    // undeclared on purpose and the client keeps its cautious default.
    annotations: { idempotentHint: true, openWorldHint: true },
    inputSchema: {
      file: fileParam,
      path: pathParam,
      properties: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .describe('Property name -> value, e.g. { "status": "active" }'),
      type: z
        .enum(["text", "list", "number", "checkbox", "date", "datetime"])
        .optional()
        .describe("Property type, applied to every property in this call. Defaults to Obsidian's own guess."),
    },
  },
  async ({ file, path, properties, type }) => {
    if (!file && !path) return errorResult(MISSING_TARGET);

    const entries = Object.entries(properties);
    if (entries.length === 0) return errorResult("Provide at least one property to set.");

    const lines: string[] = [];
    let failed = false;
    for (const [name, value] of entries) {
      // name= and value= are built by hand so that an empty value still reaches the CLI.
      const result: CliResult = await runCli(
        withVault(["property:set", `name=${name}`, `value=${value}`, ...kv({ type, file, path })])
      );
      if (!result.ok) failed = true;
      lines.push(`${name}: ${formatResult(result)}`);
    }

    return { isError: failed, content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

server.registerTool(
  "obsidian_properties_remove",
  {
    title: "Remove a note property",
    description: "Removes a single frontmatter key from a note.",
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      file: fileParam,
      path: pathParam,
      key: z.string().describe('Property name to remove, e.g. "status".'),
    },
  },
  async ({ file, path, key }) => {
    if (!file && !path) return errorResult(MISSING_TARGET);
    return respond(["property:remove", ...kv({ name: key, file, path })]);
  }
);

// ---------------------------------------------------------------------------
// Tags, links & backlinks
// ---------------------------------------------------------------------------

server.registerTool(
  "obsidian_tags",
  {
    title: "List tags",
    description:
      "Lists the tags used in the vault, or only those of one note when `file` or `path` is given, " +
      "optionally sorted by usage count.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      file: fileParam,
      path: pathParam,
      byCount: z.boolean().default(false).describe("Sort tags by how often they're used."),
      total: totalParam,
    },
  },
  // Both targets are optional here: with neither, the CLI lists the whole vault.
  async ({ file, path, byCount, total }) =>
    respond(["tags", ...kv({ file, path, sort: byCount ? "count" : undefined, total })])
);

server.registerTool(
  "obsidian_backlinks",
  {
    title: "List backlinks to a note",
    description: "Lists every note that links to the given note.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { file: fileParam, path: pathParam, total: totalParam },
  },
  async ({ file, path, total }) => {
    if (!file && !path) return errorResult(MISSING_TARGET);
    return respond(["backlinks", ...kv({ file, path, total })]);
  }
);

server.registerTool(
  "obsidian_links",
  {
    title: "List a note's outgoing links",
    description: "Lists every link found inside the given note.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { file: fileParam, path: pathParam, total: totalParam },
  },
  async ({ file, path, total }) => {
    if (!file && !path) return errorResult(MISSING_TARGET);
    return respond(["links", ...kv({ file, path, total })]);
  }
);

server.registerTool(
  "obsidian_orphans",
  {
    title: "List orphan notes",
    description: "Lists notes that have no incoming or outgoing links.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { total: totalParam },
  },
  async ({ total }) => respond(["orphans", ...kv({ total })])
);

server.registerTool(
  "obsidian_unresolved_links",
  {
    title: "List unresolved links",
    description: "Lists links in the vault that don't resolve to an existing note.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { total: totalParam },
  },
  async ({ total }) => respond(["unresolved", ...kv({ total })])
);

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

server.registerTool(
  "obsidian_tasks_list",
  {
    title: "List tasks",
    description: "Lists tasks (checkboxes) found across the vault.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      json: z.boolean().default(true),
      verbose: z
        .boolean()
        .default(false)
        .describe(
          "Group results by file and include line numbers, which is how you get the `ref` " +
            "(path:line) that obsidian_task_complete needs."
        ),
      total: totalParam,
    },
  },
  async ({ json, verbose, total }) =>
    respond(["tasks", ...kv({ format: json ? "json" : undefined, verbose, total })])
);

server.registerTool(
  "obsidian_task_create",
  {
    title: "Add a task to a note",
    description:
      "Appends a `- [ ] <content>` checkbox line to a note (or to today's daily note when neither " +
      "`file` nor `path` is given). Tags are appended to the line as #tags.",
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      content: z.string().describe("Task text, without the checkbox markup."),
      tags: z.string().optional().describe('Comma-separated tags, e.g. "work,urgent".'),
      file: fileParam,
      path: pathParam,
    },
  },
  async ({ content, tags, file, path }) => {
    // There is no task-creating command in the CLI: a task is just a line of Markdown.
    const line = buildTaskLine(content, tags);
    const args = file || path ? ["append", ...kv({ file, path })] : ["daily:append"];
    return respond([...args, `content=${line}`]);
  }
);

server.registerTool(
  "obsidian_task_complete",
  {
    title: "Complete a task",
    description:
      "Marks a task as done. Identify it with `ref` (\"path:line\", exactly as obsidian_tasks_list " +
      "returns it with `verbose`) or with `path` plus `line`. To toggle it or set another status " +
      "character, use obsidian_exec with the `task` command.",
    // It overwrites the status character of an existing line, so destructiveHint is left
    // undeclared; marking the same task done twice does leave the same state.
    annotations: { idempotentHint: true, openWorldHint: true },
    inputSchema: {
      ref: z
        .string()
        .optional()
        .describe('Task reference, "vault/relative/path.md:12".'),
      path: z.string().optional().describe("Exact vault-relative path of the note holding the task."),
      line: z.number().int().positive().optional().describe("1-based line number of the task."),
    },
  },
  async ({ ref, path, line }) => {
    if (!ref && !(path && line !== undefined)) {
      return errorResult('Provide `ref` ("path:line"), or both `path` and `line`.');
    }
    const target = ref ? kv({ ref }) : kv({ path, line });
    return respond(["task", ...target, "done"]);
  }
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
