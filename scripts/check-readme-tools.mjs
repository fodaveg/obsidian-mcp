/**
 * Checks the README against what the server actually offers: the tool table, and the resources.
 *
 * WHY THIS EXISTS. The table is what a reader picks tools from and what they read before
 * deciding which calls to auto-approve, and it is maintained by hand: it drifted twice in a
 * single day, both times a parameter that the code had grown and the row had not. Nothing failed
 * -- a stale table still builds, still lints and still passes every test -- so the drift was only
 * ever found by reading the table next to the code, which is exactly the thing nobody does twice.
 * "The vault as resources" is the same hand-written promise about a second surface, and until it
 * was added here nothing watched it at all: renaming a URI prefix left the section describing a
 * scheme that no longer existed, and every check stayed green.
 *
 * WHAT IT COMPARES, and why not more. It starts the server over stdio and asks it the questions a
 * client asks -- `listTools`, `resources/templates/list`, and the capabilities of the handshake --
 * and compares mechanical FACTS with the README:
 *
 *   * TOOLS, row by row: the tool NAME, the set of PARAMETER names, and whether it WRITES (the
 *     tick in the last column, which the README promises is exactly the set that disappears under
 *     OBSIDIAN_MCP_READONLY=1). Parameters are in because names alone would have caught neither
 *     of the two drifts that prompted this.
 *   * RESOURCES: that the `resources` capability is really declared (without it the whole section
 *     is a lie, and no client would ever ask); that the URI prefixes the section's table shows are
 *     exactly the ones `src/resources.ts` exports; that every resource template the server
 *     declares is one of those documented URIs, and every documented URI is backed by a template;
 *     and that every environment variable the section names exists in the built code.
 *
 * Nothing else is: not the wording of the description, not the order of the rows (the table groups
 * by domain, the server registers the escape hatch first), not the value lists of the enums, not
 * the resource section's prose, its sample JSON, its measured numbers, the mime types or the
 * templates' own names and descriptions (the README documents resources by URI, and a client
 * attaches them by URI). A check that fails for a rewording is a check somebody deletes, and the
 * point is that this one survives.
 *
 * THE TWO RULES THE README HAS TO FOLLOW, so that both comparisons are about facts and not about
 * formatting:
 *
 *   * In the tool table's "Main parameters" column, every parameter is written `like this` in
 *     backticks, and anything inside parentheses is ignored -- that is where the enum values and
 *     the prose go, e.g. "`format` (`tree`/`md`/`json`)" or "`ref` (`path:line`, …)". Prose that
 *     names no parameter can go in the "What it does" column freely; this only reads the third one.
 *   * In the resource table, each row's first cell holds one URI in backticks and the variable
 *     part is written as a `<placeholder>`: everything from the first `<` on is ignored, which is
 *     what makes the documented `obsidian://note/<path>` comparable with the exported prefix
 *     `obsidian://note/` and with the template `obsidian://note/{+path}`. Environment variables
 *     are named in backticks too, wherever the section mentions them.
 *
 * It never calls a tool, never reads a resource and never runs the `obsidian` binary, so it is
 * safe on a machine with no vault -- which is what lets it run in CI.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The header of the table to check, which is how it is found among the README's other tables. */
const TABLE_HEADER = "| Tool | What it does | Main parameters | Writes |";

/** The section that documents the resources, and the header of the table of URIs inside it. */
const RESOURCES_HEADING = "## The vault as resources";
const URI_TABLE_HEADER = "| URI | What you get |";

// ---------------------------------------------------------------------------
// The README side
// ---------------------------------------------------------------------------

/** The backticked parameter names of a "Main parameters" cell, ignoring parenthesised text. */
function parametersOf(cell) {
  const withoutParentheses = cell.replace(/\([^()]*\)/g, " ");
  const names = [...withoutParentheses.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  // Only plain identifiers are parameter names. This drops the stray `like:this` or `--flag`
  // that prose outside parentheses might carry, instead of reporting it as a phantom parameter.
  return new Set(names.filter((name) => /^[A-Za-z][A-Za-z0-9]*$/.test(name)));
}

/** The rows of the table under `header`, each one as its array of cells. */
function tableRows(lines, header, what) {
  const start = lines.indexOf(header);
  if (start === -1) {
    throw new Error(
      `The README has no ${what}: no line reads exactly\n  ${header}\n` +
        "Either the header changed or the table is gone; this check cannot run without it."
    );
  }

  const rows = [];
  // +2 skips the header and the |---|---| separator under it. The table ends at the first line
  // that is not a row.
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    // Split on the pipes that separate cells: an escaped \| is part of a cell ("`file` \| `path`").
    rows.push({ line, cells: line.split(/(?<!\\)\|/).slice(1, -1) });
  }

  if (rows.length === 0) throw new Error(`The README's ${what} has a header and no rows.`);
  return rows;
}

