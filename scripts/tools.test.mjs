// Unit tests for the CLI tokens a declared tool builds. See scripts/output.test.mjs for the
// setup: they run against the compiled output in dist/, so `npm test` builds first.
//
// A parameter that is declared in the inputSchema and then forgotten in `tokens` is invisible --
// the tool still answers, just without the option the model asked for -- so the tools whose
// options were widened get their argv checked here.
import test from "node:test";
import assert from "node:assert/strict";

import { fileTools } from "../dist/tools/files.js";
import { linkTools } from "../dist/tools/links.js";
import { propertyTools } from "../dist/tools/properties.js";
import { taskTools } from "../dist/tools/tasks.js";
import { registerTools } from "../dist/tools/registry.js";

const byName = (specs, name) => specs.find((spec) => spec.name === name);

const listFolders = byName(fileTools, "obsidian_list_folders");
const move = byName(fileTools, "obsidian_move");
const rename = byName(fileTools, "obsidian_rename");
const aliases = byName(fileTools, "obsidian_aliases");
const orphans = byName(linkTools, "obsidian_orphans");
const deadends = byName(linkTools, "obsidian_deadends");
const tags = byName(linkTools, "obsidian_tags");
const unresolved = byName(linkTools, "obsidian_unresolved_links");
const propertiesGet = byName(propertyTools, "obsidian_properties_get");
const propertiesList = byName(propertyTools, "obsidian_properties_list");
const tasksList = byName(taskTools, "obsidian_tasks_list");

test("obsidian_list_folders forwards the folder filter and the count", () => {
  assert.deepEqual(listFolders.tokens({ folder: undefined, total: false }), []);
  assert.deepEqual(listFolders.tokens({ folder: "33 Notes", total: false }), ["folder=33 Notes"]);
  assert.deepEqual(listFolders.tokens({ folder: undefined, total: true }), ["total"]);
});

// `folders` has no `format` token at all (its CLI help lists `folder` and `total`, and
// `format=tree` measured byte-identical to a plain call), so nothing here may ask for one.
test("obsidian_list_folders never asks the CLI for a format", () => {
  assert.equal("tree" in listFolders.inputSchema, false);
  assert.deepEqual(
    listFolders.tokens({ folder: "33 Notes", total: true }).filter((t) => t.startsWith("format=")),
    []
  );
});

test("both link-health listings forward `all` as the bare token the CLI takes", () => {
  assert.deepEqual(orphans.tokens({ all: false, total: false }), []);
  assert.deepEqual(orphans.tokens({ all: true, total: true }), ["all", "total"]);
  assert.deepEqual(deadends.tokens({ all: true, total: false }), ["all"]);
});

test("obsidian_properties_get asks for JSON by default and for nothing when told not to", () => {
  assert.deepEqual(propertiesGet.tokens({ file: "My Note", path: undefined, json: true }), [
    "file=My Note",
    "format=json",
  ]);
  // `json: false` leaves the format out, which is the CLI's own default of yaml.
  assert.deepEqual(propertiesGet.tokens({ file: undefined, path: "A/B.md", json: false }), [
    "path=A/B.md",
  ]);
});

// ---------------------------------------------------------------------------
// The filename rules on the two tools that also compose a filename.
// Creating a note is not the only way to produce one: a rename and a move to a full path make
// the same name, and the same character sends Obsidian Sync into the same loop whichever tool
// wrote it (measured 18 Jul 2026). See scripts/paths.test.mjs for the rules themselves.
// ---------------------------------------------------------------------------

const SYNC_HOSTILE = [":", "*", "?", '"', "<", ">", "|", "\\"];

test("obsidian_rename refuses every character Obsidian Sync cannot live with", () => {
  for (const character of SYNC_HOSTILE) {
    assert.throws(
      () => rename.tokens({ file: "Nota A", path: undefined, name: `Planificación${character} 3` }),
      new RegExp(`contains the character \\${character}`),
      `"${character}" should be rejected in a new note name`
    );
  }
  assert.throws(
    () => rename.tokens({ file: "Nota A", path: undefined, name: "Nota\tcon tabulador" }),
    /control character U\+0009/
  );
});

