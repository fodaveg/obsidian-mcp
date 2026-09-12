/**
 * Templates.
 *
 * Both commands answer `No template folder configured` when the vault has no templates
 * folder set (Settings -> Templates). That is a configuration answer, not a failure of
 * this server, and it is worth relaying to the user as such.
 */
import { z } from "zod";

import { kv } from "../cli.js";
import { defineTool } from "./registry.js";
import { totalParam } from "./params.js";

export const templateTools = [
  defineTool({
    name: "obsidian_templates",
    title: "List templates",
    description:
      "Lists the template notes available in the vault. Read one with obsidian_template_read " +
      "before passing its name to obsidian_create's `template` parameter, so that the note you " +
      "create follows the structure the user expects. If the vault has no templates folder " +
      "configured, the CLI answers `No template folder configured`.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { total: totalParam },
    command: "templates",
    tier: "quick",
    tokens: ({ total }) => kv({ total }),
  }),

  defineTool({
    name: "obsidian_template_read",
    title: "Read a template",
    description:
      "Returns the body of a template, so you can see which sections and properties it defines " +
      "before applying it with obsidian_create. By default the template variables ({{date}}, " +
      "{{title}}…) are left as written; set `resolve` to see what they would expand to.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      name: z.string().describe("Template name, as listed by obsidian_templates."),
      resolve: z
        .boolean()
        .default(false)
        .describe("Expand the template variables instead of showing them verbatim."),
      title: z
        .string()
        .optional()
        .describe("Title to feed the variables when `resolve` is on, i.e. the name of the note-to-be."),
    },
    command: "template:read",
    tier: "quick",
    tokens: ({ name, resolve, title }) => kv({ name, resolve, title }),
  }),
];
