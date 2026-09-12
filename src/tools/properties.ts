/**
 * Properties (YAML frontmatter).
 */
import { z } from "zod";

import { formatResult, kv, runCli, withVault, type CliResult } from "../cli.js";
import { jsonObject, jsonRows } from "../structured.js";
import { defineTool } from "./registry.js";
import {
  activeParam,
  fileParam,
  MISSING_TARGET_OR_ACTIVE,
  ONE_SCOPE,
  pathParam,
  totalParam,
} from "./params.js";

export const propertyTools = [
  defineTool({
    name: "obsidian_properties_get",
    title: "Get a note's properties",
    description:
      "Reads the YAML frontmatter/properties of ONE note: the one named by `file`/`path`, or the " +
      "one open in Obsidian with `active`. For which property keys exist across the vault, use " +
      "obsidian_properties_list.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      file: fileParam,
      path: pathParam,
      active: activeParam("properties"),
      json: z
        .boolean()
        .default(true)
        .describe(
          "Return machine-readable JSON instead of the CLI's YAML rendering, and hand the same " +
            "object back as structured content."
        ),
    },
    // `active` is a target here, not a filter: measured on CLI 1.14.1, `properties active`
    // answers with the frontmatter of the open note exactly as `properties file=<it>` does.
    // Without any of the three the same command would list the whole vault instead, which is
    // obsidian_properties_list's job and a different answer shape.
    requireTarget: MISSING_TARGET_OR_ACTIVE,
    check: ({ file, path, active }) => (active && (file || path) ? ONE_SCOPE : undefined),
    command: "properties",
    tier: "quick",
    tokens: ({ file, path, active, json }) =>
      kv({ file, path, active, format: json ? "json" : undefined }),
    output: {
      key: "properties",
      schema: jsonObject,
      // The CLI's own default here is yaml, not tsv as in the listing commands, so `json: false`
      // is a real choice and not just an older rendering.
      description:
        "The note's frontmatter as the CLI's own JSON object, property name -> value. Absent " +
        "when the call asked for YAML and when the output had to be truncated.",
      when: ({ json }) => json,
    },
  }),

  defineTool({
    name: "obsidian_properties_list",
    title: "List the properties used in the vault",
    description:
      "Lists the frontmatter property KEYS used across the vault, with the type Obsidian infers " +
      "for each one and how many notes use it. This is the tool for \"which properties does this " +
      "vault use?\" and for checking the spelling of a key before filtering on it; " +
      "obsidian_properties_get reads the properties OF a note, which is the other question. With " +
      "`name` it answers how many notes use that single key, which is cheaper than listing.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      name: z
        .string()
        .optional()
        .describe(
          'Answer only with how many notes use this one property, e.g. "status". A bare count, ' +
            "so no listing and no structured content."
        ),
      byCount: z
        .boolean()
        .default(false)
        .describe("Sort by how many notes use each property, most used first, instead of by name."),
      json: z
        .boolean()
        .default(true)
        .describe(
          "Return machine-readable JSON instead of the CLI's plain list of names. Ignored when " +
            "`name` or `total` is set: both answer with a bare count either way."
        ),
      total: totalParam,
    },
    // The CLI's `counts` token is deliberately not exposed. Measured on 1.14.1,
    // `properties format=json` already answers `{"name": …, "type": …, "count": 4}` for every
    // key, and this tool asks for JSON by default -- so advertising a flag for the number that
    // is already there would be asking the model to pay for nothing. (Its plain-text mode does
    // lose the counts; that is what `json: false` is for, and it is not the default path.)
    command: "properties",
    // Every note's frontmatter gets read to build this.
    tier: "slow",
    tokens: ({ name, byCount, json, total }) =>
      kv({
        name,
        sort: byCount ? "count" : undefined,
        format: json ? "json" : undefined,
        total,
      }),
    output: {
      key: "properties",
      schema: jsonRows,
      description:
        "One entry per property key, as the CLI's own JSON: `name`, `type` (Obsidian's inferred " +
        "property type, e.g. text, date, multitext) and `count`, the number of notes using it, " +
        "as a number. Absent when the call asked for plain text, for `name` or for `total`, and " +
        "when the output had to be truncated.",
      when: ({ json }) => json,
    },
  }),

  defineTool({
    name: "obsidian_property_read",
    title: "Read one property of a note",
    description:
      "Returns the value of a single frontmatter property. Use it instead of " +
      "obsidian_properties_get when you already know which key you want (\"what is this note's " +
      "status?\"): it returns the value alone, not the whole frontmatter block.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      name: z.string().describe('Property name, e.g. "status".'),
      file: fileParam,
      path: pathParam,
    },
    requireTarget: true,
    command: "property:read",
    tier: "quick",
    tokens: ({ name, file, path }) => kv({ name, file, path }),
  }),

  defineTool({
    name: "obsidian_properties_set",
    title: "Set note properties",
    description:
      "Sets one or more frontmatter properties on a note, e.g. { status: 'active', tags: 'pkm,obsidian' }. " +
      "The CLI sets one property per call, so this runs one call per key and reports them all together.",
    // A key that already existed keeps no copy of its old value, so destructiveHint is left
    // undeclared on purpose and the client keeps its cautious default.
    annotations: { idempotentHint: true, openWorldHint: true },
    inputSchema: {
      file: fileParam,
      path: pathParam,
      properties: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .describe('Property name -> value, e.g. { "status": "active" }'),
      type: z
        .enum(["text", "list", "number", "checkbox", "date", "datetime"])
        .optional()
        .describe("Property type, applied to every property in this call. Defaults to Obsidian's own guess."),
    },
    writes: true,
    requireTarget: true,
    check: ({ properties }) =>
      Object.entries(properties).length === 0 ? "Provide at least one property to set." : undefined,
    command: "property:set",
    // One CLI call per key, so this one does not go through the registry's single-call path.
    run: async ({ file, path, properties, type }, command) => {
      const lines: string[] = [];
      let failed = false;
      for (const [name, value] of Object.entries(properties)) {
        // The property name is the VALUE of the `name=` token, never a token name of its own:
        // it comes from the model and an Obsidian property may legitimately be called "Due date",
        // which kv() would (rightly) refuse as a CLI option name.
        const result: CliResult = await runCli(
          withVault([command, `name=${name}`, `value=${value}`, ...kv({ type, file, path })])
        );
        // One failed key fails the batch: the CLI answers `Error: Invalid number: a,b` on stdout
        // with exit code 0, so without this the whole call would be reported as a success.
        if (!result.ok) failed = true;
        lines.push(`${name}: ${formatResult(result)}`);
      }

      return { isError: failed, content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  }),

  defineTool({
    name: "obsidian_properties_remove",
    title: "Remove a note property",
    description:
      "Removes a single frontmatter key from a note. The CLI answers `Removed: <key>` whether or " +
      "not the note had that property, so the reply is not evidence that it existed: check with " +
      "obsidian_property_read first when that matters (e.g. before telling the user you cleared " +
      "something).",
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      file: fileParam,
      path: pathParam,
      key: z.string().describe('Property name to remove, e.g. "status".'),
    },
    writes: true,
    requireTarget: true,
    command: "property:remove",
    tokens: ({ file, path, key }) => kv({ name: key, file, path }),
  }),
];
