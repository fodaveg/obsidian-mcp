// Unit tests for the task line builder. See scripts/paths.test.mjs for the setup.
import test from "node:test";
import assert from "node:assert/strict";

import { buildTaskLine } from "../dist/tasks.js";

test("builds an unchecked checkbox line", () => {
  assert.equal(buildTaskLine("Call the notary"), "- [ ] Call the notary");
  assert.equal(buildTaskLine("  Call the notary  "), "- [ ] Call the notary");
});

test("appends comma-separated tags as #tags", () => {
  assert.equal(
    buildTaskLine("Call the notary", "work,urgent"),
    "- [ ] Call the notary #work #urgent"
  );
});

test("tolerates a leading # and blank entries in the tag list", () => {
  assert.equal(buildTaskLine("Ship it", "#work, ,urgent,"), "- [ ] Ship it #work #urgent");
  assert.equal(buildTaskLine("Ship it", ""), "- [ ] Ship it");
  assert.equal(buildTaskLine("Ship it", undefined), "- [ ] Ship it");
});
