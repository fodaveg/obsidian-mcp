import { spawn } from "node:child_process";

/** Name of the Obsidian CLI binary. Override with OBSIDIAN_CLI_BIN if it's not on PATH. */
const CLI_BIN = process.env.OBSIDIAN_CLI_BIN?.trim() || "obsidian";

/** Optional vault name/path to target when the user has more than one vault open. */
const DEFAULT_VAULT = process.env.OBSIDIAN_VAULT?.trim();

/** How long to wait for the CLI (and therefore the running Obsidian app) to respond. */
const TIMEOUT_MS = Number(process.env.OBSIDIAN_CLI_TIMEOUT_MS) || 20_000;

/** Default cap for a single CLI stream, in bytes. Roughly 12-15k tokens of plain text. */
const DEFAULT_MAX_OUTPUT_BYTES = 50_000;

/**
 * How much of each stream is handed back to the MCP client. Listing a large vault or
 * searching without `limit` can produce hundreds of kB, which either buries the model's
 * context or blows past the client's maximum message size. Override with
 * OBSIDIAN_MCP_MAX_OUTPUT_BYTES.
 */
const MAX_OUTPUT_BYTES = readMaxOutputBytes();

function readMaxOutputBytes(): number {
  const raw = Number(process.env.OBSIDIAN_MCP_MAX_OUTPUT_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_OUTPUT_BYTES;
}

export interface CliResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON when it looked like JSON, otherwise undefined. */
  json?: unknown;
  /** Bytes dropped across both streams because they exceeded the cap. 0 when nothing was cut. */
  truncatedBytes: number;
}

export class CliError extends Error {
  constructor(public result: CliResult, message: string) {
    super(message);
    this.name = "CliError";
  }
}

/**
 * Byte length of the incomplete UTF-8 sequence at the end of `buf`, or 0 when it ends on a
 * character boundary. A UTF-8 character is at most 4 bytes, so only the last 3 can be partial.
 */
function danglingUtf8Bytes(buf: Buffer): number {
  for (let back = 1; back <= Math.min(4, buf.length); back++) {
    const byte = buf[buf.length - back];
    if ((byte & 0b1100_0000) === 0b1000_0000) continue; // continuation byte: keep walking back
    const expected = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return expected > back ? back : 0;
  }
  return 0;
}

/**
 * Collects one of the child process's streams, keeping at most `maxBytes` and merely counting
 * everything after that. The excess is discarded as it arrives rather than buffered and cut at
 * the end, so a `files` listing of a huge vault never sits in memory in full.
 */
export class CappedStream {
  private readonly chunks: Buffer[] = [];
  private keptBytes = 0;
  private droppedBytes = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    const room = this.maxBytes - this.keptBytes;
    if (room <= 0) {
      this.droppedBytes += chunk.length;
      return;
    }
    if (chunk.length <= room) {
      this.chunks.push(chunk);
      this.keptBytes += chunk.length;
      return;
    }
    this.chunks.push(chunk.subarray(0, room));
    this.keptBytes += room;
    this.droppedBytes += chunk.length - room;
  }

  /** How many bytes were thrown away. */
  get dropped(): number {
    return this.droppedBytes;
  }

  /**
   * The kept bytes as text. When the stream was cut, the cap may have landed in the middle of a
   * multi-byte character, so the trailing partial sequence is dropped instead of decoding to a
   * replacement character. Nothing is trimmed when the stream fit whole.
   */
  text(): string {
    const buf = Buffer.concat(this.chunks);
    if (this.droppedBytes === 0) return buf.toString("utf8");
    return buf.subarray(0, buf.length - danglingUtf8Bytes(buf)).toString("utf8");
  }
}

/**
 * The note appended to a truncated result. It has to be explicit: a silently cut list looks
 * exactly like a short one, and the model would report it as complete.
 */
export function truncationNotice(droppedBytes: number, maxBytes: number): string {
  return (
    `[Output truncated at ${maxBytes} bytes; ${droppedBytes} more bytes were dropped. ` +
    "What you see above is incomplete -- and no longer parseable if it was JSON. " +
    "Narrow the request down (folder=, ext=, limit=) and run it again, " +
    "or raise OBSIDIAN_MCP_MAX_OUTPUT_BYTES in the server's environment.]"
  );
}

