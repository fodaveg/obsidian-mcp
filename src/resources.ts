/**
 * The vault as MCP RESOURCES: every note readable by URI, and the folder tree walkable.
 *
 * WHY THIS EXISTS. Tools are things the model decides to call; resources are things the USER
 * attaches. A vault is a tree of folders holding text, which is exactly what the resource half of
 * the protocol is for, and until now none of it was reachable that way: the only route to a note
 * was `obsidian_read`, which the model has to think of first.
 *
 * WHAT THE SDK DOES NOT GIVE US. The directory-listing extension (`resources/directory/read`,
 * entries with `inode/directory`) is NOT in @modelcontextprotocol/sdk 1.30.0: `ServerCapabilities`
 * declares only `subscribe` and `listChanged` under `resources`
 * (dist/esm/spec.types.d.ts:368), and the string `resources/directory` appears nowhere in the
 * package. So a vault of thousands of notes has to be handed over some other way, and the protocol
 * already has one -- `resources/list` is a PaginatedRequest with a `cursor`, and
 * `ListResourcesResult` carries `nextCursor` (dist/esm/types.js:857 and :863).
 *
 * WHY THE HANDLERS ARE REGISTERED BY HAND. McpServer.registerResource installs its own
 * `resources/list` handler, and that handler ignores `request.params.cursor` and never returns a
 * `nextCursor` (dist/esm/server/mcp.js:344-367): it maps every registered resource into one
 * array and answers with the lot. On this vault that is 3212 notes in a single message. So this
 * module registers the three resource requests on the low-level server itself, which is allowed
 * as long as nobody calls registerResource (assertCanSetRequestHandler only refuses a method that
 * ALREADY has a handler -- dist/esm/shared/protocol.js:903).
 *
 * WHAT REPLACES THE MISSING DIRECTORY LISTING. A second URI kind, `obsidian://folder/<path>`,
 * whose CONTENT is that folder's direct children -- subfolders and notes, each with its own URI.
 * It is `resources/directory/read` rewritten as an ordinary `resources/read`, so it works on every
 * client instead of only on the ones that implement the extension, and it is what lets a client
 * descend area -> category -> note instead of swallowing the vault.
 *
 * THE EXISTING LIMITS ALL STILL APPLY, because every call here goes through runCli: the output cap
 * cuts a huge note exactly as it cuts a huge tool result, and the concurrency queue serialises
 * these spawns together with the tools'. Resources are read-only by construction, so
 * OBSIDIAN_MCP_READONLY does not remove them.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type ListResourcesResult,
  type ReadResourceResult,
  type Resource,
} from "@modelcontextprotocol/sdk/types.js";

import { MAX_OUTPUT_BYTES, runCli, truncationNotice, withVault } from "./cli.js";
import { normalizeVaultPath } from "./paths.js";

// ---------------------------------------------------------------------------
// URIs
// ---------------------------------------------------------------------------
//
// THE SCHEME, and why this one. `obsidian://note/<vault-relative path>`, each path SEGMENT
// percent-encoded, `/` left alone as the folder separator.
//
//   * `obsidian://` is the vault's own URL scheme, so a reader can tell at a glance that the
//     resource is a note inside Obsidian and not a file this server found on disk. A `file://`
//     URI would claim the second, and would also have to name a vault location the server does
//     not know: the CLI addresses notes by vault-relative path and never tells us where the
//     vault lives.
//   * The `note/` and `folder/` prefix is what makes the URI say WHAT it is before it says
//     where. It is the URL's host, so `new URL()` -- which the SDK and most clients run over a
//     resource URI -- parses it without a special case.
//   * Segment-wise encoding, rather than encoding the whole path, keeps the URI readable and
//     reversible at the same time: the folders stay visible, while `#` (very common in an
//     Obsidian note name) cannot cut the path short as a fragment, `?` cannot start a query and
//     `%` cannot corrupt the next decode.

/** URI prefix of a note's contents. */
export const NOTE_URI_PREFIX = "obsidian://note/";

/** URI prefix of a folder listing. The vault root is the prefix on its own. */
export const FOLDER_URI_PREFIX = "obsidian://folder/";

/** Percent-encodes every segment of a vault-relative path, keeping `/` as the separator. */
function encodeSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** The URI of a note, from its vault-relative path. */
export function noteUri(path: string): string {
  return NOTE_URI_PREFIX + encodeSegments(path);
}

/** The URI of a folder listing. An empty path is the vault root. */
export function folderUri(path: string): string {
  return path ? `${FOLDER_URI_PREFIX}${encodeSegments(path)}/` : FOLDER_URI_PREFIX;
}

/** What a resource URI addresses: a note's contents, or a folder's listing. */
export interface VaultTarget {
  kind: "note" | "folder";
  /** Vault-relative path, decoded. Empty only for the vault root, which is a folder. */
  path: string;
}

