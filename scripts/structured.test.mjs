// Unit tests for the structured output of the tools that ask the CLI for JSON. See
// scripts/output.test.mjs for the setup: they run against the compiled output in dist/, so
// `npm test` builds first.
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { structuredData } from "../dist/structured.js";
import { taskTools } from "../dist/tools/tasks.js";
import { propertyTools } from "../dist/tools/properties.js";

/** A CliResult as cli.ts builds one, with the parsed JSON already in place. */
function cliResult(stdout, { truncatedBytes = 0 } = {}) {
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = undefined;
  }
  return { ok: true, code: 0, stdout, stderr: "", json, truncatedBytes };
}

const rows = z.array(z.unknown());

test("hands back the CLI's JSON under the declared key", () => {
  const result = cliResult('[{"path":"A.md"},{"path":"B.md"}]');
  assert.deepEqual(structuredData(result, "results", rows), {
    results: [{ path: "A.md" }, { path: "B.md" }],
  });
});

test("gives no data when the output was truncated, even if what is left still parses", () => {
  // The cap can land on a closing bracket, so the survivor can be valid JSON and still be half
  // an answer. Reporting it as structured content would make a cut listing look complete.
  const result = cliResult('[{"path":"A.md"}]', { truncatedBytes: 271_781 });
  assert.deepEqual(structuredData(result, "results", rows), {});
});

test("gives no data when the CLI answered in plain text", () => {
  assert.deepEqual(structuredData(cliResult("A.md\t2\nB.md\t1"), "results", rows), {});
  assert.deepEqual(structuredData(cliResult("42"), "results", rows), {}); // `total` answers a count
  assert.deepEqual(structuredData(cliResult(""), "results", rows), {});
});

test("gives no data when the JSON does not match the declared shape", () => {
  // A guess about the CLI's shape must degrade to text-only, never turn a good answer into an
  // error: the SDK rejects structuredContent that fails the outputSchema.
  const result = cliResult('{"unexpected":"object"}');
  assert.deepEqual(structuredData(result, "results", rows), {});
});

// --- The one shape that is measured ---------------------------------------

const tasksList = taskTools.find((tool) => tool.name === "obsidian_tasks_list");

test("the task entry schema is the measured one: four keys, line as a string", () => {
  const entry = { status: " ", text: "Call the notary", file: "33.11 Notes/A.md", line: "12" };
  assert.deepEqual(structuredData(cliResult(JSON.stringify([entry])), "tasks", tasksList.output.schema), {
    tasks: [entry],
  });

  // A number where the CLI sends a string is not the measured shape, so it stays out.
  const numeric = JSON.stringify([{ ...entry, line: 12 }]);
  assert.deepEqual(structuredData(cliResult(numeric), "tasks", tasksList.output.schema), {});

  // An extra key is tolerated: the schema is loose on purpose.
  const extra = { ...entry, tags: ["work"] };
  assert.deepEqual(structuredData(cliResult(JSON.stringify([extra])), "tasks", tasksList.output.schema), {
    tasks: [extra],
  });
});

test("a tool that can also answer in plain text says so through `when`", () => {
  assert.equal(tasksList.output.when({ json: true }), true);
  assert.equal(tasksList.output.when({ json: false }), false);
});

// --- The one answer that is an object, not a list --------------------------

const propertiesGet = propertyTools.find((tool) => tool.name === "obsidian_properties_get");

test("a note's properties come back as the object the CLI sends", () => {
  // Measured on CLI 1.14.1: `properties format=json path=<note>` answers with the frontmatter as
  // one object, values as they were written.
  const frontmatter = { jd: "12.32", tipo: "id", tags: ["car", "home"], pinned: true };
  const json = JSON.stringify(frontmatter);
  assert.deepEqual(structuredData(cliResult(json), "properties", propertiesGet.output.schema), {
    properties: frontmatter,
  });

  // A note with no frontmatter still answers with an object, and an empty one is data.
  assert.deepEqual(structuredData(cliResult("{}"), "properties", propertiesGet.output.schema), {
    properties: {},
  });

  // The YAML rendering is not JSON at all, and a list is not the shape declared: both stay out.
  assert.deepEqual(structuredData(cliResult("jd: 12.32\ntipo: id"), "properties", propertiesGet.output.schema), {});
  assert.deepEqual(structuredData(cliResult('[{"jd":"12.32"}]'), "properties", propertiesGet.output.schema), {});

  assert.equal(propertiesGet.output.when({ json: true }), true);
  assert.equal(propertiesGet.output.when({ json: false }), false);
});
