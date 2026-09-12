/**
 * The tool declaration format and the one place that turns it into a registered MCP tool.
 *
 * WHY THIS EXISTS. Every tool here is the same three facts -- an MCP tool name, an Obsidian CLI
 * command, and a translation from arguments to `key=value` tokens -- and for a while each tool
 * wrote them out by hand, forty-odd times. Nothing held the three together, so four tools ended
 * up calling CLI commands that do not exist and the tests could not tell: the command name was
 * buried in the middle of a handler, next to an error check copied from the tool above.
 *
 * So a tool is now a DECLARATION (see ToolSpec): name, texts, annotations, input schema, the CLI
 * command, the tokens, which timeout tier it gets and whether it writes. The repeated parts --
 * running the CLI, turning the result into a CallToolResult, refusing a call that named no target,
 * keeping writers out of read-only mode -- live here and are declared by a field, not copied.
 *
 * A tool that genuinely is not "one CLI call, one text block" (setting several properties, one
 * call each) declares `run` instead of `tokens`, and still declares its command here.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import { formatResult, runCli, withVault, type CliResult, type TimeoutTier } from "../cli.js";
import { structuredData } from "../structured.js";
import { MISSING_TARGET } from "./params.js";

/** An input schema as registerTool takes it: one Zod schema per argument. */
export type InputShape = Record<string, z.ZodTypeAny>;

/** The parsed arguments a handler receives, derived from the tool's own input shape. */
export type ToolInput<Shape extends InputShape> = { [K in keyof Shape]: z.output<Shape[K]> };

/**
 * How a tool declares that it returns the CLI's JSON as structured content too. See
 * src/structured.ts for what happens when a call produces no JSON after all.
 */
export interface StructuredOutput<Shape extends InputShape = InputShape> {
  /** The single key of structuredContent that carries the data, e.g. `tasks`. */
  key: string;
  /** Schema of that key's value. Permissive on purpose: the shape belongs to the CLI. */
  schema: z.ZodType;
  /** What the key holds, for the declared outputSchema the client reads. */
  description: string;
  /**
   * Whether THIS call asked the CLI for JSON at all -- most of these tools can also answer in
   * plain text. Defaults to "always".
   */
  when?: (args: ToolInput<Shape>) => boolean;
}

/**
 * Everything there is to know about one tool.
 *
 * `annotations` is mandatory, because the spec tells clients to assume the worst when they are
 * missing -- without them, reading a note asks the user for the same confirmation as deleting
 * one. The criteria used across this server:
 *   readOnlyHint    -- the tool never writes to the vault.
 *   destructiveHint -- only meaningful when readOnlyHint is false. `true` means it can lose
 *                      existing content (delete, move, create with overwrite, property:remove);
 *                      `false` is reserved for the purely additive writers (append/prepend).
 *                      Where a call overwrites a value in place it is left undeclared, so the
 *                      client keeps its cautious default.
 *   idempotentHint  -- only meaningful when readOnlyHint is false, and only declared when
 *                      repeating the exact same call leaves the vault in the same state.
 *   openWorldHint   -- true everywhere: every result depends on a vault this server does not
 *                      own and the user can change under it at any moment.
 */
export interface ToolSpec<Shape extends InputShape = InputShape> {
  /** MCP tool name, e.g. `obsidian_read`. */
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: Shape;
  /**
   * The Obsidian CLI command this tool runs, e.g. `search:context` -- or, for the few whose
   * command depends on the arguments, a function of them. It is the command that actually gets
   * spawned, so it cannot drift away from the handler that used to hide it.
   */
  command: string | ((args: ToolInput<Shape>) => string);
  /** The tokens that follow the command. May throw: the message becomes the tool's answer. */
  tokens?: (args: ToolInput<Shape>) => string[];
  /**
   * For a tool that is not one CLI call and one text block. Receives the resolved command.
   * Declare either `tokens` or `run`, never both.
   */
  run?: (args: ToolInput<Shape>, command: string) => Promise<CallToolResult>;
  /**
   * Which timeout applies (see TIMEOUTS in cli.ts): `quick` for the tools that touch one note,
   * `slow` for the ones that sweep the vault, `normal` -- the default -- for the rest, writes
   * included.
   */
  tier?: TimeoutTier;
  /**
   * True for a tool THAT WRITES to the vault. This is the whole list of writers: there is no
   * second place that repeats it, and read-only mode simply does not register them, so they are
   * not in the list the model sees and there is nothing for the client to call. In the README
   * they are the rows with a tick in the "Writes" column.
   */
  writes?: boolean;
  /**
   * Refuse a call that gave neither `file` nor `path`. `true` answers with MISSING_TARGET; a
   * string answers with that text instead.
   */
  requireTarget?: boolean | string;
  /** Any further argument check. Returns the text to answer with, or undefined when the call is fine. */
  check?: (args: ToolInput<Shape>) => string | undefined;
  /**
   * Declared for the tools whose CLI command answers in JSON: they also return that JSON parsed,
   * as structuredContent, and advertise its shape as their outputSchema.
   */
  output?: StructuredOutput<Shape>;
}