test("obsidian_rename sends a slash back to obsidian_move, not to `path`", () => {
  // `path` addresses the note being renamed, so create's advice ("pass the folder in `path`")
  // would be wrong here: a rename cannot change folder at all.
  assert.throws(
    () => rename.tokens({ file: "Nota A", path: undefined, name: "Archivo/Nota A" }),
    /use obsidian_move/
  );
  assert.throws(
    () => rename.tokens({ file: "Nota A", path: undefined, name: "Archivo/Nota A" }),
    (error) => !/Pass the folder in `path`/.test(error.message)
  );
});

test("obsidian_rename passes an ordinary new name straight through", () => {
  // Dots are not the problem, and the name reaches the CLI exactly as typed: this server does
  // not add ".md" on rename the way it builds the full path on create.
  assert.deepEqual(
    rename.tokens({ file: "Nota A", path: undefined, name: "00.05 Instrucciones para agentes" }),
    ["file=Nota A", "name=00.05 Instrucciones para agentes"]
  );
  assert.deepEqual(
    rename.tokens({ file: undefined, path: "Inbox/Nota A.md", name: "Smart Notes - Resumen (Ahrens) v1.2" }),
    ["path=Inbox/Nota A.md", "name=Smart Notes - Resumen (Ahrens) v1.2"]
  );
});

test("obsidian_move refuses those characters in a destination FILENAME", () => {
  for (const character of SYNC_HOSTILE) {
    assert.throws(
      () => move.tokens({ file: "Nota A", path: undefined, to: `Archivo/2026/Plan${character} 3.md` }),
      new RegExp(`contains the character \\${character}`),
      `"${character}" should be rejected in a destination filename`
    );
  }
  assert.throws(
    () => move.tokens({ file: "Nota A", path: undefined, to: "Archivo/Nota\tA.md" }),
    /control character U\+0009/
  );
});

test("obsidian_move leaves the folders of `to` alone", () => {
  // A folder carrying one of these already exists in the user's vault; we are not creating it,
  // and refusing to address it would break notes that work today.
  assert.deepEqual(move.tokens({ file: "Nota A", path: undefined, to: "Proyecto: 2026/" }), [
    "file=Nota A",
    "to=Proyecto: 2026/",
  ]);
  assert.deepEqual(move.tokens({ file: "Nota A", path: undefined, to: "Proyecto: 2026/Sub|carpeta" }), [
    "file=Nota A",
    "to=Proyecto: 2026/Sub|carpeta",
  ]);
  // Same folder, now with a filename after it: the filename is checked, the folder still is not.
  assert.deepEqual(move.tokens({ file: "Nota A", path: undefined, to: "Proyecto: 2026/Nota A.md" }), [
    "file=Nota A",
    "to=Proyecto: 2026/Nota A.md",
  ]);
  assert.throws(
    () => move.tokens({ file: "Nota A", path: undefined, to: "Proyecto: 2026/Nota: A.md" }),
    /contains the character :/
  );
});

test("obsidian_move forwards a dotted destination unchanged", () => {
  assert.deepEqual(
    move.tokens({
      file: undefined,
      path: "Inbox/Nota A.md",
      to: "33.11 Notas/00.05 Instrucciones para agentes.md",
    }),
    ["path=Inbox/Nota A.md", "to=33.11 Notas/00.05 Instrucciones para agentes.md"]
  );
});

// ---------------------------------------------------------------------------
// The options the tools grew to match the CLI's own catalogue, and `active`, which is one
// concept across four commands: aliases, properties, tags and tasks.
// ---------------------------------------------------------------------------

test("obsidian_tags sends the counts and the sort as the separate tokens they are", () => {
  assert.deepEqual(
    tags.tokens({
      file: undefined,
      path: undefined,
      active: false,
      byCount: true,
      counts: true,
      json: true,
      total: false,
    }),
    ["sort=count", "counts", "format=json"]
  );
  // `counts` alone does not reorder, `byCount` alone does not add the numbers.
  assert.deepEqual(
    tags.tokens({
      file: "My Note",
      path: undefined,
      active: false,
      byCount: false,
      counts: true,
      json: false,
      total: false,
    }),
    ["file=My Note", "counts"]
  );
});

