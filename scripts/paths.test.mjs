// Unit tests for the pure helpers, run with the Node test runner (no extra deps).
// They exercise the compiled output in dist/, so `npm test` builds first.
import test from "node:test";
import assert from "node:assert/strict";

import { assertUsableFilename, buildCreatePath, destinationFilename, normalizeVaultPath } from "../dist/paths.js";
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

test("rejects every character Obsidian Sync cannot live with in a filename", () => {
  // One per character: a single one of these in a FILENAME sends Obsidian Sync into a retry
  // loop (measured 18 Jul 2026), and Windows refuses the file outright.
  for (const character of [":", "*", "?", '"', "<", ">", "|", "\\"]) {
    assert.throws(
      () => buildCreatePath(`Planificación${character} 3 enfoques`, "Inbox/"),
      new RegExp(`contains the character \\${character}`),
      `"${character}" should be rejected in a note name`
    );
  }
  // The message points at where the character IS allowed: the title inside the note.
  assert.throws(() => buildCreatePath("Planificación: 3 enfoques"), /TITLE/);
  assert.throws(() => buildCreatePath("Planificación: 3 enfoques"), /Obsidian Sync/);
});

test("rejects a slash in the name, pointing at `path` instead", () => {
  assert.throws(() => buildCreatePath("con/barra dentro", "carpeta/"), /"\/" separates folders/);
  assert.throws(() => buildCreatePath("con/barra dentro", "carpeta/"), /Pass the folder in `path`/);
  // It is a different family from the Sync characters, so it does not borrow their message:
  // a slash is legal in a path, it is just not part of a name.
  assert.throws(
    () => buildCreatePath("a/b", "Inbox"),
    (error) => !/Obsidian Sync/.test(error.message)
  );
});

test("rejects control characters in the name", () => {
  assert.throws(() => buildCreatePath("Nota\tcon tabulador", "Inbox"), /control character U\+0009/);
  assert.throws(() => buildCreatePath("Nota\ncon salto", "Inbox"), /control character U\+000A/);
});

test("keeps accepting the names people actually use", () => {
  assert.equal(
    buildCreatePath("00.05 Instrucciones para agentes", "Inbox/"),
    "Inbox/00.05 Instrucciones para agentes.md"
  );
  assert.equal(
    buildCreatePath("Smart Notes - Resumen (Ahrens) v1.2", "33.11 Notas/"),
    "33.11 Notas/Smart Notes - Resumen (Ahrens) v1.2.md"
  );
  assert.equal(buildCreatePath("Nota con 'comilla simple' & signo #1", ""), "Nota con 'comilla simple' & signo #1.md");
});

test("a full .md path is checked on its filename only, never on its folders", () => {
  // The filename is the last segment, and it gets the same rules as `name`.
  assert.throws(
    () => buildCreatePath(undefined, "Inbox/Planificación: 3 enfoques.md"),
    /contains the character :/
  );
  // The folders are not ours to police: one that already exists in the vault, whatever its
  // name, must stay addressable. Rejecting it here would break access to notes that work today.
  assert.equal(
    buildCreatePath(undefined, "Proyecto: 2026/Nota A.md"),
    "Proyecto: 2026/Nota A.md"
  );
  assert.equal(buildCreatePath("Nota A", "Proyecto: 2026/Sub|carpeta"), "Proyecto: 2026/Sub|carpeta/Nota A.md");
});

test("an escape attempt is still reported as one, not as a bad filename", () => {
  // `..` and absolute paths keep their own message even though they also carry a slash.
  assert.throws(() => buildCreatePath("../Nota", "Inbox"), /outside the vault/);
  assert.throws(() => buildCreatePath("Nota", "/Users/someone/vault"), /absolute path/);
});

test("requires a name when the path is not a full .md path", () => {
  assert.throws(() => buildCreatePath(undefined, "Inbox/"), /Provide `name`/);
  assert.throws(() => buildCreatePath("   ", "Inbox/"), /Provide `name`/);
});

test("destinationFilename tells a destination folder from a full path to a file", () => {
  // A file: an extension is a dot, a letter, then letters or digits, at the end of the segment.
  assert.equal(destinationFilename("Archivo/2026/Nota A.md"), "Nota A.md");
  assert.equal(destinationFilename("Nota A.md"), "Nota A.md");
  assert.equal(destinationFilename("Adjuntos/imagen.png"), "imagen.png");
  assert.equal(destinationFilename("Tableros/Mapa.canvas"), "Mapa.canvas");
  // A folder: no dot at all, or a dot that is part of the name rather than an extension.
  assert.equal(destinationFilename("Archivo/2026/"), undefined);
  assert.equal(destinationFilename("Archivo/2026"), undefined);
  assert.equal(destinationFilename("33.11 Notas y organización/"), undefined);
  assert.equal(destinationFilename("Archivo/Draft v1.2.3"), undefined);
  assert.equal(destinationFilename("  Archivo/2026//  "), undefined);
});

test("destinationFilename resolves an ambiguous last segment towards folder", () => {
  // The two mistakes do not cost the same: reading a file as a folder only skips a check, while
  // reading a folder as a file would apply the filename rules to a folder the user already has.
  assert.equal(destinationFilename("Proyecto: 2026"), undefined);
  assert.equal(destinationFilename("Notas v2.0"), undefined);
  assert.equal(destinationFilename("Proyecto: 2026/Nota A.md"), "Nota A.md");
});

test("assertUsableFilename says where the folder belongs, and the caller decides where that is", () => {
  // Create's advice ("the folder goes in `path`") is wrong for a rename, whose `path` addresses
  // the note being renamed, so the message is the caller's to supply.
  assert.throws(() => assertUsableFilename("a/b"), /Pass the folder in `path`/);
  assert.throws(() => assertUsableFilename("a/b", "Use obsidian_move instead."), /Use obsidian_move instead/);
  assert.doesNotThrow(() => assertUsableFilename("00.05 Instrucciones para agentes"));
  assert.throws(() => assertUsableFilename("Planificación: 3 enfoques"), /contains the character :/);
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

test("kv skips undefined and keeps numbers", () => {
  assert.deepEqual(kv({ file: undefined, line: 12 }), ["line=12"]);
});

test("kv sends an empty value instead of dropping the argument", () => {
  // Asking for an empty property (or a blank line in the daily note) must reach the CLI:
  // dropping it turns the call into one without that argument and nothing gets cleared.
  assert.deepEqual(kv({ content: "" }), ["content="]);
  assert.deepEqual(kv({ value: "", name: "status" }), ["value=", "name=status"]);
});

test("kv refuses a key that is not a plain CLI option name", () => {
  // A key is half a token: `vault` as a property name once produced `vault=Other` and sent the
  // call to a different vault. Keys come from this repo's code, and this is what keeps it so.
  assert.throws(() => kv({ "vault=Other": "x" }), /not a valid Obsidian CLI option name/);
  assert.throws(() => kv({ "file path": "x" }), /not a valid/);
  assert.throws(() => kv({ Vault: "x" }), /not a valid/);
  assert.throws(() => kv({ "": "x" }), /not a valid/);
  assert.throws(() => kv({ "-rf": true }), /not a valid/);
  // The names the tools actually use keep working, dashes and digits included.
  assert.deepEqual(kv({ file: "A", "base-view": "B", v2: 3 }), ["file=A", "base-view=B", "v2=3"]);
});
