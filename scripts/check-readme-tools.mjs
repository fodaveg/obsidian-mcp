/**
 * Checks the README's tool table against the tools the server actually registers.
 *
 * WHY THIS EXISTS. The table is what a reader picks tools from and what they read before
 * deciding which calls to auto-approve, and it is maintained by hand: it drifted twice in a
 * single day, both times a parameter that the code had grown and the row had not. Nothing failed
 * -- a stale table still builds, still lints and still passes every test -- so the drift was only
 * ever found by reading the table next to the code, which is exactly the thing nobody does twice.
 *
 * WHAT IT COMPARES, and why not more. It starts the server over stdio and asks for `listTools`,
 * the same list a client sees, and for every tool it compares three mechanical facts with the
 * row: the tool NAME, the set of PARAMETER names, and whether it WRITES (the tick in the last
 * column, which the README promises is exactly the set that disappears under
 * OBSIDIAN_MCP_READONLY=1). Parameters are in because names alone would have caught neither of
 * the two drifts that prompted this. Nothing else is: not the wording of the description, not the
 * order of the rows (the table groups by domain, the server registers the escape hatch first),
 * not the value lists of the enums. A check that fails for a rewording is a check somebody
 * deletes, and the point is that this one survives.
 *
 * THE ONE RULE THE TABLE HAS TO FOLLOW, so that the parameter comparison is not fragile: in the
 * "Main parameters" column, every parameter is written `like this` in backticks, and anything
 * inside parentheses is ignored -- that is where the enum values and the prose go, e.g.
 * "`format` (`tree`/`md`/`json`)" or "`ref` (`path:line`, …)". Prose that names no parameter can
 * go in the "What it does" column freely; this only reads the third one.
 *
 * It never calls a tool and never runs the `obsidian` binary, so it is safe on a machine with no
 * vault -- which is what lets it run in CI.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The header of the table to check, which is how it is found among the README's other tables. */
const TABLE_HEADER = "| Tool | What it does | Main parameters | Writes |";

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

/** Every row of the tool table, as { name, parameters, writes }, in the order it is written. */
function readTable(markdown) {
  const lines = markdown.split("\n");
  const start = lines.indexOf(TABLE_HEADER);
  if (start === -1) {
    throw new Error(
      `The README has no tool table: no line reads exactly\n  ${TABLE_HEADER}\n` +
        "Either the header changed or the table is gone; this check cannot run without it."
    );
  }

  const rows = [];
  // +2 skips the header and the |---|---| separator under it. The table ends at the first line
  // that is not a row.
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    // Split on the pipes that separate cells: an escaped \| is part of a cell ("`file` \| `path`").
    const cells = line.split(/(?<!\\)\|/).slice(1, -1);
    if (cells.length !== 4) {
      throw new Error(`Row with ${cells.length} cells instead of 4, which this check cannot read:\n  ${line}`);
    }
    const [tool, , parameters, writes] = cells;
    const name = tool.match(/`([^`]+)`/)?.[1];
    if (!name) throw new Error(`Row whose first cell names no tool in backticks:\n  ${line}`);
    rows.push({ name, parameters: parametersOf(parameters), writes: writes.includes("✔") });
  }

  if (rows.length === 0) throw new Error("The README's tool table has a header and no rows.");
  return rows;
}

// ---------------------------------------------------------------------------
// The server side
// ---------------------------------------------------------------------------

/**
 * The registered tools as the client sees them. The escape hatch is enabled on purpose: it has a
 * row in the table, so the check has to see it too. Read-only mode is forced off for the same
 * reason -- the writers have rows -- and because an operator's own environment must not change
 * what this reports.
 */
async function listTools() {
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
    const { tools } = await client.listTools();
    return tools.map((tool) => ({
      name: tool.name,
      parameters: new Set(Object.keys(tool.inputSchema?.properties ?? {})),
      // The declared `writes` is not in the wire format; readOnlyHint is its visible shadow, and
      // it is what a client reads to decide whether a call needs confirmation. Every tool here
      // declares annotations, so an undeclared readOnlyHint means "not read-only" -- a writer.
      writes: tool.annotations?.readOnlyHint !== true,
    }));
  } finally {
    await client.close();
  }
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

// ---------------------------------------------------------------------------

const rows = readTable(readFileSync(join(root, "README.md"), "utf8"));
const tools = await listTools();
const problems = compare(rows, tools);

if (problems.length > 0) {
  console.error(
    `README.md is out of sync with the registered tools (${problems.length} ${problems.length === 1 ? "problem" : "problems"}):\n`
  );
  for (const problem of problems) console.error(`  ${problem}\n`);
  console.error(
    "The table lives under \"## Included tools\" in README.md. Parameters go in the third column,\n" +
      "each one in `backticks`; anything in parentheses is ignored, so enum values and prose\n" +
      "belong there."
  );
  process.exit(1);
}

console.log(`README.md matches the ${tools.length} registered tools: names, parameters and the Writes column.`);
