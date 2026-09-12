/**
 * Vault path helpers.
 *
 * The CLI's `create` command has a quirk this module works around: as soon as
 * `path=` is present it ignores `name=` completely, treats `path=` as the exact
 * file path, and replaces everything after the last dot with `.md` (unless that
 * suffix is an extension it already recognises, such as `.canvas`). So
 * `create name="My Note" path="33.11 Notes/"` writes `33.md`, and
 * `create path="Notes/Draft v1.2.3"` writes `Notes/Draft v1.2.md`.
 *
 * Passing a path that already ends in `.md` is the only form the CLI leaves
 * untouched, dots in folder names included. Therefore the server builds the
 * full destination path itself and never sends `name=`.
 */

const MARKDOWN_EXTENSION = ".md";

/**
 * Characters that must never reach a note's FILENAME.
 *
 * Obsidian Sync applies cross-platform (Windows/iOS) naming rules: a single one of these in a
 * filename can send it into a retry loop -- the helper process pegs a core and sync sits at
 * "detecting changes" for good (measured 18 Jul 2026, cleared by deleting a ":" from a name).
 * They are also illegal on Windows filesystems, so this is not one vault's preference.
 *
 * `/` is handled apart: it is not illegal, it is the folder separator, so a name carrying one
 * gets its own message pointing at the `path` parameter.
 */
const FORBIDDEN_NAME_CHARACTERS = [":", "*", "?", '"', "<", ">", "|", "\\"];

/** True when the value already carries the Markdown extension (case-insensitive). */
export function hasMarkdownExtension(value: string): boolean {
  return value.toLowerCase().endsWith(MARKDOWN_EXTENSION);
}

/** `\t` as U+0009, so an unprintable character can be named in an error message. */
function describeCharacter(character: string): string {
  const codePoint = character.codePointAt(0) ?? 0;
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Rejects a filename that carries a character Obsidian Sync or Windows cannot live with.
 *
 * Only ever applied to ONE segment -- the note's own name -- never to the folder part of a path:
 * folders already in the vault may well carry one of these, and refusing to address them would
 * break access to notes that work today.
 *
 * @param filename The last segment of the destination, with or without its `.md` suffix.
 * @throws If the name holds `/`, one of FORBIDDEN_NAME_CHARACTERS, or a control character.
 */
function assertUsableFilename(filename: string): void {
  if (filename.includes("/")) {
    throw new Error(
      `"${filename}" is a note name, not a path: "/" separates folders and cannot be part of a ` +
        "filename. Pass the folder in `path` and only the note's own name in `name`."
    );
  }

  const forbidden = [...filename].find((character) =>
    FORBIDDEN_NAME_CHARACTERS.includes(character)
  );
  if (forbidden) {
    throw new Error(
      `"${filename}" contains the character ${forbidden} and cannot be used as a filename: ` +
        'Obsidian Sync\'s cross-platform rules choke on : * ? " < > | \\ and Windows rejects ' +
        "them outright. " +
        "Remove it from the filename -- the note's TITLE (its frontmatter `title` or its `# ` " +
        "heading, inside the note) can keep the character."
    );
  }

  const control = [...filename].find((character) => (character.codePointAt(0) ?? 0) < 0x20);
  if (control) {
    throw new Error(
      `"${filename}" contains the control character ${describeCharacter(control)}, which cannot ` +
        "be part of a filename. Use spaces, and keep line breaks for the note's content."
    );
  }
}

/**
 * Builds the exact vault-relative path of a note to create.
 *
 * @param name   Note name, with or without the `.md` suffix. May contain dots.
 * @param folder Destination folder, with or without a trailing slash. When it
 *               already ends in `.md` it is taken as the full destination path
 *               and `name` is ignored.
 * @returns A normalised vault-relative path ending in `.md`.
 * @throws  If the note name is missing or unusable as a filename, or the
 *          resulting path is absolute or walks outside the vault with `..`.
 */
export function buildCreatePath(name?: string, folder?: string): string {
  const rawFolder = (folder ?? "").trim();
  const rawName = (name ?? "").trim();

  if (hasMarkdownExtension(rawFolder)) {
    // `path` already points at a file: it is the destination, verbatim. Its last segment is the
    // filename and gets the same checks as `name`; the folder segments are left alone, because
    // a folder that already exists in the vault is addressable whatever it is called.
    const normalized = normalizeVaultPath(rawFolder);
    assertUsableFilename(normalized.slice(normalized.lastIndexOf("/") + 1));
    return normalized;
  }

  if (!rawName) {
    throw new Error(
      'Provide `name` for the new note (or a `path` that already ends in ".md").'
    );
  }

  const joined = rawFolder ? `${rawFolder}/${rawName}` : rawName;
  const withExtension = hasMarkdownExtension(joined)
    ? joined
    : `${joined}${MARKDOWN_EXTENSION}`;

  // Normalise first, so an escape attempt (`..`, an absolute path) still answers with its own
  // message rather than with the filename rules.
  const normalized = normalizeVaultPath(withExtension);
  assertUsableFilename(rawName);

  return normalized;
}

/**
 * Collapses `//`, `./` and a trailing slash, and rejects paths that would leave
 * the vault. Everything else is preserved as typed: dots inside folder names
 * (`33.11 Notes`), parentheses, dashes and accents are all valid.
 */
export function normalizeVaultPath(input: string): string {
  if (input.startsWith("/")) {
    throw new Error(
      `"${input}" is an absolute path. Paths are relative to the vault root, e.g. "33.11 Notes/My Note.md".`
    );
  }

  const segments = input.split("/").filter((segment) => segment !== "" && segment !== ".");

  if (segments.includes("..")) {
    throw new Error(`"${input}" walks outside the vault ("..") and was rejected.`);
  }

  const normalized = segments.join("/");
  if (!normalized) {
    throw new Error(`"${input}" does not name a file inside the vault.`);
  }

  return normalized;
}