/** Every row of the tool table, as { name, parameters, writes }, in the order it is written. */
function readTable(markdown) {
  const rows = [];
  for (const { line, cells } of tableRows(markdown.split("\n"), TABLE_HEADER, "tool table")) {
    if (cells.length !== 4) {
      throw new Error(`Row with ${cells.length} cells instead of 4, which this check cannot read:\n  ${line}`);
    }
    const [tool, , parameters, writes] = cells;
    const name = tool.match(/`([^`]+)`/)?.[1];
    if (!name) throw new Error(`Row whose first cell names no tool in backticks:\n  ${line}`);
    rows.push({ name, parameters: parametersOf(parameters), writes: writes.includes("✔") });
  }
  return rows;
}

/** The text of the "The vault as resources" section, down to the next `## ` heading. */
function readResourcesSection(markdown) {
  const lines = markdown.split("\n");
  const start = lines.indexOf(RESOURCES_HEADING);
  if (start === -1) {
    throw new Error(
      `The README has no resources section: no line reads exactly\n  ${RESOURCES_HEADING}\n` +
        "Either the heading changed or the section is gone; this check cannot run without it."
    );
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/**
 * The URI prefixes the section's table documents, each one mapped to the URI it was written as,
 * so a problem can quote the row a reader would see.
 *
 * The prefix is the URI up to its `<placeholder>`: `obsidian://note/<path>` documents the prefix
 * `obsidian://note/`, and `obsidian://folder/` (the vault root, which has no placeholder) is a
 * prefix already. Several rows may document the same prefix -- the folder table has two -- which
 * is why this is a prefix -> [written URIs] map and not a list.
 */
function readUriTable(section) {
  const documented = new Map();
  for (const { line, cells } of tableRows(section.split("\n"), URI_TABLE_HEADER, "table of resource URIs")) {
    if (cells.length !== 2) {
      throw new Error(`Resource row with ${cells.length} cells instead of 2:\n  ${line}`);
    }
    const uri = cells[0].match(/`([^`]+)`/)?.[1];
    if (!uri) throw new Error(`Resource row whose first cell names no URI in backticks:\n  ${line}`);
    const prefix = uri.split("<")[0];
    if (!documented.has(prefix)) documented.set(prefix, []);
    documented.get(prefix).push(uri);
  }
  return documented;
}

/** The environment variables the section names, in backticks (`NAME` or `NAME=value`). */
function environmentVariablesIn(section) {
  const names = [...section.matchAll(/`(OBSIDIAN_[A-Z0-9_]+)[^`]*`/g)].map((m) => m[1]);
  return new Set(names);
}

// ---------------------------------------------------------------------------
// The server side
// ---------------------------------------------------------------------------

/**
 * What the server tells a client about itself: its tools, its resource templates and the
 * capabilities it declared in the handshake. The escape hatch is enabled on purpose: it has a row
 * in the table, so the check has to see it too. Read-only mode is forced off for the same reason
 * -- the writers have rows -- and because an operator's own environment must not change what this
 * reports. One connection answers everything; no call reaches the `obsidian` binary.
 */
async function askTheServer() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "dist", "index.js")],
    env: {
      ...process.env,
      OBSIDIAN_MCP_ENABLE_EXEC: "1",
      OBSIDIAN_MCP_DISABLE_EXEC: "",
      OBSIDIAN_MCP_READONLY: "",
    },
  });

  const client = new Client({ name: "check-readme-tools", version: "0.0.1" });
  await client.connect(transport);
  try {
    const capabilities = client.getServerCapabilities() ?? {};
    const { tools } = await client.listTools();
    // Asking for the templates only makes sense if the server said it has resources; without the
    // capability the request is an error, and the missing capability is the problem to report.
    const { resourceTemplates } = capabilities.resources
      ? await client.listResourceTemplates()
      : { resourceTemplates: [] };

    return {
      capabilities,
      resourceTemplates,
      tools: tools.map((tool) => ({
        name: tool.name,
        parameters: new Set(Object.keys(tool.inputSchema?.properties ?? {})),
        // The declared `writes` is not in the wire format; readOnlyHint is its visible shadow, and
        // it is what a client reads to decide whether a call needs confirmation. Every tool here
        // declares annotations, so an undeclared readOnlyHint means "not read-only" -- a writer.
        writes: tool.annotations?.readOnlyHint !== true,
      })),
    };
  } finally {
    await client.close();
  }
}

