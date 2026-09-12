/**
 * Tasks (Markdown checkboxes).
 *
 * The CLI's `verbose` token is deliberately not exposed here. It only changes the plain-text
 * rendering (grouping by file and adding line numbers), and obsidian_tasks_list asks for
 * `format=json` by default, where every entry already carries `file` and `line`. Advertised as
 * "how you get the ref", it was asking the model to pay for a flag that changed nothing.
 */
import { z } from "zod";

import { kv } from "../cli.js";
import { buildTaskLine } from "../tasks.js";
import { defineTool } from "./registry.js";
import { fileParam, pathParam, totalParam } from "./params.js";

export const taskTools = [
  defineTool({
    name: "obsidian_tasks_list",
    title: "List tasks",
    description:
      "Lists tasks (checkboxes) found across the vault, and is also where the `ref` (path:line) " +
      "that obsidian_task_complete needs comes from. Scope it whenever you can: an unfiltered " +
      "listing of a working vault runs into the thousands of entries, so asking for the note " +
      "that holds the task is both cheaper and more precise. Give at most one scope -- `file` / " +
      "`path` (one note), `active` (the note open in Obsidian) or `daily` (today's daily note); " +
      "with none of them it covers the whole vault.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      file: fileParam,
      path: pathParam,
      active: z.boolean().default(false).describe("Only the tasks of the note currently open in Obsidian."),
      daily: z.boolean().default(false).describe("Only the tasks of today's daily note."),
      state: z
        .enum(["todo", "done"])
        .optional()
        .describe("Keep only the incomplete (todo) or the completed (done) tasks. Omit for both."),
      status: z
        .string()
        .optional()
        .describe(
          'Filter by status character, for vaults with custom checkbox states, e.g. "/" (in ' +
            'progress) or "-" (cancelled). For the plain done/not-done split use `state`.'
        ),
      json: z
        .boolean()
        .default(true)
        .describe(
          "Return machine-readable JSON: one entry per task with its status, text, file and " +
            "line, so `ref` is simply file:line. Set it to false for the CLI's plain-text " +
            "rendering, which does not carry the line numbers."
        ),
      total: totalParam,
    },
    // The CLI takes each of these scopes as a separate token and we have not measured which one
    // wins when they are combined, so rather than guess we ask for one.
    check: ({ file, path, active, daily }) =>
      [Boolean(file || path), active, daily].filter(Boolean).length > 1
        ? "Pick a single scope: `file`/`path`, `active` or `daily`."
        : undefined,
    command: "tasks",
    tier: "slow",
    tokens: ({ file, path, active, daily, state, status, json, total }) =>
      kv({
        file,
        path,
        active,
        daily,
        done: state === "done",
        todo: state === "todo",
        status,
        format: json ? "json" : undefined,
        total,
      }),
  }),

  defineTool({
    name: "obsidian_task_create",
    title: "Add a task to a note",
    description:
      "Appends a `- [ ] <content>` checkbox line to a note (or to today's daily note when neither " +
      "`file` nor `path` is given). Tags are appended to the line as #tags.",
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      content: z.string().describe("Task text, without the checkbox markup."),
      tags: z.string().optional().describe('Comma-separated tags, e.g. "work,urgent".'),
      file: fileParam,
      path: pathParam,
    },
    writes: true,
    // There is no task-creating command in the CLI: a task is just a line of Markdown, so this
    // appends one -- to the named note, or to the daily note when none was named.
    command: ({ file, path }) => (file || path ? "append" : "daily:append"),
    tokens: ({ content, tags, file, path }) => [
      ...(file || path ? kv({ file, path }) : []),
      `content=${buildTaskLine(content, tags)}`,
    ],
  }),

  defineTool({
    name: "obsidian_task_complete",
    title: "Complete a task",
    description:
      "Marks a task as done. Identify it with `ref` (\"path:line\": the `file` and `line` of an " +
      "obsidian_tasks_list entry, joined by a colon) or with `path` plus `line`. To toggle it or " +
      "set another status character, use obsidian_exec with the `task` command.",
    // It overwrites the status character of an existing line, so destructiveHint is left
    // undeclared; marking the same task done twice does leave the same state.
    annotations: { idempotentHint: true, openWorldHint: true },
    inputSchema: {
      ref: z
        .string()
        .optional()
        .describe('Task reference, "vault/relative/path.md:12".'),
      path: z.string().optional().describe("Exact vault-relative path of the note holding the task."),
      line: z.number().int().positive().optional().describe("1-based line number of the task."),
    },
    writes: true,
    check: ({ ref, path, line }) =>
      !ref && !(path && line !== undefined)
        ? 'Provide `ref` ("path:line"), or both `path` and `line`.'
        : undefined,
    command: "task",
    tokens: ({ ref, path, line }) => [...(ref ? kv({ ref }) : kv({ path, line })), "done"],
  }),
];