/**
 * Turns a resource URI back into the vault path it addresses.
 *
 * The path rules are the ones normalizeVaultPath already enforces for everything this server
 * sends to the CLI: no leading `/`, no `..`. Nothing here CREATES a file -- the filename rules in
 * src/paths.ts are for that -- but a URI is client-supplied text, and `obsidian://note/../..`
 * must not become a `path=` token that walks out of the vault.
 *
 * @throws McpError if the URI is not one of this server's, or names a path outside the vault.
 */
export function vaultTargetFromUri(uri: string): VaultTarget {
  const kind = uri.startsWith(NOTE_URI_PREFIX)
    ? "note"
    : uri.startsWith(FOLDER_URI_PREFIX)
      ? "folder"
      : undefined;

  if (!kind) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `"${uri}" is not a resource of this server. Notes are ${NOTE_URI_PREFIX}<path>, ` +
        `folders are ${FOLDER_URI_PREFIX}<path>.`
    );
  }

  const encoded = uri.slice((kind === "note" ? NOTE_URI_PREFIX : FOLDER_URI_PREFIX).length);

  let decoded: string;
  try {
    // Decoded segment by segment: a segment that legitimately contains an encoded `/` (`%2F`)
    // must not turn into a folder boundary halfway through this function.
    decoded = encoded
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `"${uri}" is not a valid URI: bad percent-encoding.`);
  }

  // The vault root, and only it, is allowed to address nothing.
  if (kind === "folder" && decoded.replace(/\/+$/, "") === "") return { kind, path: "" };

  try {
    return { kind, path: normalizeVaultPath(decoded) };
  } catch (err) {
    throw new McpError(ErrorCode.InvalidParams, (err as Error).message);
  }
}

/** The MIME type a note is served as, by extension. Everything the CLI can read is text. */
export function mimeTypeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".canvas") || lower.endsWith(".json")) return "application/json";
  return "text/plain";
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------
//
// The cursor is SELF-CONTAINED -- a folder index and an offset inside that folder, nothing else --
// so the server keeps no snapshot to expire, evict or grow. The price is one `folders` call per
// page to re-read the spine, which measured 8ms on a 431-folder vault; the gain is that a client
// that pauses halfway through a walk and resumes an hour later is not told its cursor is gone.

/** How many resources one `resources/list` page may carry. */
const PAGE_SIZE = readPositiveInt("OBSIDIAN_MCP_RESOURCE_PAGE_SIZE", 200);

/**
 * How many folders one page may look inside before it stops and hands back a cursor, even if the
 * page is not full. Most folders hold no notes of their own, and without this a single request
 * could walk all 431 of them -- 431 spawns, serialised behind the concurrency queue -- before it
 * answered. A page is meant to be cheap; an empty-ish stretch of the tree costs an extra round
 * trip instead of a long silence.
 */
const FOLDER_LOOKUPS_PER_PAGE = 40;

/** Reads a positive integer from the environment, falling back when it is unset or nonsense. */
function readPositiveInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** Where a walk of the vault has got to: which folder of the spine, and how far into it. */
export interface ListPosition {
  folderIndex: number;
  offset: number;
}

/** Packs a position into the opaque token the protocol passes back as `cursor`. */
export function encodeCursor(position: ListPosition): string {
  return Buffer.from(`${position.folderIndex}:${position.offset}`, "utf8").toString("base64url");
}

/**
 * Unpacks a cursor. An absent one is the start of the walk.
 *
 * @throws McpError for anything that is not a cursor this server produced. The spec says an
 *         invalid cursor is an error, and guessing (starting over from zero) would silently make
 *         a client's paging loop run for ever.
 */
export function decodeCursor(cursor: string | undefined): ListPosition {
  if (cursor === undefined) return { folderIndex: 0, offset: 0 };

  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^(\d+):(\d+)$/.exec(text);
  if (!match) {
    throw new McpError(ErrorCode.InvalidParams, `"${cursor}" is not a cursor issued by this server.`);
  }
  return { folderIndex: Number(match[1]), offset: Number(match[2]) };
}

// ---------------------------------------------------------------------------
// Reading the vault through the CLI
// ---------------------------------------------------------------------------

/** One listing command's answer: the lines it produced, and whether the output cap cut them. */
interface Listing {
  lines: string[];
  truncated: boolean;
}

/**
 * Runs a listing command and splits it into trimmed, non-empty lines.
 *
 * The LAST line of a truncated listing is dropped, because the cap counts bytes and does not
 * care where a path ends: it cuts mid-name. Measured on the vault root, whose listing is eight
 * times the cap -- the tail read `10-19`, half of `10-19 Administración de la vida/...`, which
 * has no slash left in it and so passed every "is this a note in this folder" test there is. It
 * was listed as a resource, and reading it answered `File "10-19" not found`. A path this server
 * only half received is not a path.
 */
