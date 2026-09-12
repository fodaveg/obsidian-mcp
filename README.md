# obsidian-mcp

An MCP server that wraps the **official Obsidian CLI** (`obsidian`, see
https://obsidian.md/help/cli) and exposes your vault as a set of tools that any
MCP client (Claude Desktop, Claude Code, etc.) can use.

Each tool translates its parameters into a call to the `obsidian` binary and
returns the result to the model. Because every operation goes through Obsidian's
internal API, wikilinks and the index stay up to date automatically — the
underlying filesystem is never touched directly.

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

## Tests

```bash
npm test
```

Builds `src/` and runs the unit tests (Node's built-in test runner, no extra
dependencies) over the pure helpers — path building and CLI argument
formatting. They never touch your vault or invoke the `obsidian` binary.

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
| `OBSIDIAN_VAULT` | Which vault to use when you have several open | (none) |
| `OBSIDIAN_CLI_TIMEOUT_MS` | Timeout per CLI call | `20000` |
| `OBSIDIAN_MCP_DISABLE_EXEC` | If `1`, removes the `obsidian_exec` tool (see security below) | (empty) |

## Included tools

**Escape hatch:** `obsidian_exec` runs any CLI subcommand directly (`files`,
`folders`, `links`, `orphans`, `unresolved`, `tags:rename`, `plugin:enable`,
`publish:list`, `sync:status`, `history`, `eval`, `dev:*`, etc.) — it covers
everything without a dedicated tool.

**Notes:** `obsidian_read`, `obsidian_create`, `obsidian_append`,
`obsidian_prepend`, `obsidian_move`, `obsidian_delete`, `obsidian_list_files`,
`obsidian_list_folders`.

**Search:** `obsidian_search` (supports filters such as `[tag:project]`,
`[status:active]`, `[priority:>3]` inside the query).

**Daily notes:** `obsidian_daily_read`, `obsidian_daily_append`,
`obsidian_daily_prepend`.

**Properties (frontmatter):** `obsidian_properties_get`,
`obsidian_properties_set`, `obsidian_properties_remove`.

**Tags and links:** `obsidian_tags`, `obsidian_backlinks`, `obsidian_links`,
`obsidian_orphans`, `obsidian_unresolved_links`.

**Tasks:** `obsidian_tasks_list`, `obsidian_task_create`,
`obsidian_task_complete`.

## Security note

`obsidian_exec` (and, within it, commands like `eval` or `dev:*`) can run
arbitrary JavaScript inside your Obsidian instance or inspect its UI. If you'd
rather expose only the curated set of tools above, start the server with
`OBSIDIAN_MCP_DISABLE_EXEC=1`.

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
  index.ts   -> MCP server definition and all the tools
scripts/
  smoke-test.mjs -> quick manual test without needing an MCP client
  paths.test.mjs -> unit tests for the pure helpers (`npm test`)
```

## Disclaimer

This is an independent, community-built project. It is **not affiliated with,
endorsed by, sponsored by, or associated with Obsidian, Obsidian.md, or Dynalist
Inc.** in any way. "Obsidian" is a trademark of its respective owner; it is used
here only to describe interoperability. This software wraps the official Obsidian
CLI and is provided "as is", without warranty of any kind (see the license). You
are responsible for any changes it makes to your vault — back up your data and
review the security note above before enabling `obsidian_exec`.

## License

MIT © fodaveg
