import { spawn } from "node:child_process";

/** Name of the Obsidian CLI binary. Override with OBSIDIAN_CLI_BIN if it's not on PATH. */
const CLI_BIN = process.env.OBSIDIAN_CLI_BIN?.trim() || "obsidian";

/** Optional vault name/path to target when the user has more than one vault open. */
const DEFAULT_VAULT = process.env.OBSIDIAN_VAULT?.trim();

/** Reads a positive integer from the environment, falling back when it is unset or nonsense. */
function readPositiveInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/**
 * How long to wait for the CLI (and therefore the running Obsidian app) to respond, per kind of
 * call: reading one note is not the same job as searching a whole vault, and a single global
 * number has to be generous enough for the second, which leaves the first hanging for ages.
 *
 * OBSIDIAN_CLI_TIMEOUT_MS remains the baseline, so raising it (a big or slow vault) still moves
 * all three; the other two variables override their tier on top of that.
 */
const BASE_TIMEOUT_MS = readPositiveInt("OBSIDIAN_CLI_TIMEOUT_MS", 20_000);

export const TIMEOUTS = {
  /** One note, one folder, one property: whatever should come back almost at once. */
  quick: readPositiveInt("OBSIDIAN_CLI_TIMEOUT_QUICK_MS", Math.round(BASE_TIMEOUT_MS / 2)),
  /** Anything else, writes included. */
  normal: BASE_TIMEOUT_MS,
  /** Vault-wide work: searching, listing every file, rewriting links on a move. */
  slow: readPositiveInt("OBSIDIAN_CLI_TIMEOUT_SLOW_MS", BASE_TIMEOUT_MS * 3),
} as const;

export type TimeoutTier = keyof typeof TIMEOUTS;

/**
 * Grace given to a timed-out process between SIGTERM and SIGKILL. SIGTERM first so the CLI can
 * drop its connection to the app tidily; SIGKILL only for one that ignores it.
 */
const KILL_GRACE_MS = readPositiveInt("OBSIDIAN_CLI_KILL_GRACE_MS", 2_000);

/**
 * How many CLI processes may talk to Obsidian at once. One by default: they all reach the same
 * running app, and firing them in parallel is what makes it stall. Measured: twelve deletes in
 * a row stopped answering on the eighth for over two minutes, while the binary replied normally
 * again moments later -- contention, not a genuine timeout. Raise OBSIDIAN_MCP_CONCURRENCY only
 * if you have measured that your setup takes it.
 */
const MAX_CONCURRENCY = readPositiveInt("OBSIDIAN_MCP_CONCURRENCY", 1);

/**
 * How much of each stream is handed back to the MCP client. Listing a large vault or
 * searching without `limit` can produce hundreds of kB, which either buries the model's
 * context or blows past the client's maximum message size. Override with
 * OBSIDIAN_MCP_MAX_OUTPUT_BYTES.
 *
 * This is the DEFAULT, not the only cap: it is sized for output that reaches the model, and a
 * caller that consumes the output itself and never forwards it can ask runCli for a bigger one.
 */
export const MAX_OUTPUT_BYTES = readPositiveInt("OBSIDIAN_MCP_MAX_OUTPUT_BYTES", 50_000);

export interface CliResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON when it looked like JSON, otherwise undefined. */
  json?: unknown;
  /** Bytes dropped across both streams because they exceeded the cap. 0 when nothing was cut. */
  truncatedBytes: number;
  /**
   * The cap this call's streams were actually held to. Carried on the result because it is no
   * longer one number for the whole server: a truncation notice that quoted the module constant
   * would name a limit the call never had.
   */
  maxOutputBytes: number;
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

/** Longest argument value quoted verbatim in a message. Past it, only its size is reported. */
const MAX_ARG_VALUE_CHARS = 60;

/**
 * Renders a command line for an error message with the long values left out.
 *
 * `content=` carries the whole text of a note, and an error message ends up in the MCP client's
 * log: a daily:append that hit the timeout used to copy the note's text outside the vault and
 * outside whatever encryption it has. Keys stay, short values stay (they are what makes the
 * message useful -- which note, which format), and anything long becomes `<1234 chars>`.
 */
export function describeArgs(args: string[]): string {
  return args
    .map((token) => {
      const split = token.indexOf("=");
      if (split < 0) return token; // a bare option, e.g. `total`
      const value = token.slice(split + 1);
      if (value.length <= MAX_ARG_VALUE_CHARS) return token;
      return `${token.slice(0, split)}=<${value.length} chars>`;
    })
    .join(" ");
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

// --- The queue -------------------------------------------------------------
//
// Waiting for a slot is NOT counted against the timeout: the timer starts once the process is
// spawned, so a call held behind a slow search is not punished for someone else's work.

let running = 0;
const waiting: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (running < MAX_CONCURRENCY) {
    running++;
    return Promise.resolve();
  }
  return new Promise<void>((grant) => waiting.push(grant));
}

