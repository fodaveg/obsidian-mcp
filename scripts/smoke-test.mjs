import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
});

const client = new Client({ name: "smoke-test", version: "0.0.1" });
await client.connect(transport);

const tools = await client.listTools();
console.log(`Registered ${tools.tools.length} tools:`);
for (const t of tools.tools) console.log(" -", t.name);

// Only the templates, not resources/list: listing the vault spawns the binary, and the point of
// this script is that it still says something useful on a machine with no Obsidian at all.
const templates = await client.listResourceTemplates();
console.log(`\nResource templates (${templates.resourceTemplates.length}):`);
for (const t of templates.resourceTemplates) console.log(" -", t.uriTemplate);

console.log("\nCalling obsidian_read without the CLI installed (expect a graceful error)...");
const result = await client.callTool({ name: "obsidian_read", arguments: { file: "Test" } });
console.log(JSON.stringify(result, null, 2));

await client.close();
