import { z } from 'zod';

/**
 * Segment definitions are a small filter AST, never SQL. The AST is validated
 * against an allow-list of fields and operators and compiled to a parameterized
 * WHERE clause, so a definition can express "active users in Germany" and cannot
 * express anything else -- no subqueries, no function calls, no string splicing.
 */

export class SegmentAstError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SegmentAstError';
  }
}

/** Column -> its Postgres type class, which decides the legal operators. */
const FIELDS = {
  email: 'text',
  phone: 'text',
  name: 'text',
  source: 'text',
  locale: 'text',
  country: 'text',
  timezone: 'text',
  lifecycle_stage: 'enum',
  rc_app_user_id: 'text',
  tags: 'text[]',
  created_at: 'timestamptz',
  updated_at: 'timestamptz',
} as const;

export type SegmentField = keyof typeof FIELDS;
export const SEGMENT_FIELDS = Object.keys(FIELDS) as SegmentField[];

const OPERATORS_BY_TYPE = {
  text: ['eq', 'neq', 'in', 'not_in', 'contains', 'starts_with', 'is_null', 'is_not_null'],
  enum: ['eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null'],
  'text[]': ['has_tag', 'has_any_tag', 'has_all_tags', 'is_null', 'is_not_null'],
  timestamptz: ['before', 'after', 'within_days', 'is_null', 'is_not_null'],
} as const;

export const SEGMENT_OPERATORS = [
  ...new Set(Object.values(OPERATORS_BY_TYPE).flatMap((ops) => [...ops])),
];

const ScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

const ConditionSchema = z
  .object({
    field: z.string(),
    op: z.string(),
    value: z.union([ScalarSchema, z.array(ScalarSchema)]).optional(),
  })
  .strict();

export type Condition = z.infer<typeof ConditionSchema>;

export type SegmentNode =
  | Condition
  | { and: SegmentNode[] }
  | { or: SegmentNode[] }
  | { not: SegmentNode };

const NodeSchema: z.ZodType<SegmentNode> = z.lazy(() =>
  z.union([
    z.object({ and: z.array(NodeSchema).min(1) }).strict(),
    z.object({ or: z.array(NodeSchema).min(1) }).strict(),
    z.object({ not: NodeSchema }).strict(),
    ConditionSchema,
  ]),
);

export const SegmentDefinitionSchema = NodeSchema;

export interface CompiledSegment {
  /** A WHERE-clause fragment referencing only crm.contacts columns. */
  where: string;
  params: unknown[];
}

const MAX_DEPTH = 6;
const MAX_IN_LIST = 500;

/**
 * Compiles an AST to `{ where, params }`. Every value becomes a bound parameter;
 * every identifier comes from the FIELDS allow-list. Nothing user-supplied is
 * ever concatenated into the SQL string.
 */
export function compileSegment(definition: unknown, paramOffset = 0): CompiledSegment {
  const parsed = parseDefinition(definition);
  const params: unknown[] = [];
  const where = compileNode(parsed, params, paramOffset, 0);
  return { where, params };
}

export function parseDefinition(definition: unknown): SegmentNode {
  if (definition === null || typeof definition !== 'object') {
    throw new SegmentAstError('Segment definition must be an object.');
  }
  // Catches the obvious "just let me write SQL" attempt with a message that
  // explains the rule rather than a generic schema error.
  for (const key of ['sql', 'raw', 'query', 'where', 'expression']) {
    if (key in (definition as Record<string, unknown>)) {
      throw new SegmentAstError(
        `Raw SQL is not accepted in a segment definition (found "${key}"). ` +
          `Use the filter AST: {field, op, value} combined with and/or/not. Allowed fields: ${SEGMENT_FIELDS.join(', ')}.`,
      );
    }
  }
  const result = NodeSchema.safeParse(definition);
  if (!result.success) {
    throw new SegmentAstError(`Invalid segment definition: ${result.error.issues[0]?.message ?? 'unknown error'}`);
  }
  return result.data;
}

function compileNode(node: SegmentNode, params: unknown[], offset: number, depth: number): string {
  if (depth > MAX_DEPTH) {
    throw new SegmentAstError(`Segment definition nests deeper than ${MAX_DEPTH} levels.`);
  }
  if ('and' in node) {
    return `(${node.and.map((n) => compileNode(n, params, offset, depth + 1)).join(' and ')})`;
  }
  if ('or' in node) {
    return `(${node.or.map((n) => compileNode(n, params, offset, depth + 1)).join(' or ')})`;
  }
  if ('not' in node) {
    return `(not ${compileNode(node.not, params, offset, depth + 1)})`;
  }
  return compileCondition(node, params, offset);
}