/**
 * True when the CLI's output is one of its own error messages.
 *
 * The binary reports failures on stdout and still exits with 0: a missing note answers
 * `Error: File "x.md" not found.`, an unknown command answers `Error: Command "x" not found.`,
 * and both leave stderr empty. Going by the exit code alone therefore turns every failure into
 * a successful tool call whose text happens to say "Error".
 *
 * The match is deliberately narrow -- a SINGLE line starting with `Error: ` -- because the
 * output of `read` is the note itself, and a note that happens to open with a line like
 * "Error: connection refused" (a pasted log, a troubleshooting note) must not be reported as a
 * failed read. The CLI's own errors are always one line; a note that starts like one is not.
 */
export function looksLikeCliError(stdout: string): boolean {
  const text = stdout.trim();
  if (!text.startsWith("Error: ")) return false;
  return !text.includes("\n");
}

/**
 * Runs `obsidian <args...>` and captures the result. Never throws for a non-zero
 * exit code -- callers get `ok: false` plus stdout/stderr so the model can decide
 * what to do (e.g. surface the CLI's own error message back to the user).
 */
export function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const stdout = new CappedStream(MAX_OUTPUT_BYTES);
    const stderr = new CappedStream(MAX_OUTPUT_BYTES);
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (err) => {
      clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            `Could not find the "${CLI_BIN}" command. Make sure the official Obsidian CLI is installed ` +
              `and on your PATH (see https://obsidian.md/help/cli), or set OBSIDIAN_CLI_BIN to its full path.`
          )
        );
        return;
      }
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `Timed out after ${TIMEOUT_MS}ms waiting for "${CLI_BIN} ${args.join(" ")}". ` +
              `Is Obsidian running with CLI support enabled (Settings → General)?`
          )
        );
        return;
      }
      const text = stdout.text().trim();
      const truncatedBytes = stdout.dropped + stderr.dropped;
      const result: CliResult = {
        // A truncated stream is exempt from the text check: the cap can leave any long output
        // looking like a single line, and a real CLI error is short enough never to be cut.
        ok: code === 0 && !(truncatedBytes === 0 && looksLikeCliError(text)),
        code,
        stdout: text,
        stderr: stderr.text().trim(),
        truncatedBytes,
      };
      const parsed = tryParseJson(result.stdout);
      if (parsed !== undefined) result.json = parsed;
      resolve(result);
    });
  });
}

function tryParseJson(text: string): unknown | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Builds `key=value` style CLI arguments from an object, skipping undefined/empty
 * values. Values are passed as-is (the CLI expects `key=value`, not shell-quoted --
 * we bypass the shell entirely via spawn, so no quoting is needed).
 *
 * Booleans become a bare token (`overwrite`, `permanent`), which is the only form
 * the CLI understands: it silently ignores `--overwrite`, so `create ... --overwrite`
 * used to write a duplicate note instead of overwriting, and `delete ... --permanent`
 * moved the note to the trash. A false boolean emits nothing.
 */
export function kv(params: Record<string, string | number | boolean | undefined>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    if (typeof value === "boolean") {
      if (value) out.push(key);
      continue;
    }
    out.push(`${key}=${value}`);
  }
  return out;
}

/** Appends the default vault=... argument if OBSIDIAN_VAULT is set and the caller didn't specify one. */
export function withVault(args: string[]): string[] {
  if (!DEFAULT_VAULT) return args;
  if (args.some((a) => a.startsWith("vault="))) return args;
  return [...args, `vault=${DEFAULT_VAULT}`];
}

/** Formats a CliResult into the text block returned to the MCP client. */
export function formatResult(result: CliResult): string {
  const lines: string[] = [];
  if (result.ok) {
    lines.push(result.stdout || "(no output)");
  } else if (result.code === 0) {
    // The failure was spotted in the output, not in the exit code: the CLI's own one-line
    // message is the whole story, and quoting the exit code here would only confuse.
    lines.push(result.stdout);
  } else {
    // stderr first: on a failure it carries the actionable message, and the exit code on its
    // own says nothing. The code goes last, as a footnote.
    if (result.stderr) lines.push(`stderr: ${result.stderr}`);
    if (result.stdout) lines.push(`stdout: ${result.stdout}`);
    lines.push(`Obsidian CLI exited with code ${result.code}.`);
  }
  if (result.truncatedBytes > 0) {
    lines.push(truncationNotice(result.truncatedBytes, MAX_OUTPUT_BYTES));
  }
  return lines.join("\n");
}
