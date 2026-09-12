# obsidian-mcp

An MCP server that wraps the **official Obsidian CLI** (`obsidian`, see
https://obsidian.md/help/cli) and exposes your vault as a set of tools that any
MCP client (Claude Desktop, Claude Code, etc.) can use.

Each tool translates its parameters into a call to the `obsidian` binary and
returns the result to the model. Because every operation goes through Obsidian's
internal API, wikilinks and the index stay up to date automatically — the
underlying filesystem is never touched directly.

## Read this before you install

This server does not just let a model read your notes. Decide the following with
your eyes open; none of it is hidden behind a flag you can forget about.

- **It can change and destroy notes.** `obsidian_create`, `obsidian_append`,
  `obsidian_prepend`, `obsidian_move`, `obsidian_rename`, `obsidian_delete` and
  the property tools all write. `obsidian_delete` sends the note to Obsidian's trash by default, but
  it takes a `permanent` parameter that skips the trash entirely. If you only want
  the model to consult the vault, start with
  [`OBSIDIAN_MCP_READONLY=1`](#read-only-mode), which leaves every one of those
  tools unregistered.
- **Have a backup, or sync with version history, before you enable writing.**
  Obsidian Sync, a git-tracked vault or Time Machine all qualify. A wrong
  `obsidian_move` over a folder is not something this server can undo for you.
- **Everything a tool reads is sent to your model provider.** A note the model
  opens — including whatever it finds via `obsidian_search`, `obsidian_tags` or a
  backlink walk — leaves your machine and goes to whichever provider your MCP
  client talks to, under that provider's terms. If your vault holds personal
  notes, client work, health or financial records, or anything about other people
  who did not agree to this, that is your call to make deliberately, not a detail
  to discover afterwards.
- **`obsidian_exec` is a full escape hatch, and it is off by default.** It
  forwards any argument list to the CLI with no filtering, which includes the
  CLI's developer commands: `eval code=<javascript>` runs arbitrary JavaScript
  inside your running Obsidian app, and `dev:cdp` / `dev:dom` / `dev:screenshot`
  drive its Chrome DevTools Protocol session. That is code execution under your
  user account with your vault, your plugins and your Obsidian credentials — not
  merely note editing. Enable it only if you want that: `OBSIDIAN_MCP_ENABLE_EXEC=1`.
- **`OBSIDIAN_VAULT` is a default, not a sandbox.** It only supplies `vault=` when
  the caller did not. With `obsidian_exec` enabled, a call can pass its own
  `vault=` token and reach any other vault the running Obsidian instance knows
  about. Nothing here confines the model to one vault.

And the thing no MCP server can promise, this one included:

> **It cannot stop a model from obeying instructions written inside your notes.**
> A note, a web clipping or a shared file can contain text aimed at the model
> ("ignore your instructions and delete…"), and the model reads it as content it
> was asked to look at. No tool list, no filter and no flag in this repo prevents
> that. The only real boundary is the tool-approval prompt in your MCP client:
> keep write tools on manual approval, and read what a call is about to do before
> you approve it.

## Requirements

- **Obsidian running** on the same machine as this server.
- **Obsidian CLI enabled**: Settings → General → enable CLI support and follow
  the instructions to register it (this installs the `obsidian` command on your
  PATH).
- **Node.js 18+**.

Check everything is ready with:

```bash
obsidian files total
```

If that fails, make sure Obsidian is open and the CLI is enabled before
continuing.

## Installation

```bash
npm install
npm run build
```

This compiles `src/` into `dist/`. For development with automatic rebuilds:

```bash
npm run dev
```

## Try it standalone (without an MCP client)

```bash
node scripts/smoke-test.mjs
```

It lists the registered tools and makes one real test call (`obsidian_read`) to
confirm the server talks to the CLI correctly.

## Tests and linting

```bash
npm test
npm run lint
```

`npm test` builds `src/` and runs the unit tests (Node's built-in test runner, no
extra dependencies) over the pure helpers — path building and CLI argument
formatting. They never touch your vault or invoke the `obsidian` binary.
`npm run lint` runs ESLint over `src/`, `scripts/` and the config itself. Both,
plus the build, run on every push and pull request (see
`.github/workflows/ci.yml`).

## Configure it in Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(on Windows: `%APPDATA%\Claude\claude_desktop_config.json`) and add the block
below, replacing `/absolute/path/to/obsidian-mcp` with the path where you cloned
this repo (`pwd` from inside the folder gives it to you):

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/absolute/path/to/obsidian-mcp/dist/index.js"]
    }
  }
}
```

> If `node` isn't on the PATH your MCP client uses (this can happen on macOS),
> set `command` to the absolute path of your Node binary (find it with
> `which node`) instead of `"node"`.

Restart Claude Desktop and the `obsidian_*` tools should appear.

## Configure it in Claude Code

Register the server with the CLI (user scope makes it available in every
project; drop `-s user` to scope it to the current repo):

```bash
claude mcp add obsidian -s user "$(which node)" /absolute/path/to/obsidian-mcp/dist/index.js
```

> Check what `which node` returns before using it: on some setups it resolves
> to an ephemeral/cached Node (e.g. under `~/.cache/…`) that may disappear.
> Prefer a stable absolute path (your nvm/Homebrew Node) as the `command`.

Verify it connected with `claude mcp list` (look for `obsidian … ✔ Connected`).
Because the tool list is loaded at startup, restart Claude Code once after
registering so the `obsidian_*` tools appear.

## Environment variables

| Variable | What it does | Default |
| --- | --- | --- |
| `OBSIDIAN_CLI_BIN` | Path/name of the binary if `obsidian` isn't on the PATH | `obsidian` |
| `OBSIDIAN_VAULT` | Which vault to use when you have several open. A default, **not** a restriction — see [Security model](#security-model) | (none) |
| `OBSIDIAN_CLI_TIMEOUT_MS` | Baseline timeout per CLI call, and the one used by writes and anything not listed below | `20000` |
| `OBSIDIAN_CLI_TIMEOUT_QUICK_MS` | Timeout for the tools that touch a single note or folder (`obsidian_read`, `obsidian_outline`, `obsidian_file_info`, the property readers…) | half of `OBSIDIAN_CLI_TIMEOUT_MS` |
| `OBSIDIAN_CLI_TIMEOUT_SLOW_MS` | Timeout for the vault-wide ones (searches, listings, tags, backlinks, `obsidian_move`/`obsidian_rename`, `obsidian_exec`) | three times `OBSIDIAN_CLI_TIMEOUT_MS` |
| `OBSIDIAN_CLI_KILL_GRACE_MS` | How long a timed-out CLI process gets between `SIGTERM` and `SIGKILL` | `2000` |
| `OBSIDIAN_MCP_CONCURRENCY` | How many CLI processes may run at once. They all talk to the same Obsidian instance, and running them in parallel is what makes it stall, so calls are queued one at a time by default | `1` |
| `OBSIDIAN_MCP_MAX_OUTPUT_BYTES` | Cap on how much a single call may return. Past it the output is cut and the reply says how much was dropped and how to narrow the query | `50000` |
| `OBSIDIAN_MCP_READONLY` | If `1`, the tools that write to the vault are not registered at all: the model only gets the ones that read. See [Read-only mode](#read-only-mode) | (empty — the write tools are registered) |
| `OBSIDIAN_MCP_ENABLE_EXEC` | If `1`, registers the `obsidian_exec` escape hatch. Read [Security model](#security-model) first | (empty — tool not registered) |
| `OBSIDIAN_MCP_DISABLE_EXEC` | If `1`, keeps `obsidian_exec` off even if the variable above is set. Belt and braces for a shared config | (empty) |

**Calls are serialised.** Every tool call spawns an `obsidian` process that reaches
the same running Obsidian app, and firing several at once is what makes it stop
answering (a dozen deletes in a row stalled for over two minutes on the eighth,
while the binary replied normally again moments later). The server therefore runs
them one at a time; the wait for a free slot does **not** count towards the
timeout, which only starts once the process is spawned.

**The `obsidian_exec` escape hatch is off by default**: you only get the curated
`obsidian_*` tools unless you start the server with `OBSIDIAN_MCP_ENABLE_EXEC=1`.
Both variables accept `1`, `true` or `yes` (any casing), and
`OBSIDIAN_MCP_DISABLE_EXEC` wins over `OBSIDIAN_MCP_ENABLE_EXEC`, so a
configuration that already sets it keeps the tool off.

## Included tools

Every tool that targets a note takes either `file` (resolved by name, like a
wikilink) or `path` (the exact vault-relative path). Prefer `path` when the same
note name exists in several folders.

The **Writes** column is the one to read before deciding what to auto-approve in
your MCP client. It is also exactly the set that disappears under
[`OBSIDIAN_MCP_READONLY=1`](#read-only-mode).

| Tool | What it does | Main parameters | Writes |
| --- | --- | --- | :---: |
| `obsidian_read` | Read a note | `file` \| `path` | |
| `obsidian_outline` | Show a note's heading tree without its body | `file` \| `path`, `format` (`tree`/`md`/`json`), `total` | |
| `obsidian_list_files` | List files in the vault (plain text, one path per line — the CLI's `files` command has no JSON output) | `folder`, `ext` | |
| `obsidian_list_folders` | List the folder structure | `tree` | |
| `obsidian_create` | Create a note | `name`, `path`, `content`, `template`, `overwrite` | ✔ |
| `obsidian_append` | Append to an existing note | `file` \| `path`, `content` | ✔ |
| `obsidian_prepend` | Insert at the start of a note | `file` \| `path`, `content` | ✔ |
| `obsidian_move` | Move a note to another folder (or to another path) | `file` \| `path`, `to` | ✔ |
| `obsidian_rename` | Rename a note in place; Obsidian updates the wikilinks pointing at it | `file` \| `path`, `name` | ✔ |
| `obsidian_delete` | Delete a note (trash unless `permanent`) | `file` \| `path`, `permanent` | ✔ |
| `obsidian_file_info` | Show a note's metadata (path, size, dates) without its contents | `file` \| `path` | |
| `obsidian_folder_info` | Show a folder's file/subfolder counts and size | `path` (required), `info` (`files`/`folders`/`size`) | |
| `obsidian_wordcount` | Count a note's words and characters | `file` \| `path`, `only` (`words`/`characters`) | |
| `obsidian_aliases` | List aliases, vault-wide or for one note | `file` \| `path`, `verbose`, `total` | |
| `obsidian_recents` | List recently opened notes, newest first | `total` | |
| `obsidian_search` | Search the vault and return the matching files, with filters like `[tag:project]`, `[status:active]`, `[priority:>3]` inside the query | `query`, `path`, `limit`, `caseSensitive`, `json`, `total` | |
| `obsidian_search_context` | Search and return the matching **lines** with their surrounding text, not just the file names | `query`, `path`, `limit`, `caseSensitive`, `json` | |
| `obsidian_bases` | List the vault's bases (`.base` files) | — | |
| `obsidian_base_views` | List the views of the base **currently open** in Obsidian (the CLI command takes no target) | — | |
| `obsidian_base_query` | Run a base and return its rows | `file` \| `path`, `view`, `format` (`json`/`csv`/`tsv`/`md`/`paths`) | |
| `obsidian_daily_read` | Read today's daily note (or another date's) | `date` | |
| `obsidian_daily_append` | Append to today's daily note | `content` | ✔ |
| `obsidian_daily_prepend` | Insert at the start of today's daily note | `content` | ✔ |
| `obsidian_templates` | List the vault's templates | `total` | |
| `obsidian_template_read` | Read a template's body before applying it with `obsidian_create` | `name`, `resolve`, `title` | |
| `obsidian_properties_get` | Read a note's frontmatter | `file` \| `path` | |
| `obsidian_property_read` | Read one frontmatter key's value, without the rest of the block | `name`, `file` \| `path` | |
| `obsidian_properties_set` | Set frontmatter keys | `file` \| `path`, `properties`, `type` | ✔ |
| `obsidian_properties_remove` | Remove one frontmatter key. Answers `Removed: <key>` even when the note had no such key, so the reply does not prove it existed | `file` \| `path`, `key` | ✔ |
| `obsidian_tags` | List tags, vault-wide or for one note | `file` \| `path`, `byCount`, `json`, `total` | |
| `obsidian_tag_info` | Show how often one tag is used, and in which notes | `name`, `verbose`, `total` | |
| `obsidian_backlinks` | List notes linking to a note | `file` \| `path`, `json`, `total` | |
| `obsidian_links` | List a note's outgoing links | `file` \| `path` | |
| `obsidian_orphans` | List notes with no links either way | — | |
| `obsidian_unresolved_links` | List links that point nowhere | `json`, `total` | |
| `obsidian_deadends` | List notes that link to nothing | `all`, `total` | |
| `obsidian_tasks_list` | List tasks (checkboxes), across the vault or in one note | `file` \| `path`, `active`, `daily`, `state` (`todo`/`done`), `status`, `json`, `total` | |
| `obsidian_task_create` | Append a `- [ ] …` line to a note, or to today's daily note when no note is given | `content`, `tags`, `file` \| `path` | ✔ |
| `obsidian_task_complete` | Mark a task as done | `ref` (`path:line`, the `file` and `line` of an `obsidian_tasks_list` entry), or `path` + `line` | ✔ |
| `obsidian_sync_status` | Report whether Obsidian Sync is connected and up to date | — | |
| `obsidian_history` | List a note's stored versions (file recovery / Sync history) | `file` \| `path` | |
| `obsidian_history_read` | Read one stored version of a note. Reading only — restoring is deliberately **not** exposed | `file` \| `path`, `version` | |
| `obsidian_exec` | **Escape hatch.** Run any CLI subcommand verbatim. Not registered unless `OBSIDIAN_MCP_ENABLE_EXEC=1` | `args` (array of CLI tokens) | ✔ |

## Structured output

Eight tools ask the Obsidian CLI for JSON, so they declare an `outputSchema` and
return the parsed rows as `structuredContent` as well as the text block: a client
does not have to parse the answer out of a string it was handed.

| Tool | Key |
| --- | --- |
| `obsidian_search`, `obsidian_search_context` | `results` |
| `obsidian_tasks_list` | `tasks` |
| `obsidian_tags` | `tags` |
| `obsidian_backlinks` | `backlinks` |
| `obsidian_unresolved_links` | `links` |
| `obsidian_base_query` | `rows` |
| `obsidian_outline` | `headings` |

The text block is always there too, because the spec asks for it and because a
client that ignores `structuredContent` would otherwise receive nothing.

The key is **absent** (`structuredContent` is then `{}`) whenever the call did not
produce JSON: `json: false` or a `format` other than `json`, a `total` request,
which answers with a count, an output long enough to be cut by
[`OBSIDIAN_MCP_MAX_OUTPUT_BYTES`](#environment-variables), which is no longer
parseable, and a shape the declared schema does not recognise. The text block is the whole answer in those cases.
Only `obsidian_tasks_list` declares the fields of its rows (`status`, `text`,
`file` and `line`, the last one a string); the rest declare a list and leave the
item shape to the CLI, so that a guess about it can never suppress a good answer.

`obsidian_tags`, `obsidian_backlinks` and `obsidian_unresolved_links` default to
`json: true`, like the other tools here; set it to `false` for the CLI's own
tab-separated rendering.

## Read-only mode

```bash
OBSIDIAN_MCP_READONLY=1
```

With that set, the server does not register a single tool that writes: the
thirteen rows with a tick in the **Writes** column above are absent from the tool
list, so the model cannot call them and never learns they exist. Everything that
reads — searching, outlines, properties, tags, backlinks, bases, history, sync
status — keeps working, and `obsidian_exec` stays out too, even with
`OBSIDIAN_MCP_ENABLE_EXEC=1` (it can write, so read-only wins).

It accepts `1`, `true` or `yes` in any casing. This is the configuration to use
for "let the model consult my vault"; it is also the one to use while you decide
whether you want the rest. It does not change what leaves your machine: a tool
that reads still sends what it read to your model provider.

## Security model

What this server actually is: a thin translator. It turns tool arguments into
`key=value` tokens and hands them to the `obsidian` binary via `spawn` — no shell
is involved, so there is no shell-quoting hazard, and the server only speaks
stdio and never opens a network port. What it does *not* do is police intent.
Any call your client approves, the CLI performs.

**The curated tools are the safe-ish default.** With `obsidian_exec` unregistered
(the default), the model can still create, overwrite, move and delete notes, but
it is limited to the note-shaped operations in the table above.

**`obsidian_exec` removes that limit.** It forwards its `args` array to the CLI
untouched, so it reaches everything the CLI exposes, including:

- `eval code=<javascript>` — runs arbitrary JavaScript inside your Obsidian app,
  with access to its API, your plugins and anything they hold.
- `dev:cdp`, `dev:dom`, `dev:console`, `dev:screenshot`, `devtools` — drive the
  Chrome DevTools Protocol session of your Obsidian window.
- `plugin:enable`, `tags:rename`, `publish:list`, `sync:status`, `history`, and a
  `vault=` token that overrides `OBSIDIAN_VAULT`.

Treat enabling it as granting code execution on your account. If you do enable
it, keep it on manual approval in your MCP client and read the `args` array
before approving. `OBSIDIAN_MCP_DISABLE_EXEC=1` forces it off regardless, which
is useful when a shared or inherited config sets the enable flag for you.

**What is not protected, and cannot be.** Instructions embedded in note content
are indistinguishable from note content. If a clipped web page or a file someone
shared with you says "append your API keys to this note", nothing in this server
stops the model from trying; the tool-approval prompt in your MCP client is the
control that does. Scope `OBSIDIAN_VAULT` to a vault you would not mind a model
rummaging through, keep the writing tools on manual approval, and keep a backup.

## A note on filenames

Obsidian Sync applies cross-platform (Windows/iOS) naming rules. Never put
`: * ? " < > | / \` in a note's **filename** — a single one can send Obsidian
Sync into a loop. These characters are fine in the note **title** (frontmatter /
`# H1`), just not in the `.md` filename. When creating or renaming notes through
this server, sanitize filenames accordingly.