/** A spec with its input shape erased, which is how the registry stores a list of them. */
export type AnyToolSpec = ToolSpec<InputShape>;

/**
 * Declares one tool. The only reason this function exists is type inference: inside the literal
 * it passes through, `tokens`, `run` and `check` get their arguments typed from `inputSchema`,
 * and the return type erases the shape so that tools with different schemas share one array.
 */
export function defineTool<Shape extends InputShape>(spec: ToolSpec<Shape>): AnyToolSpec {
  return spec as unknown as AnyToolSpec;
}

/** Builds an error CallToolResult without going near the CLI. */
export function errorResult(text: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
  };
}

/**
 * Runs the CLI and turns the result into a CallToolResult.
 *
 * `result.ok` is false both when the binary exits non-zero and when it reports one of its own
 * errors on stdout while exiting 0 (see looksLikeCliError in cli.ts), which is what it does for
 * a missing note or an out-of-range line. Every tool goes through here, so the detection is
 * shared rather than repeated per tool.
 *
 * Calls are queued, so the wait for a free slot does not eat into the timeout.
 *
 * A tool that declared `output` also gets structuredContent -- always, when the call succeeded,
 * even if it is the empty object that says "no JSON this time". A failed call needs none: the
 * SDK does not validate the output of a result flagged as an error.
 */
async function respond(
  argv: string[],
  tier: TimeoutTier = "normal",
  output?: StructuredOutput,
  input?: ToolInput<InputShape>
): Promise<CallToolResult> {
  const result: CliResult = await runCli(withVault(argv), tier);
  const answer: CallToolResult = {
    isError: !result.ok,
    content: [{ type: "text" as const, text: formatResult(result) }],
  };
  if (output && result.ok) {
    const asked = output.when?.(input ?? {}) ?? true;
    answer.structuredContent = asked ? structuredData(result, output.key, output.schema) : {};
  }
  return answer;
}

/** Turns a declaration into the handler registerTool calls. */
function handlerFor(spec: AnyToolSpec) {
  return async (args: ToolInput<InputShape>): Promise<CallToolResult> => {
    if (spec.requireTarget && !args.file && !args.path) {
      return errorResult(typeof spec.requireTarget === "string" ? spec.requireTarget : MISSING_TARGET);
    }

    const complaint = spec.check?.(args);
    if (complaint) return errorResult(complaint);

    let command: string;
    let argv: string[];
    try {
      command = typeof spec.command === "function" ? spec.command(args) : spec.command;
      // Both the command and the tokens may refuse the arguments (an unusable path, a key that is
      // not a CLI option name): their message is the answer, and the CLI is never reached.
      argv = spec.run ? [] : [command, ...(spec.tokens?.(args) ?? [])];
    } catch (err) {
      return errorResult((err as Error).message);
    }

    if (spec.run) return spec.run(args, command);
    return respond(argv, spec.tier, spec.output, args);
  };
}

/**
 * The outputSchema a tool with structured output advertises: one optional key holding the data.
 * Optional because the same tool legitimately answers in plain text (see src/structured.ts).
 */
function outputShape(output: StructuredOutput): InputShape {
  return { [output.key]: output.schema.optional().describe(output.description) };
}

/**
 * Registers every tool in `specs`, in order, skipping the writers when read-only mode is on.
 *
 * The cast on the callback is the price of holding tools with different input schemas in one
 * array: registerTool infers its handler's arguments from the `inputSchema` it is given in the
 * same call, which it cannot do for a shape it only knows as InputShape. Each handler still gets
 * its arguments typed, at the point that matters -- inside defineTool, against its own schema.
 */
export function registerTools(
  server: McpServer,
  specs: AnyToolSpec[],
  options: { readonly: boolean }
): void {
  for (const spec of specs) {
    if (spec.writes && options.readonly) continue;
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        annotations: spec.annotations,
        inputSchema: spec.inputSchema,
        ...(spec.output ? { outputSchema: outputShape(spec.output) } : {}),
      },
      handlerFor(spec) as Parameters<typeof server.registerTool>[2]
    );
  }
}
