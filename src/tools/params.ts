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

// The CLI's listing commands all take a bare `total` token that returns the count instead of the
// list. It is the cheapest answer there is to "how many?", so every tool that lists exposes it.
export const totalParam = z
  .boolean()
  .default(false)
  .describe(
    'Return only how many results there are, not the results themselves. Use it for "how many …?" ' +
      "questions: it answers them without paying for the whole listing."
  );
