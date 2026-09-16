/**
 * Structured output: handing back the CLI's JSON as JSON.
 *
 * Several commands answer with JSON when asked (`format=json`), and until now the server passed
 * that JSON on as a STRING inside the text block, so every client had to parse it again --
 * while cli.ts had already parsed it and thrown the result away. The tools that ask for JSON
 * declare an `outputSchema` and return `structuredContent` as well (the text block stays: the
 * spec asks for it, and a client that ignores structuredContent would otherwise get nothing).
 *
 * THE SHAPE IS THE CLI'S, NOT OURS, and most of it is not measured. So the declared schemas are
 * permissive, and the data only becomes structuredContent if it actually matches: a shape we
 * guessed wrong degrades to text-only instead of turning a good answer into an error. Measured
 * on the Obsidian CLI 1.14.1: `tasks format=json` returns entries with exactly `status`, `text`,
 * `file` and `line`, and `line` arrives as a STRING.
 *
 * THIS SERVER DOES NOT REPAIR THE CLI'S SHAPE, even where the CLI is inconsistent with itself.
 * Two cases, both measured on 1.14.1: `count` arrives as a NUMBER from `properties format=json`
 * (`"count": 4`) but as a STRING from `tags counts` and `unresolved counts` (`"count": "3"`); and
 * `unresolved verbose` answers `sources` as one STRING with the paths joined by ", ", not as a
 * list. Neither is normalised here. Splitting `sources` on ", " would be a guess dressed up as a
 * fact: a vault path can itself contain a comma and a space, and the server would hand back a
 * list split in the wrong places with no error to say so. Turning `count` into a number would be
 * harmless in isolation, but it would make this server the owner of every field's shape in every
 * CLI version instead of a pass-through of one -- and a shape repaired here would stop matching
 * what the user sees running the CLI by hand, which is the thing a client is meant to be able to
 * trust. The practical consequence for a client: read `count` with `Number(...)` rather than
 * assume its type, and do not split `sources` -- read it as the one string the CLI sent.
 */
import { z } from "zod";

import type { CliResult } from "./cli.js";

/**
 * The value schema for a command whose JSON is a list of rows this server has not measured field
 * by field: an array of JSON values, nothing said about each one.
 *
 * It is deliberately this vague. Guessing the fields and getting one wrong would not fail loudly
 * -- it would silently drop the structured answer for every call (see structuredData) -- and the
 * CLI's own help is what says these commands return rows: each of them renders the same data as
 * TSV or CSV when asked.
 */
export const jsonRows = z.array(z.unknown());

/**
 * The value schema for a command whose JSON is a single object rather than a list of rows: any
 * keys, nothing said about the values.
 *
 * Measured on the Obsidian CLI 1.14.1: `properties format=json path=<note>` answers with the
 * note's frontmatter as one object, e.g. `{"jd": "12.32", "tipo": "id", ...}`. The values are
 * whatever the YAML held -- a string, a list, a number -- so they stay `unknown`, and a shape
 * that turns out not to be an object at all degrades to text-only like everything else here.
 */
export const jsonObject = z.record(z.string(), z.unknown());

/**
 * The structuredContent for one CLI result: `{ [key]: data }` when the call produced JSON that
 * fits `schema`, and `{}` when it did not.
 *
 * Why `{}` rather than nothing: a tool that declares an outputSchema and answers without
 * structuredContent is rejected by the SDK before the client sees it -- measured, the client gets
 * "Output validation error: ... no structured content was provided" INSTEAD of the CLI's text.
 * An empty object is the honest "no structured data for this call", and it keeps the text intact.
 * That happens for the calls that legitimately produce no JSON:
 *   - the plain-text modes (`json: false`, `format` other than json),
 *   - `total`, which answers with a count,
 *   - and a TRUNCATED stream, which is no longer parseable JSON even when it starts like some
 *     (see truncationNotice in cli.ts; the text block carries that warning).
 */
export function structuredData(
  result: CliResult,
  key: string,
  schema: z.ZodType
): Record<string, unknown> {
  // A cut stream is not data: whatever survived is half an answer, and passing it on as
  // structured content would make a partial listing look complete.
  if (result.truncatedBytes > 0) return {};
  if (result.json === undefined) return {};

  const parsed = schema.safeParse(result.json);
  return parsed.success ? { [key]: parsed.data } : {};
}
