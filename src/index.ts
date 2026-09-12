#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatResult, kv, runCli, withVault, type CliResult, type TimeoutTier } from "./cli.js";
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

// Read-only mode: the tools that change the vault are not registered at all, so they are not in
// the list the model sees and there is nothing for the client to call. It is the only way to use
// this server purely for consulting a vault.
const READONLY = envFlag("OBSIDIAN_MCP_READONLY");

const server = new McpServer({
  name: "obsidian-mcp",
  version: "0.1.0",
});

/**
 * Registers a tool THAT WRITES to the vault -- unless OBSIDIAN_MCP_READONLY is set, in which
 * case it registers nothing.
 *
 * EVERY NEW TOOL THAT WRITES MUST BE REGISTERED THROUGH THIS FUNCTION, never through
 * server.registerTool: this is the whole list of writers, there is no second place that repeats
 * it. In the README they are the rows with a tick in the "Writes" column; in the code they are
 * the ones carrying `destructiveHint` or lacking `readOnlyHint`.
 *
 * The type is registerTool's own so that each handler's arguments are still inferred from its
 * inputSchema. The read-only branch is a no-op whose RegisteredTool return value would be a lie,
 * which is safe here because no call site uses it.
 */
const registerWriteTool: typeof server.registerTool = READONLY
  ? ((() => undefined) as unknown as typeof server.registerTool)
  : server.registerTool.bind(server);

/**
 * Runs the CLI and turns the result into a CallToolResult.
 *
 * `result.ok` is false both when the binary exits non-zero and when it reports one of its own
 * errors on stdout while exiting 0 (see looksLikeCliError in cli.ts), which is what it does for
 * a missing note or an out-of-range line. Every tool goes through here, so the detection is
 * shared rather than repeated per tool.
 *
 * `tier` picks the timeout (see TIMEOUTS in cli.ts): `quick` for the tools that touch one note,
 * `slow` for the ones that sweep the vault, `normal` -- the default -- for the rest, writes
 * included. Calls are queued, so the wait for a free slot does not eat into it.
 */
async function respond(args: string[], tier: TimeoutTier = "normal") {
  const result: CliResult = await runCli(withVault(args), tier);
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
  registerWriteTool(
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
    // No way to tell what an arbitrary command costs, so it gets the most generous timeout.
    async ({ args }) => respond(args, "slow")
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
    return respond(["read", ...kv({ file, path })], "quick");
  }
);

