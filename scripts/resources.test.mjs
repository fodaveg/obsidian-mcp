// Unit tests for the pure halves of the resource layer: the URI scheme and the list cursor.
// They exercise the compiled output in dist/, so `npm test` builds first, and they never go near
// the `obsidian` binary -- which is what lets them run in CI on a machine with no vault.
//
// The URI is the part worth pinning down. It is the only identifier a client ever holds for a
// note, it is built by this server and handed back by the client unchanged, and a path that does
// not survive the round trip turns into a note nobody can read.
import test from "node:test";
import assert from "node:assert/strict";

import {
  FOLDER_URI_PREFIX,
  NOTE_URI_PREFIX,
  decodeCursor,
  encodeCursor,
  folderUri,
  mimeTypeFor,
  noteUri,
  vaultTargetFromUri,
} from "../dist/resources.js";

const JD_NOTE =
  "30-39 Conocimiento y herramientas/33 Notas, PKM y métodos de conocimiento/" +
  "33.11 Notas y organización del conocimiento/Nota A.md";

// ---------------------------------------------------------------------------
// The URI scheme
// ---------------------------------------------------------------------------

test("a note's path survives the round trip through its URI", () => {
  const uri = noteUri(JD_NOTE);
  assert.equal(uri.startsWith(NOTE_URI_PREFIX), true);
  assert.deepEqual(vaultTargetFromUri(uri), { kind: "note", path: JD_NOTE });
});

test("the folder separators stay readable and everything else is encoded", () => {
  // Slashes are the point of the scheme: the URI shows the tree. Spaces and accents are
  // encoded because a URI has to survive being pasted, logged and parsed by `new URL()`.
  assert.equal(
    noteUri("33.11 Notas/Nota A.md"),
    `${NOTE_URI_PREFIX}33.11%20Notas/Nota%20A.md`
  );
  assert.equal(noteUri("Año 2026/Reunión.md"), `${NOTE_URI_PREFIX}A%C3%B1o%202026/Reuni%C3%B3n.md`);
});

test("the characters that would cut a URI short are encoded, not passed through", () => {
  // `#` starts a fragment, `?` a query and `%` an escape. An Obsidian note name may hold all
  // three, and an unencoded one would silently truncate the path or corrupt the next decode.
  for (const name of ["Nota #1.md", "¿Y ahora qué?.md", "100% hecho.md", "a&b.md", "x+y.md"]) {
    const path = `Inbox/${name}`;
    assert.equal(vaultTargetFromUri(noteUri(path)).path, path, `round trip of "${name}"`);
    assert.equal(noteUri(path).includes("#"), false);
    assert.equal(noteUri(path).includes("?"), false);
  }
});

test("a segment holding a literal slash cannot forge a folder boundary", () => {
  // encodeURIComponent turns it into %2F, and the decode is per segment, so it comes back as
  // part of the name rather than as a new folder level.
  const uri = noteUri("Inbox/a/b.md".replace("a/b", "a/b"));
  assert.equal(typeof uri, "string");
  assert.equal(vaultTargetFromUri(`${NOTE_URI_PREFIX}Inbox/a%2Fb.md`).path, "Inbox/a/b.md");
});

test("a folder URI ends in a slash, and the bare prefix is the vault root", () => {
  assert.equal(folderUri("33.11 Notas"), `${FOLDER_URI_PREFIX}33.11%20Notas/`);
  assert.equal(folderUri(""), FOLDER_URI_PREFIX);
  assert.deepEqual(vaultTargetFromUri(FOLDER_URI_PREFIX), { kind: "folder", path: "" });
  assert.deepEqual(vaultTargetFromUri(folderUri("33.11 Notas")), {
    kind: "folder",
    path: "33.11 Notas",
  });
});

test("the URI says which kind of thing it addresses", () => {
  assert.equal(vaultTargetFromUri(noteUri("A.md")).kind, "note");
  assert.equal(vaultTargetFromUri(folderUri("A")).kind, "folder");
});

// ---------------------------------------------------------------------------
// What a URI is not allowed to address
// ---------------------------------------------------------------------------

test("a URI that walks out of the vault is refused", () => {
  // Nothing here creates a file, so the filename rules of src/paths.ts do not apply -- but a URI
  // is client-supplied text and must not become a `path=` token pointing outside the vault.
  assert.throws(() => vaultTargetFromUri(`${NOTE_URI_PREFIX}../../etc/passwd`), /walks outside the vault/);
  assert.throws(() => vaultTargetFromUri(`${NOTE_URI_PREFIX}Inbox/../../x.md`), /walks outside the vault/);
  assert.throws(
    () => vaultTargetFromUri(`${NOTE_URI_PREFIX}%2E%2E/%2E%2E/etc/passwd`),
    /walks outside the vault/,
    "an encoded `..` is still a `..` once decoded"
  );
  assert.throws(() => vaultTargetFromUri(`${FOLDER_URI_PREFIX}../secrets/`), /walks outside the vault/);
});

test("an absolute path is refused", () => {
  assert.throws(() => vaultTargetFromUri(`${NOTE_URI_PREFIX}/etc/passwd`), /absolute path/);
});

test("a URI from somewhere else is refused, and says what this server's look like", () => {
  for (const uri of ["file:///etc/passwd", "https://example.com/x.md", "obsidian://vault/x", "x.md"]) {
    assert.throws(() => vaultTargetFromUri(uri), /is not a resource of this server/, uri);
  }
});

test("broken percent-encoding is refused rather than silently mangled", () => {
  assert.throws(() => vaultTargetFromUri(`${NOTE_URI_PREFIX}Inbox/%E0%A4%A.md`), /bad percent-encoding/);
});

test("a note URI that addresses nothing is refused", () => {
  assert.throws(() => vaultTargetFromUri(NOTE_URI_PREFIX), /does not name a file inside the vault/);
});

// ---------------------------------------------------------------------------
// The cursor
// ---------------------------------------------------------------------------

test("a cursor round trips and is opaque", () => {
  const cursor = encodeCursor({ folderIndex: 19, offset: 56 });
  assert.deepEqual(decodeCursor(cursor), { folderIndex: 19, offset: 56 });
  // Opaque to the client: it carries no path, so it cannot be edited into a different vault.
  assert.equal(/^[A-Za-z0-9_-]+$/.test(cursor), true);
  assert.equal(cursor.includes(":"), false);
});

test("no cursor means the start of the walk", () => {
  assert.deepEqual(decodeCursor(undefined), { folderIndex: 0, offset: 0 });
});

test("a cursor this server did not issue is an error, not a silent restart", () => {
  // Guessing "start over" would make a client's paging loop run for ever instead of failing.
  for (const cursor of ["", "not-a-cursor", Buffer.from("7", "utf8").toString("base64url")]) {
    assert.throws(() => decodeCursor(cursor), /is not a cursor issued by this server/, cursor);
  }
});

// ---------------------------------------------------------------------------
// MIME types
// ---------------------------------------------------------------------------

test("a note is Markdown, a canvas is JSON, anything else is plain text", () => {
  assert.equal(mimeTypeFor("Inbox/Nota A.md"), "text/markdown");
  assert.equal(mimeTypeFor("Inbox/NOTA.MD"), "text/markdown");
  assert.equal(mimeTypeFor("Inbox/Mapa.canvas"), "application/json");
  assert.equal(mimeTypeFor("Inbox/notas.txt"), "text/plain");
  // A dotted folder is not an extension: `33.11 Notas/Nota` has no suffix at all.
  assert.equal(mimeTypeFor("33.11 Notas/Nota"), "text/plain");
});
