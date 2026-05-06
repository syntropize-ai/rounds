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
  'metrics_query': def('metrics_query', 'Run an instant PromQL query against a metrics datasource.'),
  'metrics_range_query': def('metrics_range_query', 'Run a range PromQL query over a time window.'),
  'logs_query': def('logs_query', 'Run a logs query (LogQL for Loki) over an explicit window.'),
  'alert_rule_list': def('alert_rule_list', 'List existing alert rules. Pass a filter keyword.'),
};

describe('selectTools — exact-name lookup', () => {
  it('returns matched defs in the requested order, skipping unknowns', () => {
    const result = selectTools(['logs_query', 'nope', 'metrics_query'], REGISTRY);
    expect(result.map((d) => d.name)).toEqual(['logs_query', 'metrics_query']);
  });

  it('returns an empty list when no names match', () => {
    expect(selectTools(['x', 'y'], REGISTRY)).toEqual([]);
  });

  it('ignores blank entries', () => {
    expect(selectTools(['', '  ', 'metrics_query'], REGISTRY).map((d) => d.name))
      .toEqual(['metrics_query']);
  });
});

describe('searchTools — keyword search', () => {
  it('matches a single keyword in name or description (case-insensitive)', () => {
    const result = searchTools('promql', REGISTRY);
    expect(result.map((d) => d.name).sort()).toEqual(['metrics_query', 'metrics_range_query']);
  });

  it('OR-matches any term and ranks tools matching MORE distinct terms first', () => {
    // OR semantics: 'logs query' returns logs_query (matches both terms) FIRST,
    // then metrics_query and metrics_range_query (each matches only "query").
    // This is the regression fix — under the old AND semantics, only logs_query
    // came back, hiding the metrics tools entirely.
    const result = searchTools('logs query', REGISTRY);
    expect(result.map((d) => d.name)).toEqual([
      'logs_query',           // matches both "logs" + "query" via name parts = 2 terms
      'metrics_query',        // matches "query" via name parts = 1 term
      'metrics_range_query',  // matches "query" via name parts = 1 term
    ]);
  });

  it('ranks name-hits above description-only hits when termsHit ties', () => {
    const result = searchTools('query', REGISTRY);
    // metrics_query, metrics_range_query, logs_query all hit name; alert_rule_list does not.
    expect(result.map((d) => d.name)).toEqual([
      'logs_query',
      'metrics_query',
      'metrics_range_query',
    ]);
  });

  it('matches via tool-name parts even when the term is absent from the description', () => {
    // The flagship regression case: 'complete investigation' should surface
    // investigation_complete via name-part parsing. Under the old algorithm
    // this returned 0 because "complete" appears in no description.
    const investRegistry: Record<string, ToolDefinition> = {
      investigation_create: def('investigation_create', 'Start a new investigation record.'),
      investigation_complete: def('investigation_complete', 'Finalize the active investigation.'),
      metrics_query: def('metrics_query', 'Run an instant PromQL query.'),
    };
    const result = searchTools('complete investigation', investRegistry);
    // investigation_complete matches both "complete" (name part) and
    // "investigation" (name part); investigation_create matches only one.
    expect(result.map((d) => d.name)).toEqual([
      'investigation_complete',
      'investigation_create',
    ]);
  });

  it('exact tool-name fast path returns just that tool', () => {
    const result = searchTools('metrics_query', REGISTRY);
    expect(result.map((d) => d.name)).toEqual(['metrics_query']);
  });

  it('word-boundary matching prevents false positives from substrings', () => {
    const localRegistry: Record<string, ToolDefinition> = {
      operate_thing: def('operate_thing', 'A tool that operates on something.'),
      rate_limiter: def('rate_limiter', 'Limits the rate of requests.'),
    };
    // Term "rate" must NOT match "operate" via substring. Old algorithm did.
    const result = searchTools('rate', localRegistry);
    expect(result.map((d) => d.name)).toEqual(['rate_limiter']);
  });

  it('routes select: prefix to selectTools', () => {
    const result = searchTools('select:logs_query,metrics_query', REGISTRY);
    expect(result.map((d) => d.name)).toEqual(['logs_query', 'metrics_query']);
  });

  it('returns empty for blank query', () => {
    expect(searchTools('', REGISTRY)).toEqual([]);
    expect(searchTools('   ', REGISTRY)).toEqual([]);
  });
});

describe('formatToolSearchObservation', () => {
  it('wraps each def in a <function>...</function> line inside <functions>', () => {
    const out = formatToolSearchObservation([REGISTRY['metrics_query']!]);
    expect(out.startsWith('<functions>\n')).toBe(true);
    expect(out.endsWith('\n</functions>')).toBe(true);
    expect(out).toContain('<function>');
    expect(out).toContain('"name":"metrics_query"');
    expect(out).toContain('"parameters"');
  });

  it('returns a hint when no defs matched', () => {
    expect(formatToolSearchObservation([])).toContain('No tools matched');
  });
});
