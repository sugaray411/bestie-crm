import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerContext } from '../context.js';
import { auditedTool, errorResult, jsonResult, readTool } from './helpers.js';
import {
  compileSegment,
  parseDefinition,
  SEGMENT_FIELDS,
  SEGMENT_OPERATORS,
  SegmentAstError,
  segmentQuery,
} from '../core/segmentAst.js';
import { getSegment } from '../db/repo.js';
import { publicContact } from './contacts.js';
import type { Contact } from '../types.js';

const DEFINITION_HELP =
  'A filter AST, not SQL. A condition is {field, op, value}; combine with {and:[...]}, {or:[...]}, {not:{...}}. ' +
  `Fields: ${SEGMENT_FIELDS.join(', ')}. Operators: ${SEGMENT_OPERATORS.join(', ')}. ` +
  'Example: {"and":[{"field":"lifecycle_stage","op":"eq","value":"trial"},{"field":"created_at","op":"within_days","value":30}]}';

export function registerSegmentTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'crm_create_segment',
    {
      title: 'Create segment',
      description:
        'Saves a reusable audience definition. The definition is a safe filter AST compiled to a ' +
        'parameterized query -- raw SQL is rejected. ' + DEFINITION_HELP,
      inputSchema: {
        name: z.string().min(2),
        definition: z.record(z.unknown()).describe(DEFINITION_HELP),
      },
    },
    auditedTool(ctx, 'crm_create_segment', async (args) => {
      let compiled;
      try {
        compiled = compileSegment(args.definition);
      } catch (err) {
        if (err instanceof SegmentAstError) {
          return { result: errorResult(err.message), summary: `rejected segment "${args.name}"` };
        }
        throw err;
      }

      const { rows } = await ctx.db.query<{ id: string }>(
        `insert into crm.segments (name, definition) values ($1, $2::jsonb)
         on conflict (name) do update set definition = excluded.definition
         returning id`,
        [args.name, JSON.stringify(args.definition)],
      );

      // Compiling proves it parses; running it proves it is valid SQL against
      // the real table, which is worth knowing before a campaign depends on it.
      const query = segmentQuery(args.definition, { select: 'count(*)::int as count' });
      const { rows: countRows } = await ctx.db.query<{ count: number }>(query.text, query.values);

      return {
        result: jsonResult({
          id: rows[0]!.id,
          name: args.name,
          matches: countRows[0]?.count ?? 0,
          compiled_where: compiled.where,
        }),
        summary: `saved segment "${args.name}" matching ${countRows[0]?.count ?? 0} contacts`,
      };
    }),
  );

  server.registerTool(
    'crm_preview_segment',
    {
      title: 'Preview segment',
      description:
        'Counts and samples the contacts a segment matches. Never sends anything. Accepts either a saved ' +
        'segment name/id or an inline definition.',
      inputSchema: {
        segment: z.string().optional().describe('Saved segment name or id'),
        definition: z.record(z.unknown()).optional().describe(DEFINITION_HELP),
        sample_size: z.number().int().min(0).max(50).default(5),
      },
    },
    readTool(async (args) => {
      let definition: unknown;
      let name = 'inline';
      if (args.segment) {
        const saved = await getSegment(ctx.db, args.segment);
        if (!saved) return errorResult(`No segment named "${args.segment}".`);
        definition = saved.definition;
        name = saved.name;
      } else if (args.definition) {
        definition = args.definition;
      } else {
        return errorResult('Provide either a saved `segment` or an inline `definition`.');
      }

      try {
        parseDefinition(definition);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }

      const countQuery = segmentQuery(definition, { select: 'count(*)::int as count' });
      const { rows: countRows } = await ctx.db.query<{ count: number }>(countQuery.text, countQuery.values);

      const sampleSize = args.sample_size ?? 5;
      let sample: Contact[] = [];
      if (sampleSize > 0) {
        const sampleQuery = segmentQuery(definition, { limit: sampleSize });
        const { rows } = await ctx.db.query<Contact>(sampleQuery.text, sampleQuery.values);
        sample = rows;
      }

      return jsonResult({
        segment: name,
        matches: countRows[0]?.count ?? 0,
        sample: sample.map(publicContact),
        note: 'Preview only. Nothing was sent.',
      });
    }),
  );

  server.registerTool(
    'crm_list_segments',
    {
      title: 'List segments',
      description: 'Lists saved segments with their definitions.',
      inputSchema: { limit: z.number().int().min(1).max(100).default(50) },
    },
    readTool(async (args) => {
      const { rows } = await ctx.db.query(
        `select id, name, definition, created_at from crm.segments order by created_at desc limit $1`,
        [args.limit ?? 50],
      );
      return jsonResult({ count: rows.length, segments: rows });
    }),
  );
}
