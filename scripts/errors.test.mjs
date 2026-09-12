// Unit tests for the CLI failure detection. See scripts/output.test.mjs for the setup:
// they run against the compiled output in dist/, so `npm test` builds first.
import test from "node:test";
import assert from "node:assert/strict";

import { looksLikeCliError } from "../dist/cli.js";

test("spots the CLI's own one-line errors, which it prints while exiting 0", () => {
  assert.equal(looksLikeCliError('Error: File "no-existe-jamas-12345.md" not found.'), true);
  assert.equal(looksLikeCliError('Error: Command "comando-que-no-existe" not found.'), true);
  assert.equal(looksLikeCliError("Error: Invalid number: a,b"), true);
  assert.equal(looksLikeCliError("Error: Line 99 is out of range (file has 5 lines)."), true);
  // Trailing whitespace/newlines are what a stream actually delivers.
  assert.equal(looksLikeCliError("Error: File not found.\n"), true);
});

test("does not flag a note whose first line merely starts the same way", () => {
  const note = ["Error: connection refused", "", "That is what the log said. Notes below.", "- retry"].join("\n");
  assert.equal(looksLikeCliError(note), false);
  // Two lines are already enough: the CLI's errors are always a single one.
  assert.equal(looksLikeCliError("Error: something\nand more context"), false);
});

test("leaves ordinary output alone", () => {
  assert.equal(looksLikeCliError("Created: Projects/Note.md"), false);
  assert.equal(looksLikeCliError('[{"status":" ","text":"Call the notary"}]'), false);
  assert.equal(looksLikeCliError("Errors: 3"), false); // starts with "Error", not with "Error: "
  assert.equal(looksLikeCliError("error: lowercase is not the CLI's wording"), false);
});

test("empty output is not an error", () => {
  assert.equal(looksLikeCliError(""), false);
  assert.equal(looksLikeCliError("   \n  "), false);
});