async function listLines(args: string[]): Promise<Listing> {
  const result = await runCli(withVault(args), "slow");
  if (!result.ok) {
    // A folder that was deleted between the spine call and this one is not an error worth
    // failing the whole page for: it lists as empty and the walk carries on.
    return { lines: [], truncated: false };
  }
  const truncated = result.truncatedBytes > 0;
  const raw = result.stdout.split("\n");
  if (truncated) raw.pop();
  const lines = raw.map((line) => line.trim()).filter((line) => line.length > 0);
  return { lines, truncated };
}

/**
 * Every folder in the vault, deepest paths included, with the vault root first as `""`.
 *
 * The CLI prints the root as `/`; it is rewritten here so that a folder path is always what the
 * rest of this server means by one -- relative to the vault root, with no leading slash.
 */
async function folderSpine(): Promise<Listing> {
  const { lines, truncated } = await listLines(["folders"]);
  return { lines: ["", ...lines.filter((line) => line !== "/")], truncated };
}

/**
 * The notes lying DIRECTLY in `folder` (not in its subfolders).
 *
 * `files folder=X` is recursive and depth-first, so the filtering happens here. That also means
 * a truncated answer loses the folder's OWN notes first, because they are printed after
 * everything under it -- hence `truncated` is carried out of here and reported rather than
 * quietly dropped.
 */
async function directNotes(folder: string): Promise<Listing> {
  const args = folder ? ["files", `folder=${folder}`, "ext=md"] : ["files", "ext=md"];
  const { lines, truncated } = await listLines(args);
  const prefix = folder ? `${folder}/` : "";
  return {
    lines: lines.filter(
      (path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/")
    ),
    truncated,
  };
}

/** The subfolders lying DIRECTLY in `folder`. Same recursive-listing trick as directNotes. */
async function directFolders(folder: string): Promise<Listing> {
  const args = folder ? ["folders", `folder=${folder}`] : ["folders"];
  const { lines, truncated } = await listLines(args);
  const prefix = folder ? `${folder}/` : "";
  return {
    lines: lines.filter(
      (path) =>
        path !== "/" &&
        path !== folder &&
        path.startsWith(prefix) &&
        !path.slice(prefix.length).includes("/")
    ),
    truncated,
  };
}

// ---------------------------------------------------------------------------
// The three request handlers
// ---------------------------------------------------------------------------

/** The last segment of a vault path, which is what a note or folder is called. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** How the vault root is named wherever a folder's name is shown. */
const ROOT_NAME = "(vault root)";

function noteResource(path: string): Resource {
  return {
    uri: noteUri(path),
    name: basename(path),
    title: basename(path).replace(/\.md$/i, ""),
    description: path,
    mimeType: mimeTypeFor(path),
  };
}

function folderResource(path: string, description: string): Resource {
  return {
    uri: folderUri(path),
    name: path ? basename(path) : ROOT_NAME,
    title: path || ROOT_NAME,
    description,
    mimeType: "application/json",
  };
}

/**
 * The entry a page carries in place of the notes a folder could not report.
 *
 * A listing cut by the output cap looks exactly like a short one, and a client would list the
 * folder as nearly empty. So the folder itself is handed over instead, with the reason attached:
 * the model reads a fact, not an absence.
 */
function truncatedFolderResource(path: string): Resource {
  return folderResource(
    path,
    `${path || ROOT_NAME}: its file listing exceeded the ${MAX_OUTPUT_BYTES}-byte output cap, so ` +
      "the notes it holds directly are NOT all in this list. Read this folder resource, narrow " +
      "the search with obsidian_list_files, or raise OBSIDIAN_MCP_MAX_OUTPUT_BYTES."
  );
}

/**
 * One page of `resources/list`: the vault's notes, folder by folder, in the order the CLI reports
 * its folders.
 *
 * Why folder by folder rather than one flat listing of the vault. Measured on a 5496-file vault:
 * `files ext=md` alone prints 399,636 bytes for 3212 notes, eight times the default output cap, so
 * a flat listing is cut to roughly an eighth of the vault and cannot be paged past. Scoping each
 * call to one folder keeps every one of them small -- 422 of the 430 folders measured under the
 * cap -- and gives the client the area/category/note descent the tree already has.
 */
async function listResources(cursor: string | undefined): Promise<ListResourcesResult> {
  const position = decodeCursor(cursor);
  const spine = await folderSpine();

  const resources: Resource[] = [];
  let { folderIndex, offset } = position;
  let lookups = 0;

  if (folderIndex === 0 && offset === 0 && spine.truncated) {
    resources.push(truncatedFolderResource(""));
  }

  while (folderIndex < spine.lines.length && resources.length < PAGE_SIZE) {
    if (lookups >= FOLDER_LOOKUPS_PER_PAGE) break;

    const folder = spine.lines[folderIndex];
    const notes = await directNotes(folder);
    lookups++;

    if (offset === 0 && notes.truncated) resources.push(truncatedFolderResource(folder));

    while (offset < notes.lines.length && resources.length < PAGE_SIZE) {
      resources.push(noteResource(notes.lines[offset]));
      offset++;
    }

    if (offset < notes.lines.length) break; // the page filled up mid-folder; resume here
    folderIndex++;
    offset = 0;
  }

  const done = folderIndex >= spine.lines.length;
  return done ? { resources } : { resources, nextCursor: encodeCursor({ folderIndex, offset }) };
}

/** A note's contents, read with the same CLI command and timeout tier as obsidian_read. */
async function readNote(uri: string, path: string): Promise<ReadResourceResult> {
  const result = await runCli(withVault(["read", `path=${path}`]), "quick");
  if (!result.ok) {
    throw new McpError(
      ErrorCode.InvalidParams,
      result.stdout || result.stderr || `Could not read "${path}".`
    );
  }

  // The cap already cut the text inside runCli; saying so is this module's job, and it has to be
  // said in the body because a resource has nowhere else to put it.
  const text =
    result.truncatedBytes > 0
      ? `${result.stdout}\n\n${truncationNotice(result.truncatedBytes, MAX_OUTPUT_BYTES)}`
      : result.stdout;

  return { contents: [{ uri, mimeType: mimeTypeFor(path), text }] };
}

/**
 * A folder's DIRECT children, as JSON: the subfolders and the notes, each with the URI to read it
 * with. This is the stand-in for `resources/directory/read`, which SDK 1.30.0 does not have (see
 * the header): same shape of answer -- one level, every entry addressable, subfolders
 * distinguishable from notes -- delivered through a plain `resources/read` that any client can
 * make.
 */
async function readFolder(uri: string, path: string): Promise<ReadResourceResult> {
  const folders = await directFolders(path);
  const notes = await directNotes(path);

  const body = {
    folder: path,
    name: path ? basename(path) : ROOT_NAME,
    folders: folders.lines.map((child) => ({
      name: basename(child),
      path: child,
      uri: folderUri(child),
    })),
    notes: notes.lines.map((child) => ({
      name: basename(child),
      path: child,
      uri: noteUri(child),
    })),
    // Reported, never implied: a cut listing is short in exactly the way a genuinely small folder
    // is, and the difference matters to whoever reads this.
    complete: !folders.truncated && !notes.truncated,
    ...(folders.truncated || notes.truncated
      ? {
          incomplete:
            `The listing this folder was built from hit the ${MAX_OUTPUT_BYTES}-byte output cap, ` +
            "so the children above are not all of them. Narrow the question with " +
            "obsidian_list_files / obsidian_list_folders, or raise OBSIDIAN_MCP_MAX_OUTPUT_BYTES.",
        }
      : {}),
  };

  return {
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify(body, null, 2) }],
  };
}

