import type { ServerContext } from '../context.js';
import { writeAudit } from '../core/audit.js';

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(message: string, extra: Record<string, unknown> = {}): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message, ...extra }, null, 2) }],
    isError: true,
  };
}

/**
 * Wraps a mutating tool: writes the audit row (with redacted args) and turns a
 * thrown error into a tool error rather than a transport failure. Read-only
 * tools skip the audit write and use `readTool`.
 */
export function auditedTool<A>(
  ctx: ServerContext,
  toolName: string,
  handler: (args: A) => Promise<{ result: ToolResult; summary: string }>,
): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      const { result, summary } = await handler(args);
      await writeAudit(ctx.db, {
        actor: ctx.config.actor,
        tool: toolName,
        args,
        resultSummary: summary,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await writeAudit(ctx.db, {
        actor: ctx.config.actor,
        tool: toolName,
        args,
        resultSummary: `ERROR: ${message}`,
      });
      return errorResult(message);
    }
  };
}

export function readTool<A>(handler: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };
}
