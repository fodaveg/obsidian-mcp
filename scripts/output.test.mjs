// Unit tests for the CLI output cap, run with the Node test runner (no extra deps).
// They exercise the compiled output in dist/, so `npm test` builds first.
import test from "node:test";
import assert from "node:assert/strict";

import { CappedStream, truncationNotice } from "../dist/cli.js";

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
