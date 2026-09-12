// Unit tests for the pure helpers, run with the Node test runner (no extra deps).
// They exercise the compiled output in dist/, so `npm test` builds first.
import test from "node:test";
import assert from "node:assert/strict";

import { buildCreatePath, normalizeVaultPath } from "../dist/paths.js";
import { kv } from "../dist/cli.js";

const JD_FOLDER =
  "30-39 Conocimiento y herramientas/33 Notas, PKM y métodos de conocimiento/" +
  "33.11 Notas y organización del conocimiento/";

test("keeps dotted Johnny Decimal folders and a name with dashes and parentheses", () => {
  assert.equal(
    buildCreatePath("How to Take Smart Notes - Resumen extenso (Ahrens)", JD_FOLDER),
    "30-39 Conocimiento y herramientas/33 Notas, PKM y métodos de conocimiento/" +
      "33.11 Notas y organización del conocimiento/" +
      "How to Take Smart Notes - Resumen extenso (Ahrens).md"
  );
});

test("keeps dots inside the note name", () => {
  assert.equal(buildCreatePath("Nota E v1.2.3", "_mcp-test/"), "_mcp-test/Nota E v1.2.3.md");
  assert.equal(buildCreatePath("Nota C v1.2", "_mcp-test/"), "_mcp-test/Nota C v1.2.md");
});

test("does not duplicate an extension the name already has", () => {
  assert.equal(buildCreatePath("Nota A.md", "Inbox"), "Inbox/Nota A.md");
  assert.equal(buildCreatePath("Nota A.MD", "Inbox"), "Inbox/Nota A.MD");
});

test("accepts the folder with, without, empty or dot-relative slashes", () => {
  assert.equal(buildCreatePath("Nota", "Inbox"), "Inbox/Nota.md");
  assert.equal(buildCreatePath("Nota", "Inbox/"), "Inbox/Nota.md");
  assert.equal(buildCreatePath("Nota", "Inbox//Sub///"), "Inbox/Sub/Nota.md");
  assert.equal(buildCreatePath("Nota", ""), "Nota.md");
  assert.equal(buildCreatePath("Nota", undefined), "Nota.md");
  assert.equal(buildCreatePath("Nota", "."), "Nota.md");
  assert.equal(buildCreatePath("Nota", "./"), "Nota.md");
  assert.equal(buildCreatePath("Nota", "./Inbox/"), "Inbox/Nota.md");
  assert.equal(buildCreatePath("  Nota  ", "  Inbox  "), "Inbox/Nota.md");
});

test("a path that is already a .md file wins and the name is ignored", () => {
  assert.equal(
    buildCreatePath("Ignored", "_mcp-test/33.11 Prueba/Nota A (Ahrens).md"),
    "_mcp-test/33.11 Prueba/Nota A (Ahrens).md"
  );
  assert.equal(
    buildCreatePath(undefined, "_mcp-test/33.11 Prueba/Nota A.md"),
    "_mcp-test/33.11 Prueba/Nota A.md"
  );
});

test("rejects paths that leave the vault", () => {
  assert.throws(() => buildCreatePath("Nota", "../outside"), /outside the vault/);
  assert.throws(() => buildCreatePath("../Nota", "Inbox"), /outside the vault/);
  assert.throws(() => buildCreatePath("Nota", "/Users/someone/vault"), /absolute path/);
  assert.throws(() => buildCreatePath(undefined, "/abs/Nota.md"), /absolute path/);
  assert.throws(() => normalizeVaultPath("Inbox/../../escape.md"), /outside the vault/);
});

test("requires a name when the path is not a full .md path", () => {
  assert.throws(() => buildCreatePath(undefined, "Inbox/"), /Provide `name`/);
  assert.throws(() => buildCreatePath("   ", "Inbox/"), /Provide `name`/);
});

test("kv emits booleans as bare CLI tokens, never as --flags", () => {
  assert.deepEqual(kv({ overwrite: true }), ["overwrite"]);
  assert.deepEqual(kv({ permanent: true }), ["permanent"]);
  assert.deepEqual(kv({ overwrite: false }), []);
  assert.deepEqual(kv({ path: "Inbox/Nota.md", overwrite: true }), [
    "path=Inbox/Nota.md",
    "overwrite",
  ]);
});

test("kv skips undefined and empty values and keeps numbers", () => {
  assert.deepEqual(kv({ file: undefined, content: "", line: 12 }), ["line=12"]);
});