function compileCondition(condition: Condition, params: unknown[], offset: number): string {
  const field = condition.field as SegmentField;
  const type = FIELDS[field];
  if (type === undefined) {
    throw new SegmentAstError(
      `Unknown segment field "${condition.field}". Allowed: ${SEGMENT_FIELDS.join(', ')}.`,
    );
  }

  const allowedOps: readonly string[] = OPERATORS_BY_TYPE[type];
  if (!allowedOps.includes(condition.op)) {
    throw new SegmentAstError(
      `Operator "${condition.op}" is not allowed on ${field} (${type}). Allowed: ${allowedOps.join(', ')}.`,
    );
  }

  const col = `c.${field}`;
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${offset + params.length}`;
  };

  const requireScalar = (): string | number | boolean => {
    const v = condition.value;
    if (v === undefined || v === null || Array.isArray(v)) {
      throw new SegmentAstError(`Operator "${condition.op}" on ${field} requires a single value.`);
    }
    return v;
  };

  const requireArray = (): Array<string | number | boolean> => {
    const v = condition.value;
    if (!Array.isArray(v) || v.length === 0) {
      throw new SegmentAstError(`Operator "${condition.op}" on ${field} requires a non-empty array.`);
    }
    if (v.length > MAX_IN_LIST) {
      throw new SegmentAstError(`Operator "${condition.op}" on ${field} accepts at most ${MAX_IN_LIST} values.`);
    }
    return v;
  };

  switch (condition.op) {
    case 'eq':
      return `${col} = ${bind(requireScalar())}`;
    case 'neq':
      // `<> value` drops NULL rows in SQL; "not equal" should keep them.
      return `(${col} is distinct from ${bind(requireScalar())})`;
    case 'in':
      return `${col} = any(${bind(requireArray())})`;
    case 'not_in':
      return `(${col} is null or not (${col} = any(${bind(requireArray())})))`;
    case 'contains':
      return `${col} ilike ${bind(`%${escapeLike(String(requireScalar()))}%`)}`;
    case 'starts_with':
      return `${col} ilike ${bind(`${escapeLike(String(requireScalar()))}%`)}`;
    case 'is_null':
      return `${col} is null`;
    case 'is_not_null':
      return `${col} is not null`;
    case 'has_tag':
      return `${col} @> array[${bind(String(requireScalar()))}]::text[]`;
    case 'has_any_tag':
      return `${col} && ${bind(requireArray().map(String))}::text[]`;
    case 'has_all_tags':
      return `${col} @> ${bind(requireArray().map(String))}::text[]`;
    case 'before':
      return `${col} < ${bind(toTimestamp(requireScalar()))}`;
    case 'after':
      return `${col} > ${bind(toTimestamp(requireScalar()))}`;
    case 'within_days': {
      const days = Number(requireScalar());
      if (!Number.isFinite(days) || days <= 0 || days > 3650) {
        throw new SegmentAstError('"within_days" needs a positive number of days (max 3650).');
      }
      // Bound as a number and cast, so the interval is never string-spliced.
      return `${col} > now() - (${bind(days)}::int * interval '1 day')`;
    }
    default:
      throw new SegmentAstError(`Unsupported operator "${condition.op}".`);
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function toTimestamp(value: string | number | boolean): string {
  const date = new Date(typeof value === 'boolean' ? NaN : value);
  if (Number.isNaN(date.getTime())) {
    throw new SegmentAstError(`"${String(value)}" is not a valid timestamp.`);
  }
  return date.toISOString();
}

/** The full contacts query for a segment, ready to hand to pg. */
export function segmentQuery(
  definition: unknown,
  opts: { limit?: number; offset?: number; select?: string } = {},
): { text: string; values: unknown[] } {
  const { where, params } = compileSegment(definition);
  const values = [...params];
  const select = opts.select ?? 'c.*';
  let text = `select ${select} from crm.contacts c where ${where}`;
  if (opts.limit !== undefined) {
    values.push(opts.limit);
    text += ` order by c.created_at desc limit $${values.length}`;
  }
  if (opts.offset !== undefined) {
    values.push(opts.offset);
    text += ` offset $${values.length}`;
  }
  return { text, values };
}
