import { describe, it, expect } from 'vitest';
import type { ToolDefinition } from '@agentic-obs/llm-gateway';
import {
  searchTools,
  selectTools,
  formatToolSearchObservation,
} from './tool-search.js';

function def(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    input_schema: { type: 'object', properties: {}, required: [] },
  };
}

const REGISTRY: Record<string, ToolDefinition> = {
  'metrics.query': def('metrics.query', 'Run an instant PromQL query against a metrics datasource.'),
  'metrics.range_query': def('metrics.range_query', 'Run a range PromQL query over a time window.'),
  'logs.query': def('logs.query', 'Run a logs query (LogQL for Loki) over an explicit window.'),
  'alert_rule.list': def('alert_rule.list', 'List existing alert rules. Pass a filter keyword.'),
};

describe('selectTools — exact-name lookup', () => {
  it('returns matched defs in the requested order, skipping unknowns', () => {
    const result = selectTools(['logs.query', 'nope', 'metrics.query'], REGISTRY);
    expect(result.map((d) => d.name)).toEqual(['logs.query', 'metrics.query']);
  });

  it('returns an empty list when no names match', () => {
    expect(selectTools(['x', 'y'], REGISTRY)).toEqual([]);
  });

  it('ignores blank entries', () => {
    expect(selectTools(['', '  ', 'metrics.query'], REGISTRY).map((d) => d.name))
      .toEqual(['metrics.query']);
  });
});

describe('searchTools — keyword search', () => {
  it('matches a single keyword in name or description (case-insensitive)', () => {
    const result = searchTools('promql', REGISTRY);
    expect(result.map((d) => d.name).sort()).toEqual(['metrics.query', 'metrics.range_query']);
  });

  it('requires every term to match', () => {
    const result = searchTools('logs query', REGISTRY);
    expect(result.map((d) => d.name)).toEqual(['logs.query']);
  });

  it('ranks name-hits above description-only hits', () => {
    const result = searchTools('query', REGISTRY);
    // metrics.query, metrics.range_query, logs.query all hit name; alert_rule.list does not.
    expect(result.map((d) => d.name)).toEqual([
      'logs.query',
      'metrics.query',
      'metrics.range_query',
    ]);
  });

  it('routes select: prefix to selectTools', () => {
    const result = searchTools('select:logs.query,metrics.query', REGISTRY);
    expect(result.map((d) => d.name)).toEqual(['logs.query', 'metrics.query']);
  });

  it('returns empty for blank query', () => {
    expect(searchTools('', REGISTRY)).toEqual([]);
    expect(searchTools('   ', REGISTRY)).toEqual([]);
  });
});

describe('formatToolSearchObservation', () => {
  it('wraps each def in a <function>...</function> line inside <functions>', () => {
    const out = formatToolSearchObservation([REGISTRY['metrics.query']!]);
    expect(out.startsWith('<functions>\n')).toBe(true);
    expect(out.endsWith('\n</functions>')).toBe(true);
    expect(out).toContain('<function>');
    expect(out).toContain('"name":"metrics.query"');
    expect(out).toContain('"parameters"');
  });

  it('returns a hint when no defs matched', () => {
    expect(formatToolSearchObservation([])).toContain('No tools matched');
  });
});