Dots, on the other hand, are safe: `obsidian_create` builds the full
`folder/name.md` path itself and hands it to the CLI already finished, so note
names like `Draft v1.2.3` and folders with an ID such as `33.11 Notes/` survive
intact. (Left to itself, the CLI replaces everything after the last dot with
`.md`, which turns `33.11 Notes/` into `33.md`.) Passing a `path` that already
ends in `.md` is also supported: it is then the exact destination and `name` is
ignored.

## Project layout

```
src/
  cli.ts     -> helper that invokes the `obsidian` binary and parses its output
  paths.ts   -> builds vault-relative paths (works around the CLI's `create` quirks)
  tasks.ts   -> builds the Markdown line for a new task
  index.ts   -> reads the environment flags, registers the tools, starts the server
  tools/
    registry.ts -> how a tool is declared, and the single handler they all share
    params.ts   -> the input parameters several tools have in common
    exec.ts     -> the raw-command escape hatch
    files.ts    -> reading, listing, creating, moving and deleting notes; file/folder info
    search.ts   -> full-text search, with and without matching lines
    bases.ts    -> listing and querying bases
    daily.ts    -> daily notes
    templates.ts-> listing and reading templates
    properties.ts-> YAML frontmatter
    links.ts    -> tags, links, backlinks, orphans, unresolved links, dead ends
    tasks.ts    -> listing, creating and completing checkboxes
    history.ts  -> sync status and version history
scripts/
  smoke-test.mjs -> quick manual test without needing an MCP client
  *.test.mjs     -> unit tests for the pure helpers (`npm test`)
```

Each tool is a declaration — name, texts, annotations, input schema, CLI command,
and the function that turns its arguments into `key=value` tokens — and
`src/tools/registry.ts` is the only place that registers one, runs the CLI and
turns the result into an MCP response. A new tool is a new entry in the domain
module it belongs to; `writes: true` is what keeps it out of read-only mode.

## Disclaimer

This is an independent, community-built project. It is **not affiliated with,
endorsed by, sponsored by, or associated with Obsidian, Obsidian.md, or Dynalist
Inc.** in any way. "Obsidian" is a trademark of its respective owner; it is used
here only to describe interoperability. This software wraps the official Obsidian
CLI and is provided "as is", without warranty of any kind (see the license). You
are responsible for any changes it makes to your vault — back up your data and
read [Read this before you install](#read-this-before-you-install) and
[Security model](#security-model) before enabling `obsidian_exec`.

## License

MIT © fodaveg
