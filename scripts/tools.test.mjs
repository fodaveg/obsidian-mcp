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

const byName = (specs, name) => specs.find((spec) => spec.name === name);

const listFolders = byName(fileTools, "obsidian_list_folders");
const orphans = byName(linkTools, "obsidian_orphans");
const deadends = byName(linkTools, "obsidian_deadends");
const propertiesGet = byName(propertyTools, "obsidian_properties_get");

test("obsidian_list_folders forwards the folder filter and the count", () => {
  assert.deepEqual(listFolders.tokens({ folder: undefined, tree: false, total: false }), []);
  assert.deepEqual(listFolders.tokens({ folder: "33 Notes", tree: false, total: false }), [
    "folder=33 Notes",
  ]);
  assert.deepEqual(listFolders.tokens({ folder: undefined, tree: true, total: true }), [
    "format=tree",
    "total",
  ]);
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