/**
 * Registers `resources/list`, `resources/templates/list` and `resources/read` on the underlying
 * server.
 *
 * They go on `server.server` rather than through registerResource for the reason in the header:
 * the high-level helper's list handler drops the cursor, and this vault does not fit in one page.
 * The `resources` capability is declared by src/index.ts, in the constructor, where the rest of
 * the server's shape is visible.
 */
export function registerResources(server: McpServer): void {
  server.server.setRequestHandler(ListResourcesRequestSchema, (request) =>
    listResources(request.params?.cursor)
  );

  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: [
      {
        name: "obsidian-note",
        title: "Note",
        uriTemplate: `${NOTE_URI_PREFIX}{+path}`,
        description:
          "A note's contents, addressed by its path relative to the vault root, e.g. " +
          `${NOTE_URI_PREFIX}33.11%20Notes/My%20Note.md. Each path segment is percent-encoded; ` +
          "the slashes between them are not.",
        mimeType: "text/markdown",
      },
      {
        name: "obsidian-folder",
        title: "Folder listing",
        uriTemplate: `${FOLDER_URI_PREFIX}{+path}`,
        description:
          "One folder's direct children as JSON -- its subfolders and its notes, each with the " +
          `URI to read next. ${FOLDER_URI_PREFIX} on its own is the vault root, which is where a ` +
          "walk of the tree starts.",
        mimeType: "application/json",
      },
    ],
  }));

  server.server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    const uri = request.params.uri;
    const target = vaultTargetFromUri(uri);
    return target.kind === "note" ? readNote(uri, target.path) : readFolder(uri, target.path);
  });
}
