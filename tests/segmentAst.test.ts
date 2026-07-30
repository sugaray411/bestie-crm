import { describe, expect, it } from 'vitest';
import { compileSegment, SegmentAstError, segmentQuery } from '../src/core/segmentAst.js';

describe('compileSegment', () => {
  it('compiles a simple equality to a bound parameter', () => {
    const { where, params } = compileSegment({ field: 'lifecycle_stage', op: 'eq', value: 'trial' });
    expect(where).toBe('c.lifecycle_stage = $1');
    expect(params).toEqual(['trial']);
  });

  it('never inlines a value into the SQL string', () => {
    const { where, params } = compileSegment({ field: 'country', op: 'eq', value: "US'; drop table crm.contacts;--" });
    expect(where).toBe('c.country = $1');
    expect(where).not.toContain('drop');
    expect(params[0]).toBe("US'; drop table crm.contacts;--");
  });

  it('combines and/or/not with correctly numbered parameters', () => {
    const { where, params } = compileSegment({
      and: [
        { field: 'lifecycle_stage', op: 'eq', value: 'trial' },
        { or: [{ field: 'country', op: 'eq', value: 'US' }, { field: 'country', op: 'eq', value: 'CA' }] },
        { not: { field: 'source', op: 'eq', value: 'import' } },
      ],
    });
    expect(where).toBe('(c.lifecycle_stage = $1 and (c.country = $2 or c.country = $3) and (not c.source = $4))');
    expect(params).toEqual(['trial', 'US', 'CA', 'import']);
  });

  it('supports tag membership', () => {
    const { where, params } = compileSegment({ field: 'tags', op: 'has_tag', value: 'beta' });
    expect(where).toBe('c.tags @> array[$1]::text[]');
    expect(params).toEqual(['beta']);
  });

  it('escapes LIKE wildcards so a search value cannot widen the match', () => {
    const { params } = compileSegment({ field: 'email', op: 'contains', value: '100%_real' });
    expect(params).toEqual(['%100\\%\\_real%']);
  });

  it('binds within_days as a number rather than splicing an interval', () => {
    const { where, params } = compileSegment({ field: 'created_at', op: 'within_days', value: 30 });
    expect(where).toBe("c.created_at > now() - ($1::int * interval '1 day')");
    expect(params).toEqual([30]);
  });

  it('keeps NULL rows on a not-equal comparison', () => {
    const { where } = compileSegment({ field: 'source', op: 'neq', value: 'ads' });
    expect(where).toBe('(c.source is distinct from $1)');
  });
});

describe('rejections', () => {
  it('rejects a raw SQL definition by name', () => {
    expect(() => compileSegment({ sql: 'select * from public.users' })).toThrow(SegmentAstError);
    expect(() => compileSegment({ sql: 'select 1' })).toThrow(/Raw SQL is not accepted/);
  });

  it.each(['raw', 'query', 'where', 'expression'])('rejects a "%s" key', (key) => {
    expect(() => compileSegment({ [key]: 'anything' })).toThrow(/Raw SQL is not accepted/);
  });

  it('rejects a field that is not on the allow-list', () => {
    expect(() => compileSegment({ field: 'password_hash', op: 'eq', value: 'x' })).toThrow(/Unknown segment field/);
  });

  it('rejects reaching into another table through the field name', () => {
    expect(() => compileSegment({ field: 'id) or true--', op: 'eq', value: 'x' })).toThrow(/Unknown segment field/);
  });

  it('rejects an operator that does not belong to the field type', () => {
    expect(() => compileSegment({ field: 'tags', op: 'contains', value: 'x' })).toThrow(/not allowed on tags/);
    expect(() => compileSegment({ field: 'lifecycle_stage', op: 'starts_with', value: 'a' })).toThrow(/not allowed/);
  });

  it('rejects an unknown operator', () => {
    expect(() => compileSegment({ field: 'email', op: 'regex', value: '.*' })).toThrow(/not allowed on email/);
  });

  it('rejects an array where a scalar is required and vice versa', () => {
    expect(() => compileSegment({ field: 'country', op: 'eq', value: ['US', 'CA'] })).toThrow(/requires a single value/);
    expect(() => compileSegment({ field: 'country', op: 'in', value: 'US' })).toThrow(/non-empty array/);
  });

  it('rejects an over-long IN list', () => {
    const value = Array.from({ length: 501 }, (_, i) => `v${i}`);
    expect(() => compileSegment({ field: 'country', op: 'in', value })).toThrow(/at most 500/);
  });

  it('rejects nesting deeper than the limit', () => {
    let node: unknown = { field: 'country', op: 'eq', value: 'US' };
    for (let i = 0; i < 8; i += 1) node = { not: node };
    expect(() => compileSegment(node)).toThrow(/nests deeper/);
  });

  it('rejects an unparseable timestamp', () => {
    expect(() => compileSegment({ field: 'created_at', op: 'before', value: 'last tuesday' })).toThrow(/not a valid timestamp/);
  });

  it('rejects a non-object definition', () => {
    expect(() => compileSegment('lifecycle_stage = trial')).toThrow(/must be an object/);
    expect(() => compileSegment(null)).toThrow(/must be an object/);
  });

  it('rejects unknown extra keys on a condition', () => {
    expect(() => compileSegment({ field: 'country', op: 'eq', value: 'US', limit: 10 })).toThrow(SegmentAstError);
  });
});

describe('segmentQuery', () => {
  it('builds a parameterized contacts query', () => {
    const query = segmentQuery({ field: 'lifecycle_stage', op: 'eq', value: 'active' }, { limit: 10 });
    expect(query.text).toBe('select c.* from crm.contacts c where c.lifecycle_stage = $1 order by c.created_at desc limit $2');
    expect(query.values).toEqual(['active', 10]);
  });

  it('supports a count projection', () => {
    const query = segmentQuery({ field: 'country', op: 'eq', value: 'US' }, { select: 'count(*)::int as count' });
    expect(query.text).toBe('select count(*)::int as count from crm.contacts c where c.country = $1');
    expect(query.values).toEqual(['US']);
  });
});
