import { spawn } from "node:child_process";

/** Name of the Obsidian CLI binary. Override with OBSIDIAN_CLI_BIN if it's not on PATH. */
const CLI_BIN = process.env.OBSIDIAN_CLI_BIN?.trim() || "obsidian";

/** Optional vault name/path to target when the user has more than one vault open. */
const DEFAULT_VAULT = process.env.OBSIDIAN_VAULT?.trim();

/** How long to wait for the CLI (and therefore the running Obsidian app) to respond. */
const TIMEOUT_MS = Number(process.env.OBSIDIAN_CLI_TIMEOUT_MS) || 20_000;

export interface CliResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON when it looked like JSON, otherwise undefined. */
  json?: unknown;
}

export class CliError extends Error {
  constructor(public result: CliResult, message: string) {
    super(message);
    this.name = "CliError";
  }
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

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

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
      const result: CliResult = {
        ok: code === 0,
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
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
 */
export function kv(params: Record<string, string | number | boolean | undefined>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    if (typeof value === "boolean") {
      if (value) out.push(`--${key}`);
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
  if (result.ok) {
    return result.stdout || "(sin salida)";
  }
  const lines = [`El comando de Obsidian CLI terminó con código ${result.code}.`];
  if (result.stderr) lines.push(`stderr: ${result.stderr}`);
  if (result.stdout) lines.push(`stdout: ${result.stdout}`);
  return lines.join("\n");
}