/**
 * The URI prefixes the resource module exports, as { NAME: prefix }.
 *
 * Read by name pattern rather than one by one, so that a third kind of resource is compared the
 * day it is exported instead of the day somebody remembers to add it here.
 */
async function exportedUriPrefixes() {
  const module = await import(pathToFileURL(join(root, "dist", "resources.js")).href);
  return Object.fromEntries(
    Object.entries(module).filter(([name, value]) => name.endsWith("_URI_PREFIX") && typeof value === "string")
  );
}

/** Every `.js` file under `dist/`, which is the built server the README describes. */
function builtFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...builtFiles(path));
    else if (entry.name.endsWith(".js")) files.push(path);
  }
  return files;
}

/**
 * The environment variable names that appear in the built server.
 *
 * A name is looked for as text rather than as `process.env.NAME`, because the code reads most of
 * them through a helper (`readPositiveInt("OBSIDIAN_...", 200)`) and a compiled `process.env[name]`
 * names nothing. The cost is that a variable mentioned only inside an error message counts as
 * existing; the check is aimed at the opposite mistake, a README that documents a variable the
 * code never had or no longer reads.
 */
function environmentVariablesInCode() {
  const names = new Set();
  for (const file of builtFiles(join(root, "dist"))) {
    for (const match of readFileSync(file, "utf8").matchAll(/OBSIDIAN_[A-Z0-9_]+/g)) names.add(match[0]);
  }
  return names;
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

const sorted = (set) => [...set].sort();
const missingFrom = (a, b) => sorted(a).filter((item) => !b.has(item));

function compare(rows, tools) {
  const problems = [];
  const byName = new Map(rows.map((row) => [row.name, row]));

  const duplicates = rows.map((r) => r.name).filter((name, i, all) => all.indexOf(name) !== i);
  for (const name of new Set(duplicates)) {
    problems.push(`\`${name}\` has more than one row in the README table. Keep one.`);
  }

  for (const tool of tools) {
    const row = byName.get(tool.name);
    if (!row) {
      problems.push(
        `MISSING ROW: the server registers \`${tool.name}\` and the README table does not list it.\n` +
          `    Add a row with its parameters: ${sorted(tool.parameters).map((p) => `\`${p}\``).join(", ") || "—"}`
      );
      continue;
    }

    const undocumented = missingFrom(tool.parameters, row.parameters);
    const phantom = missingFrom(row.parameters, tool.parameters);
    if (undocumented.length || phantom.length) {
      const details = [];
      if (undocumented.length) {
        details.push(`in the code but not in the row: ${undocumented.map((p) => `\`${p}\``).join(", ")}`);
      }
      if (phantom.length) {
        details.push(`in the row but not in the code: ${phantom.map((p) => `\`${p}\``).join(", ")}`);
      }
      problems.push(
        `PARAMETERS: \`${tool.name}\`\n    ${details.join("\n    ")}\n` +
          `    row says:  ${sorted(row.parameters).join(", ") || "(none)"}\n` +
          `    code says: ${sorted(tool.parameters).join(", ") || "(none)"}`
      );
    }

    if (row.writes !== tool.writes) {
      problems.push(
        `WRITES COLUMN: \`${tool.name}\` ${tool.writes ? "writes to the vault, and its row has no ✔" : "is read-only, and its row is ticked as a writer"}.`
      );
    }
  }

  const registered = new Set(tools.map((tool) => tool.name));
  for (const row of rows) {
    if (!registered.has(row.name)) {
      problems.push(
        `EXTRA ROW: the README table lists \`${row.name}\` and the server registers no such tool.\n` +
          "    Remove the row, or fix its name if the tool was renamed."
      );
    }
  }

  return problems;
}

/**
 * The resources side: the capability, the URI prefixes, the templates and the variables.
 *
 * The three sources of a prefix have to agree. The code EXPORTS it, the server OFFERS it as a
 * template, and the README SHOWS it; any one of the three alone is a claim, and the section is
 * only true when all three say the same thing.
 */