test("obsidian_unresolved_links forwards both of the CLI's detail tokens", () => {
  assert.deepEqual(
    unresolved.tokens({ counts: true, verbose: false, json: true, total: false }),
    ["counts", "format=json"]
  );
  assert.deepEqual(
    unresolved.tokens({ counts: false, verbose: true, json: true, total: false }),
    ["verbose", "format=json"]
  );
  assert.deepEqual(unresolved.tokens({ counts: false, verbose: false, json: false, total: true }), [
    "total",
  ]);
});

test("obsidian_properties_list asks for one property, the sort and the count", () => {
  assert.deepEqual(
    propertiesList.tokens({ name: undefined, byCount: true, json: true, total: false }),
    ["sort=count", "format=json"]
  );
  assert.deepEqual(
    propertiesList.tokens({ name: "status", byCount: false, json: true, total: false }),
    ["name=status", "format=json"]
  );
  assert.deepEqual(propertiesList.tokens({ name: undefined, byCount: false, json: true, total: true }), [
    "format=json",
    "total",
  ]);
});

test("all four tools that take `active` send the bare token and describe it identically", () => {
  const withActive = [
    [aliases, { file: undefined, path: undefined, active: true, verbose: false, total: false }],
    [propertiesGet, { file: undefined, path: undefined, active: true, json: false }],
    [
      tags,
      { file: undefined, path: undefined, active: true, byCount: false, counts: false, json: false, total: false },
    ],
    [
      tasksList,
      {
        file: undefined,
        path: undefined,
        active: true,
        daily: false,
        state: undefined,
        status: undefined,
        json: false,
        total: false,
      },
    ],
  ];

  for (const [spec, args] of withActive) {
    assert.ok(
      spec.tokens(args).includes("active"),
      `${spec.name} dropped the active token: ${JSON.stringify(spec.tokens(args))}`
    );
    // Same name, same type, same sentence bar the noun -- the point of sharing activeParam.
    const described = spec.inputSchema.active.description;
    assert.match(described, /^Only the \w+ of the note currently open in Obsidian\.$/, spec.name);
  }
});

test("the three tools where `active` replaces a note refuse a call that also names one", () => {
  const conflicting = [
    [aliases, { file: "My Note", path: undefined, active: true }],
    [propertiesGet, { file: undefined, path: "A/B.md", active: true }],
    [tags, { file: "My Note", path: undefined, active: true }],
  ];

  for (const [spec, args] of conflicting) {
    assert.match(spec.check(args), /single scope/, spec.name);
    assert.equal(spec.check({ ...args, active: false }), undefined, spec.name);
  }
});

// ---------------------------------------------------------------------------
// The registry's own rule about `active`, exercised on a synthetic tool so that nothing here
// goes near the `obsidian` binary: a tool that requires a target is satisfied by `active`.
// ---------------------------------------------------------------------------

/** Registers one spec against a stub server and hands back the handler it produced. */
function handlerOf(spec) {
  let handler;
  const server = { registerTool: (_name, _config, fn) => (handler = fn) };
  registerTools(server, [spec], { readonly: false });
  return handler;
}

test("`active` counts as naming a target, and nothing else does", async () => {
  const spec = {
    name: "synthetic",
    title: "t",
    description: "d",
    annotations: { readOnlyHint: true },
    inputSchema: {},
    requireTarget: "Name a note, or use `active`.",
    command: "noop",
    run: async () => ({ content: [{ type: "text", text: "ran" }] }),
  };
  const handler = handlerOf(spec);

  assert.equal((await handler({ active: true })).content[0].text, "ran");
  assert.equal((await handler({ file: "My Note" })).content[0].text, "ran");

  const refused = await handler({ active: false });
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0].text, "Name a note, or use `active`.");
});
