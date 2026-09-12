/**
 * Input parameters shared by several tools, declared once.
 *
 * They are plain Zod schemas, so a tool picks the ones it needs straight into its `inputSchema`
 * and the description the model reads is the same everywhere.
 */
import { z } from "zod";

// Every CLI command that targets a note accepts `file=` (resolved by name, like a
// wikilink) or `path=` (exact). Names repeat across folders, so `path` is the
// unambiguous one; both are declared optional and each tool checks that it got one.
export const fileParam = z.string().optional().describe('Note name / wikilink, e.g. "My Note".');

export const pathParam = z
  .string()
  .optional()
  .describe(
    'Exact vault-relative path, e.g. "33.11 Notes/My Note.md". Use it when several notes share a name.'
  );

/**
 * The answer to a call that named neither target. Declared here and applied by the registry's
 * `requireTarget`, so it is one sentence in one place rather than one per handler.
 */
export const MISSING_TARGET =
  "Provide either `file` (note name, like a wikilink) or `path` (exact vault-relative path).";

/** The same, for the tools that can also be pointed at the note open in Obsidian. */
export const MISSING_TARGET_OR_ACTIVE =
  "Provide `file` (note name, like a wikilink), `path` (exact vault-relative path), or `active` " +
  "for the note currently open in Obsidian.";

/**
 * The CLI's `active` token: "the note open in Obsidian right now", used instead of naming one.
 *
 * Exactly four commands take it -- aliases, properties, tags and tasks -- and all four of them
 * expose it here. That is the point of declaring it in one place: a concept the model has to
 * discover is worth nothing if it exists on one tool and silently not on its neighbour, so the
 * name, the type and the wording are the same on all four and the phrasing only changes in the
 * noun. It is a SCOPE, like `file`/`path`: each tool that takes it refuses a call that also
 * names a note, because which one wins has not been measured.
 */
export const activeParam = (what: string) =>
  z.boolean().default(false).describe(`Only the ${what} of the note currently open in Obsidian.`);

/** What a tool answers when a call gave both a note and `active`. */
export const ONE_SCOPE =
  "Pick a single scope: `file`/`path` (a note you name) or `active` (the note open in Obsidian).";

// The CLI's listing commands all take a bare `total` token that returns the count instead of the
// list. It is the cheapest answer there is to "how many?", so every tool that lists exposes it.
export const totalParam = z
  .boolean()
  .default(false)
  .describe(
    'Return only how many results there are, not the results themselves. Use it for "how many …?" ' +
      "questions: it answers them without paying for the whole listing."
  );