function compareResources({ section, documented, capabilities, templates, prefixes, envInCode }) {
  const problems = [];

  if (!capabilities.resources) {
    problems.push(
      "CAPABILITY: the README documents resources and the server does not declare the `resources`\n" +
        "    capability in its handshake, so no client will ever ask for one. It is declared in the\n" +
        "    McpServer constructor, in src/index.ts."
    );
  }

  const exported = new Set(Object.values(prefixes));
  for (const [name, prefix] of Object.entries(prefixes)) {
    if (!documented.has(prefix)) {
      problems.push(
        `UNDOCUMENTED URI: src/resources.ts exports ${name} = \`${prefix}\` and the README's table of\n` +
          `    URIs has no row for it. Add one, writing the variable part as \`${prefix}<path>\`.`
      );
    }
  }
  for (const [prefix, written] of documented) {
    if (!exported.has(prefix)) {
      problems.push(
        `STALE URI: the README shows ${written.map((uri) => `\`${uri}\``).join(" and ")}, and the code\n` +
          `    exports no prefix \`${prefix}\`. It exports: ${sorted(exported).map((p) => `\`${p}\``).join(", ") || "(none)"}.`
      );
    }
  }

  // A template is what a client offers the user when it asks which note to attach, so a new one
  // has to reach the README. Compared by the literal part of its `uriTemplate` -- everything
  // before the `{+path}` expansion -- because that is the form the README documents.
  const templated = new Set();
  for (const template of templates) {
    const uriTemplate = template.uriTemplate ?? "";
    const prefix = uriTemplate.split("{")[0];
    templated.add(prefix);
    if (!documented.has(prefix)) {
      problems.push(
        `UNDOCUMENTED TEMPLATE: the server offers the resource template \`${uriTemplate}\` and the\n` +
          "    README's table of URIs does not describe it."
      );
    }
  }
  for (const [prefix, written] of documented) {
    if (!templated.has(prefix)) {
      problems.push(
        `TEMPLATE GONE: the README documents ${written.map((uri) => `\`${uri}\``).join(" and ")} and the\n` +
          "    server's `resources/templates/list` offers no template for it, so a client cannot\n" +
          `    discover it. Templates offered: ${sorted(templated).map((p) => `\`${p}\``).join(", ") || "(none)"}.`
      );
    }
  }

  for (const name of sorted(environmentVariablesIn(section))) {
    if (!envInCode.has(name)) {
      problems.push(
        `PHANTOM VARIABLE: the resources section documents \`${name}\` and the built server never\n` +
          "    reads it. Either it was renamed, or the section promises a knob that does not exist."
      );
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------

const markdown = readFileSync(join(root, "README.md"), "utf8");
const rows = readTable(markdown);
const section = readResourcesSection(markdown);
const documented = readUriTable(section);

const { tools, resourceTemplates, capabilities } = await askTheServer();
const prefixes = await exportedUriPrefixes();

const toolProblems = compare(rows, tools);
const resourceProblems = compareResources({
  section,
  documented,
  capabilities,
  templates: resourceTemplates,
  prefixes,
  envInCode: environmentVariablesInCode(),
});

const problems = [...toolProblems, ...resourceProblems];

if (problems.length > 0) {
  console.error(
    `README.md is out of sync with the server (${problems.length} ${problems.length === 1 ? "problem" : "problems"}):\n`
  );
  for (const problem of problems) console.error(`  ${problem}\n`);
  if (toolProblems.length > 0) {
    console.error(
      "The tool table lives under \"## Included tools\" in README.md. Parameters go in the third\n" +
        "column, each one in `backticks`; anything in parentheses is ignored, so enum values and\n" +
        "prose belong there."
    );
  }
  if (resourceProblems.length > 0) {
    console.error(
      "The resources live under \"## The vault as resources\" in README.md. Each row of its table of\n" +
        "URIs names one URI in `backticks`, with the variable part written as a `<placeholder>`;\n" +
        "everything from the `<` on is ignored, so the row is compared as a prefix."
    );
  }
  process.exit(1);
}

console.log(
  `README.md matches the ${tools.length} registered tools (names, parameters and the Writes column) ` +
    `and the ${resourceTemplates.length} resource templates (capability, URI prefixes and variables).`
);
