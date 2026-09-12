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

/** True when the value already carries the Markdown extension (case-insensitive). */
export function hasMarkdownExtension(value: string): boolean {
  return value.toLowerCase().endsWith(MARKDOWN_EXTENSION);
}

/**
 * Builds the exact vault-relative path of a note to create.
 *
 * @param name   Note name, with or without the `.md` suffix. May contain dots.
 * @param folder Destination folder, with or without a trailing slash. When it
 *               already ends in `.md` it is taken as the full destination path
 *               and `name` is ignored.
 * @returns A normalised vault-relative path ending in `.md`.
 * @throws  If the note name is missing, or the resulting path is absolute or
 *          walks outside the vault with `..`.
 */
export function buildCreatePath(name?: string, folder?: string): string {
  const rawFolder = (folder ?? "").trim();
  const rawName = (name ?? "").trim();

  if (hasMarkdownExtension(rawFolder)) {
    // `path` already points at a file: it is the destination, verbatim.
    return normalizeVaultPath(rawFolder);
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

  return normalizeVaultPath(withExtension);
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