server.registerTool(
  "obsidian_outline",
  {
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
  },
  async ({ file, path, format, total }) => {
    if (!file && !path) return errorResult(MISSING_TARGET);
    return respond(["outline", ...kv({ file, path, format, total })], "quick");
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
  async ({ folder, ext, total }) => respond(["files", ...kv({ folder, ext, total })], "slow")
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
  async ({ tree }) => respond(["folders", ...kv({ format: tree ? "tree" : undefined })], "slow")
);

registerWriteTool(
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

registerWriteTool(
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

registerWriteTool(
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

registerWriteTool(
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
    // Moving rewrites every wikilink pointing at the note, so it is vault-wide work.
    return respond(["move", ...kv({ file, path, to })], "slow");
  }
);

registerWriteTool(
  "obsidian_rename",
  {
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
  },
  async ({ file, path, name }) => {
    if (!file && !path) return errorResult(MISSING_TARGET);
    // Same as move: the link rewrite spans the whole vault.
    return respond(["rename", ...kv({ file, path, name })], "slow");
  }
);

registerWriteTool(
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
// Inventory: metadata about a file, a folder or the vault
// ---------------------------------------------------------------------------

server.registerTool(
  "obsidian_file_info",
  {
    title: "Show a note's metadata",
    description:
      "Returns what Obsidian knows about a file -- its path, size and dates -- without its " +
      "contents. Use it to check that a note exists, or how recently it changed, before deciding " +
      "to read it.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { file: fileParam, path: pathParam },
  },
  async ({ file, path }) => {
    if (!file && !path) return errorResult(MISSING_TARGET);
    return respond(["file", ...kv({ file, path })], "quick");
  }
);

server.registerTool(
  "obsidian_folder_info",
  {
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
  },
  async ({ path, info }) => respond(["folder", ...kv({ path, info })], "quick")
);

server.registerTool(
  "obsidian_wordcount",
  {
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
  },
  async ({ file, path, only }) => {
    if (!file && !path) return errorResult(MISSING_TARGET);
    return respond(
      ["wordcount", ...kv({ file, path, words: only === "words", characters: only === "characters" })],
      "quick"
    );
  }
);

server.registerTool(
  "obsidian_aliases",
  {
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
  },
  // Both targets are optional: with neither, the CLI covers the whole vault.
  async ({ file, path, verbose, total }) =>
    respond(["aliases", ...kv({ file, path, verbose, total })], "slow")
);

server.registerTool(
  "obsidian_recents",
  {
    title: "List recently opened notes",
    description:
      "Lists the notes the user opened most recently, newest first. This is the fastest way to " +
      'pick up "the note I was just working on" without guessing its name.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { total: totalParam },
  },
  async ({ total }) => respond(["recents", ...kv({ total })], "quick")
);

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

server.registerTool(
  "obsidian_search",
  {
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
  },
  async ({ query, path, limit, caseSensitive, json, total }) =>
    respond(
      [
        "search",
        ...kv({ query, path, limit, case: caseSensitive, format: json ? "json" : undefined, total }),
      ],
      "slow"
    )
);

server.registerTool(
  "obsidian_search_context",
  {
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
  },
  async ({ query, path, limit, caseSensitive, json }) =>
    respond(
      [
        "search:context",
        ...kv({ query, path, limit, case: caseSensitive, format: json ? "json" : undefined }),
      ],
      "slow"
    )
);

// ---------------------------------------------------------------------------
// Bases (Obsidian's database views over note properties)
// ---------------------------------------------------------------------------

server.registerTool(
  "obsidian_bases",
  {
    title: "List the vault's bases",
    description:
      "Lists the base files (.base) in the vault. A base is a saved, filtered table over note " +
      "properties, so it is the structured half of the vault: whatever the user curates there is " +
      "already scoped and sorted, and querying it beats rebuilding the same list with a search. " +
      "Start here to find out which bases exist, then query one with obsidian_base_query.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {},
  },
  async () => respond(["bases"], "quick")
);

server.registerTool(
  "obsidian_base_views",
  {
    title: "List the views of the open base",
    description:
      "Lists the views (the saved table/card layouts) of the base file currently open in Obsidian. " +
      "The CLI command takes no file or path: it always reads the active base, so this only helps " +
      "when the user is looking at one. For any other base, call obsidian_base_query with `file`/" +
      "`path` and no `view`, which returns its default view.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {},
  },
  async () => respond(["base:views"], "quick")
);

server.registerTool(
  "obsidian_base_query",
  {
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
  },
  async ({ file, path, view, format }) => {
    if (!file && !path) return errorResult(MISSING_TARGET);
    // A base runs a filter over the whole vault and can return every note it matches.
    return respond(["base:query", ...kv({ file, path, view, format })], "slow");
  }
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
  async ({ date }) => respond(["daily:read", ...kv({ date })], "quick")
);

registerWriteTool(
  "obsidian_daily_append",
  {
    title: "Append to today's daily note",
    description: "Appends content to the end of today's daily note.",
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: { content: z.string() },
  },
  async ({ content }) => respond(["daily:append", ...kv({ content })])
);

registerWriteTool(
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
// Templates
// ---------------------------------------------------------------------------
//
// Both commands answer `No template folder configured` when the vault has no templates
// folder set (Settings -> Templates). That is a configuration answer, not a failure of
// this server, and it is worth relaying to the user as such.

server.registerTool(
  "obsidian_templates",
  {
    title: "List templates",
    description:
      "Lists the template notes available in the vault. Read one with obsidian_template_read " +
      "before passing its name to obsidian_create's `template` parameter, so that the note you " +
      "create follows the structure the user expects. If the vault has no templates folder " +
      "configured, the CLI answers `No template folder configured`.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { total: totalParam },
  },
  async ({ total }) => respond(["templates", ...kv({ total })], "quick")
);

server.registerTool(
  "obsidian_template_read",
  {
    title: "Read a template",
    description:
      "Returns the body of a template, so you can see which sections and properties it defines " +
      "before applying it with obsidian_create. By default the template variables ({{date}}, " +
      "{{title}}…) are left as written; set `resolve` to see what they would expand to.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      name: z.string().describe("Template name, as listed by obsidian_templates."),
      resolve: z
        .boolean()
        .default(false)
        .describe("Expand the template variables instead of showing them verbatim."),
      title: z
        .string()
        .optional()
        .describe("Title to feed the variables when `resolve` is on, i.e. the name of the note-to-be."),
    },
  },
  async ({ name, resolve, title }) =>
    respond(["template:read", ...kv({ name, resolve, title })], "quick")
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
    return respond(["properties", ...kv({ file, path })], "quick");
  }
);

server.registerTool(
  "obsidian_property_read",
  {
    title: "Read one property of a note",
    description:
      "Returns the value of a single frontmatter property. Use it instead of " +
      "obsidian_properties_get when you already know which key you want (\"what is this note's " +
      "status?\"): it returns the value alone, not the whole frontmatter block.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      name: z.string().describe('Property name, e.g. "status".'),
      file: fileParam,
      path: pathParam,
    },
  },
  async ({ name, file, path }) => {
    if (!file && !path) return errorResult(MISSING_TARGET);
    return respond(["property:read", ...kv({ name, file, path })], "quick");
  }
);

registerWriteTool(
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
      // The property name is the VALUE of the `name=` token, never a token name of its own:
      // it comes from the model and an Obsidian property may legitimately be called "Due date",
      // which kv() would (rightly) refuse as a CLI option name.
      const result: CliResult = await runCli(
        withVault(["property:set", `name=${name}`, `value=${value}`, ...kv({ type, file, path })])
      );
      // One failed key fails the batch: the CLI answers `Error: Invalid number: a,b` on stdout
      // with exit code 0, so without this the whole call would be reported as a success.
      if (!result.ok) failed = true;
      lines.push(`${name}: ${formatResult(result)}`);
    }

    return { isError: failed, content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

registerWriteTool(
  "obsidian_properties_remove",
  {
    title: "Remove a note property",
    description:
      "Removes a single frontmatter key from a note. The CLI answers `Removed: <key>` whether or " +
      "not the note had that property, so the reply is not evidence that it existed: check with " +
      "obsidian_property_read first when that matters (e.g. before telling the user you cleared " +
      "something).",
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
    respond(["tags", ...kv({ file, path, sort: byCount ? "count" : undefined, total })], "slow")
);

server.registerTool(
  "obsidian_tag_info",
  {
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
  },
  async ({ name, verbose, total }) => respond(["tag", ...kv({ name, verbose, total })], "slow")
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
    // Backlinks are found by looking at every other note in the vault.
    return respond(["backlinks", ...kv({ file, path, total })], "slow");
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
    return respond(["links", ...kv({ file, path, total })], "quick");
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
  async ({ total }) => respond(["orphans", ...kv({ total })], "slow")
);

server.registerTool(
  "obsidian_unresolved_links",
  {
    title: "List unresolved links",
    description: "Lists links in the vault that don't resolve to an existing note.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { total: totalParam },
  },
  async ({ total }) => respond(["unresolved", ...kv({ total })], "slow")
);

server.registerTool(
  "obsidian_deadends",
  {
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
  },
  async ({ all, total }) => respond(["deadends", ...kv({ all, total })], "slow")
);

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
//
// The CLI's `verbose` token is deliberately not exposed here. It only changes the plain-text
// rendering (grouping by file and adding line numbers), and this tool asks for `format=json`
// by default, where every entry already carries `file` and `line`. Advertised as "how you get
// the ref", it was asking the model to pay for a flag that changed nothing.

server.registerTool(
  "obsidian_tasks_list",
  {
    title: "List tasks",
    description:
      "Lists tasks (checkboxes) found across the vault, and is also where the `ref` (path:line) " +
      "that obsidian_task_complete needs comes from. Scope it whenever you can: an unfiltered " +
      "listing of a working vault runs into the thousands of entries, so asking for the note " +
      "that holds the task is both cheaper and more precise. Give at most one scope -- `file` / " +
      "`path` (one note), `active` (the note open in Obsidian) or `daily` (today's daily note); " +
      "with none of them it covers the whole vault.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      file: fileParam,
      path: pathParam,
      active: z.boolean().default(false).describe("Only the tasks of the note currently open in Obsidian."),
      daily: z.boolean().default(false).describe("Only the tasks of today's daily note."),
      state: z
        .enum(["todo", "done"])
        .optional()
        .describe("Keep only the incomplete (todo) or the completed (done) tasks. Omit for both."),
      status: z
        .string()
        .optional()
        .describe(
          'Filter by status character, for vaults with custom checkbox states, e.g. "/" (in ' +
            'progress) or "-" (cancelled). For the plain done/not-done split use `state`.'
        ),
      json: z
        .boolean()
        .default(true)
        .describe(
          "Return machine-readable JSON: one entry per task with its status, text, file and " +
            "line, so `ref` is simply file:line. Set it to false for the CLI's plain-text " +
            "rendering, which does not carry the line numbers."
        ),
      total: totalParam,
    },
  },
  async ({ file, path, active, daily, state, status, json, total }) => {
    // The CLI takes each of these scopes as a separate token and we have not measured which one
    // wins when they are combined, so rather than guess we ask for one.
    if ([Boolean(file || path), active, daily].filter(Boolean).length > 1) {
      return errorResult("Pick a single scope: `file`/`path`, `active` or `daily`.");
    }
    return respond(
      [
        "tasks",
        ...kv({
          file,
          path,
          active,
          daily,
          done: state === "done",
          todo: state === "todo",
          status,
          format: json ? "json" : undefined,
          total,
        }),
      ],
      "slow"
    );
  }
);

registerWriteTool(
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

registerWriteTool(
  "obsidian_task_complete",
  {
    title: "Complete a task",
    description:
      "Marks a task as done. Identify it with `ref` (\"path:line\": the `file` and `line` of an " +
      "obsidian_tasks_list entry, joined by a colon) or with `path` plus `line`. To toggle it or " +
      "set another status character, use obsidian_exec with the `task` command.",
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
// Sync & version history
// ---------------------------------------------------------------------------
//
// Reading history is exposed; restoring it is not. `history:restore` and `sync:restore`
// overwrite a note (or a whole vault) with an older copy, which is the one operation here
// that can destroy work the user never asked to touch. They stay behind obsidian_exec.

server.registerTool(
  "obsidian_sync_status",
  {
    title: "Show sync status",
    description:
      "Reports whether Obsidian Sync is connected and up to date. Worth checking before trusting " +
      "that what you just read is the latest version, and before telling the user a change of " +
      "yours has reached their other devices.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {},
  },
  async () => respond(["sync:status"], "quick")
);

server.registerTool(
  "obsidian_history",
  {
    title: "List a note's versions",
    description:
      "Lists the stored versions of a note (Obsidian's file recovery / Sync history), newest " +
      "first, with the version numbers obsidian_history_read takes. Use it to answer \"when did " +
      "this note change?\" or to find the state a note was in before an edit.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { file: fileParam, path: pathParam },
  },
  async ({ file, path }) => {
    if (!file && !path) return errorResult(MISSING_TARGET);
    return respond(["history", ...kv({ file, path })], "quick");
  }
);

server.registerTool(
  "obsidian_history_read",
  {
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
  },
  async ({ file, path, version }) => {
    if (!file && !path) return errorResult(MISSING_TARGET);
    return respond(["history:read", ...kv({ file, path, version })], "quick");
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
