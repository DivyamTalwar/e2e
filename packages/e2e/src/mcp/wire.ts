/**
 * Defines the JSON lines sent between an attached session and the run's
 * socket, plus requests relayed from the runner to the worker with the
 * paused test. Each line has a zod schema and an inferred type.
 *
 * Only the socket server (`cli/step-control.ts`) and `e2e mcp`
 * (`mcp/attach.ts`) import the schemas. Workers import only the types, so
 * they don't load zod. The runner loads the schemas on runs that may use
 * the socket. A terminal `--step` run only reads keys.
 */

import { z } from 'zod';
import type { McpToolResult } from './tools.ts';

/** The MCP tool result envelope a worker answers with. */
const ToolResult = z.looseObject({
  content: z.array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), text: z.string() }),
      z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }),
    ]),
  ),
  isError: z.exactOptional(z.boolean()),
}) satisfies z.ZodType<McpToolResult>;

/**
 * The first line `e2e mcp` sends to attach to a shown pause. The connection
 * stays open until the session detaches.
 */
export const AttachStart = z.object({ attach: z.literal(true) });

/**
 * Requests sent by an attached session, one line each. `tools` asks for the
 * catalog or one tool. `call` runs a catalog tool.
 */
export const AttachCall = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tools'), tool: z.string().optional() }),
  z.object({ type: z.literal('call'), tool: z.string(), args: z.record(z.string(), z.unknown()) }),
]);
export type AttachCall = z.infer<typeof AttachCall>;

/**
 * A request from the runner to the worker with the paused test. `open`
 * starts the attached session, `AttachCall` uses it, and `close` detaches it.
 * The test stays paused.
 */
export type AttachRequest = { readonly type: 'open' } | AttachCall | { readonly type: 'close' };

/**
 * The run's reply to each line, in request order. Each reply has a result
 * with the paused test's target, or a refusal. The run hangs up when the
 * session ends.
 */
export const AttachReply = z.union([
  z.object({ result: ToolResult, target: z.string() }),
  z.object({ error: z.object({ code: z.string(), message: z.string() }) }),
]);
export type AttachReply = z.infer<typeof AttachReply>;