function releaseSlot(): void {
  const next = waiting.shift();
  // Hand the slot straight over instead of freeing it: the count never dips and no wake-up is lost.
  if (next) next();
  else running--;
}

/**
 * Runs `obsidian <args...>` and captures the result, one process at a time (see the queue
 * above). Never throws for a non-zero exit code -- callers get `ok: false` plus stdout/stderr
 * so the model can decide what to do (e.g. surface the CLI's own error message back to the
 * user). It does reject on a timeout, on a missing binary and on a spawn error.
 *
 * @param args CLI tokens, already including any `vault=`.
 * @param tier Which timeout applies. See TIMEOUTS; defaults to `normal`.
 * @param maxOutputBytes How much of each stream to keep. Defaults to MAX_OUTPUT_BYTES, which is
 *        the size for output that ends up in the model's context. Pass a bigger one only when the
 *        caller PARSES the output and throws the text away, so the size costs memory and nothing
 *        else -- see the listing cap in src/resources.ts.
 */
export async function runCli(
  args: string[],
  tier: TimeoutTier = "normal",
  maxOutputBytes: number = MAX_OUTPUT_BYTES
): Promise<CliResult> {
  await acquireSlot();
  try {
    return await spawnCli(args, TIMEOUTS[tier], maxOutputBytes);
  } finally {
    releaseSlot();
  }
}

function spawnCli(args: string[], timeoutMs: number, maxOutputBytes: number): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const stdout = new CappedStream(maxOutputBytes);
    const stderr = new CappedStream(maxOutputBytes);
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const succeed = (result: CliResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const timer = setTimeout(() => {
      // SIGTERM first so the CLI can let go of the app cleanly, SIGKILL if it does not.
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      // The caller is answered here rather than from `close`: that event waits for the stdio
      // pipes, and a grandchild of the CLI keeps them open after the kill (measured with a
      // stand-in binary: a 500ms timeout only reported back after the full 5s run). The kill
      // is still escalated above, so nothing is left running.
      fail(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for "${CLI_BIN} ${describeArgs(args)}". ` +
            `Is Obsidian running with CLI support enabled (Settings → General)?`
        )
      );
    }, timeoutMs);

    const stopTimers = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (err) => {
      stopTimers();
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        fail(
          new Error(
            `Could not find the "${CLI_BIN}" command. Make sure the official Obsidian CLI is installed ` +
              `and on your PATH (see https://obsidian.md/help/cli), or set OBSIDIAN_CLI_BIN to its full path.`
          )
        );
        return;
      }
      fail(err);
    });

    child.on("close", (code) => {
      stopTimers();
      if (settled) return; // already reported as a timeout
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
        maxOutputBytes,
      };
      const parsed = tryParseJson(result.stdout);
      if (parsed !== undefined) result.json = parsed;
      succeed(result);
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
 * The token names this server is allowed to send. Keys come from the code, never from the
 * model, and they stay that way because of this check: a key is half a CLI token, so whoever
 * chooses it chooses which option the CLI sees. A property named `vault` once became the token
 * `vault=Other`, which made withVault leave its own out and sent the whole call to another
 * vault. The rule belongs here, in the code, rather than in someone's memory.
 */
const SAFE_KEY = /^[a-z][a-z0-9_-]*$/;

/**
 * Builds `key=value` style CLI arguments from an object, skipping only the keys whose value is
 * `undefined`. Values are passed as-is (the CLI expects `key=value`, not shell-quoted -- we
 * bypass the shell entirely via spawn, so no quoting is needed).
 *
 * An EMPTY STRING is a value, not an absence: it is how you ask for an empty property or an
 * empty line in the daily note, and dropping it turned the call into one without that argument,
 * so the model was told it had cleared a field that never changed.
 *
 * Booleans become a bare token (`overwrite`, `permanent`), which is the only form
 * the CLI understands: it silently ignores `--overwrite`, so `create ... --overwrite`
 * used to write a duplicate note instead of overwriting, and `delete ... --permanent`
 * moved the note to the trash. A false boolean emits nothing.
 *
 * @throws If a key is not a plain CLI token name (see SAFE_KEY).
 */
export function kv(params: Record<string, string | number | boolean | undefined>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (!SAFE_KEY.test(key)) {
      throw new Error(`"${key}" is not a valid Obsidian CLI option name and was not sent.`);
    }
    if (value === undefined) continue;
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
    lines.push(truncationNotice(result.truncatedBytes, result.maxOutputBytes));
  }
  return lines.join("\n");
}
