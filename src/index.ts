#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerResources } from "./resources.js";
import { registerTools } from "./tools/registry.js";
import { execTools } from "./tools/exec.js";
import { fileTools } from "./tools/files.js";
import { searchTools } from "./tools/search.js";
import { baseTools } from "./tools/bases.js";
import { dailyTools } from "./tools/daily.js";
import { templateTools } from "./tools/templates.js";
import { propertyTools } from "./tools/properties.js";
import { linkTools } from "./tools/links.js";
import { taskTools } from "./tools/tasks.js";
import { historyTools } from "./tools/history.js";

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
// this server purely for consulting a vault. Which tools those are is declared by `writes` on
// each tool; registerTools is what leaves them out.
const READONLY = envFlag("OBSIDIAN_MCP_READONLY");

const server = new McpServer(
  {
    name: "obsidian-mcp",
    version: "0.1.0",
  },
  {
    // Declared here rather than left to the SDK, because src/resources.ts registers the three
    // resource requests on the low-level server by hand (it needs the `cursor` that
    // McpServer.registerResource's own list handler throws away). Nothing else announces them,
    // so without this line a client would never ask for a resource at all.
    //
    // `listChanged` is deliberately absent: this server watches nothing and sends no
    // notifications, and claiming otherwise would have clients waiting for one.
    capabilities: { resources: {} },
  }
);

// The tools, by domain, in the order the client sees them. Each module declares its own; the
// format and the one handler they all share live in src/tools/registry.ts.
registerTools(
  server,
  [
    ...(ENABLE_EXEC ? execTools : []),
    ...fileTools,
    ...searchTools,
    ...baseTools,
    ...dailyTools,
    ...templateTools,
    ...propertyTools,
    ...linkTools,
    ...taskTools,
    ...historyTools,
  ],
  { readonly: READONLY }
);

// The vault as resources: every note readable by URI, the folder tree walkable one level at a
// time. Registered unconditionally -- reading is all a resource can do, so OBSIDIAN_MCP_READONLY
// has nothing to take away here, and the exec flag is about a tool, not about notes.
registerResources(server);

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
