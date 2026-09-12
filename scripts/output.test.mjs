// Unit tests for the CLI output caps, run with the Node test runner (no extra deps).
// They exercise the compiled output in dist/, so `npm test` builds first. Nothing here goes near
// the `obsidian` binary or a vault: the caps are numbers and pure functions over a result object.
import test from "node:test";
import assert from "node:assert/strict";

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { CappedStream, formatResult, truncationNotice } from "../dist/cli.js";

/** Feeds a string to a stream as a single chunk, the way the child process would. */
const feed = (stream, text) => stream.push(Buffer.from(text, "utf8"));

test("keeps the output whole when it fits under the cap", () => {
  const stream = new CappedStream(100);
  feed(stream, "one\ntwo\nthree\n");
  assert.equal(stream.text(), "one\ntwo\nthree\n");
  assert.equal(stream.dropped, 0);
});

test("cuts at the cap and counts every byte dropped after it", () => {
  const stream = new CappedStream(10);
  feed(stream, "0123456789ABCDE"); // 5 bytes over
  feed(stream, "FGHIJ"); // arrives with the cap already reached
  assert.equal(stream.text(), "0123456789");
  assert.equal(stream.dropped, 10);
});

test("counts the drop across chunks that straddle the cap", () => {
  const stream = new CappedStream(8);
  feed(stream, "abcde");
  feed(stream, "fghij"); // 3 fit, 2 do not
  assert.equal(stream.text(), "abcdefgh");
  assert.equal(stream.dropped, 2);
});

test("never splits a multi-byte character in half", () => {
  // "ñ" is 2 bytes and "€" is 3, so these caps land inside a character.
  const two = new CappedStream(2);
  feed(two, "añb");
  assert.equal(two.text(), "a"); // the cap fell between the two bytes of "ñ"
  assert.equal(two.dropped, 2);

  const three = new CappedStream(3);
  feed(three, "a€b");
  assert.equal(three.text(), "a");
  assert.equal(three.dropped, 2);

  // A cap landing exactly on the boundary keeps the whole character.
  const four = new CappedStream(4);
  feed(four, "a€b");
  assert.equal(four.text(), "a€");
  assert.equal(four.dropped, 1);
});

test("does not trim a trailing partial sequence when nothing was dropped", () => {
  const stream = new CappedStream(100);
  stream.push(Buffer.from([0x61, 0xc3])); // "a" plus a dangling lead byte, but under the cap
  assert.equal(stream.dropped, 0);
  assert.equal(stream.text().length, 2);
});

test("the truncation notice says how much was lost and how to narrow it down", () => {
  const notice = truncationNotice(4321, 50000);
  assert.match(notice, /truncated at 50000 bytes/);
  assert.match(notice, /4321 more bytes were dropped/);
  assert.match(notice, /folder=, ext=, limit=/);
  assert.match(notice, /OBSIDIAN_MCP_MAX_OUTPUT_BYTES/);
});

// ---------------------------------------------------------------------------
// The cap is per call, not one number for the whole server
// ---------------------------------------------------------------------------

test("the notice quotes the cap THIS call had, not the module's default", () => {
  // The cap travels on the result because runCli now takes one per call. Reading the module
  // constant here instead would tell the reader a limit the call never ran under, and the number
  // is the whole point of the notice: it is what you are being told to raise.
  const result = {
    ok: true,
    code: 0,
    stdout: "half a listing",
    stderr: "",
    truncatedBytes: 271_781,
    maxOutputBytes: 2_000_000,
  };
  assert.match(formatResult(result), /truncated at 2000000 bytes/);
  // 50000 is the module default, i.e. what this used to print for every call: the signature of
  // going back to reading the constant.
  assert.doesNotMatch(formatResult(result), /truncated at 50000 bytes/);
});

test("a result that fit is not given a notice at all", () => {
  const result = {
    ok: true,
    code: 0,
    stdout: "a whole listing",
    stderr: "",
    truncatedBytes: 0,
    maxOutputBytes: 2_000_000,
  };
  assert.equal(formatResult(result), "a whole listing");
});

/**
 * Both caps as a FRESH process reads them, with `overrides` applied on top of an environment
 * scrubbed of either variable. They are read once at import, so an override can only be observed
 * in another process -- and reading them from a clean slate is also what keeps these tests from
 * depending on whoever ran `npm test` not having set them.
 */
function capsWith(overrides) {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const resources = fileURLToPath(new URL("../dist/resources.js", import.meta.url));
  const code =
    `const cli = await import(${JSON.stringify(cli)});` +
    `const res = await import(${JSON.stringify(resources)});` +
    "console.log(JSON.stringify({ output: cli.MAX_OUTPUT_BYTES, listing: res.MAX_LISTING_BYTES }));";

  const env = { ...process.env };
  delete env.OBSIDIAN_MCP_MAX_OUTPUT_BYTES;
  delete env.OBSIDIAN_MCP_MAX_LISTING_BYTES;

  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...env, ...overrides },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

test("the listing cap is far above the one sized for the model's context", () => {
  // The two exist for different reasons: MAX_OUTPUT_BYTES bounds text the client reads,
  // MAX_LISTING_BYTES bounds text the server parses into URIs and throws away. Measured on a
  // 431-folder vault, sharing the first cost 1275 of its 3212 notes: `folders` alone is 46,855
  // bytes of the 50,000, and the vault root's file listing is 399,636.
  const { output, listing } = capsWith({});
  assert.equal(listing > output, true);
  assert.equal(listing >= 400_000, true);
});

test("OBSIDIAN_MCP_MAX_LISTING_BYTES really moves the listing cap", () => {
  // Without this, the variable could be documented in the README, pass the README check (which
  // only looks for the name in the built code) and still be read by nobody.
  assert.equal(capsWith({ OBSIDIAN_MCP_MAX_LISTING_BYTES: "123456" }).listing, 123_456);

  // Nonsense falls back to the default rather than capping the walk at zero bytes.
  assert.equal(
    capsWith({ OBSIDIAN_MCP_MAX_LISTING_BYTES: "not a number" }).listing,
    capsWith({}).listing
  );
});

test("the two caps move independently", () => {
  // The bug this replaced: one variable for both, so making the walk work meant handing the model
  // a 2 MB search result as well.
  assert.equal(capsWith({ OBSIDIAN_MCP_MAX_OUTPUT_BYTES: "1000" }).listing, capsWith({}).listing);
  assert.equal(capsWith({ OBSIDIAN_MCP_MAX_LISTING_BYTES: "1000" }).output, capsWith({}).output);
});
