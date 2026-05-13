/**
 * Tests for Task 11 — expandable agent activity step cards.
 *
 * Uses `renderToStaticMarkup` (matching the pattern in AskUserPrompt.test.tsx)
 * to assert rendered DOM. State-dependent behavior (Show full toggle, aria-
 * expanded) is exercised by rendering with different controlled inputs and
 * checking the exact markup, since the web package does not have jsdom.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import AgentActivityBlock, { ToolCallCardView } from '../AgentActivityBlock.js';
import {
  buildToolCalls,
  groupEvents,
  liveAgentBlockId,
  type ToolCallCard,
} from '../event-processing.js';
import type { ChatEvent } from '../../../hooks/useDashboardChat.js';

function makeToolCallEvent(idx: number, params?: Record<string, unknown>): ChatEvent {
  return {
    id: `call-${idx}`,
    kind: 'tool_call',
    tool: 'metrics_query',
    content: 'Querying metrics',
    ...(params ? { params } : {}),
  };
}

function makeResultEvent(idx: number, content = 'ok'): ChatEvent {
  return {
    id: `res-${idx}`,
    kind: 'tool_result',
    tool: 'metrics_query',
    content,
    success: true,
  };
}

describe('buildToolCalls', () => {
  it('produces one card per tool_call (no phase merging)', () => {
    const events: ChatEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(makeToolCallEvent(i, { sourceId: 'prom', query: `up{i="${i}"}` }));
      events.push(makeResultEvent(i));
    }
    const cards = buildToolCalls(events);
    expect(cards).toHaveLength(5);
    expect(cards.every((c) => c.tool === 'metrics_query')).toBe(true);
    expect(cards.every((c) => c.status === 'done')).toBe(true);
  });

  it('redacts secret-keyed fields from params', () => {
    const events: ChatEvent[] = [
      makeToolCallEvent(0, {
        query: 'up',
        api_key: 'sk-leakme',
        nested: { password: 'hunter2', label: 'env' },
      }),
      makeResultEvent(0),
    ];
    const [card] = buildToolCalls(events);
    expect(card?.params?.api_key).toBe('[REDACTED]');
    const nested = card?.params?.nested as Record<string, unknown>;
    expect(nested.password).toBe('[REDACTED]');
    expect(nested.label).toBe('env');
    expect(card?.params?.query).toBe('up');
  });

  it('marks failed results as error', () => {
    const events: ChatEvent[] = [
      makeToolCallEvent(0),
      { id: 'res-0', kind: 'tool_result', tool: 'metrics_query', content: 'boom', success: false },
    ];
    const [card] = buildToolCalls(events);
    expect(card?.status).toBe('error');
  });

  it('keeps unmatched tool_call as running', () => {
    const events: ChatEvent[] = [makeToolCallEvent(0)];
    const [card] = buildToolCalls(events);
    expect(card?.status).toBe('running');
  });
});

describe('ToolCallCardView', () => {
  it('renders five distinct cards for five metrics_query events', () => {
    const events: ChatEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(makeToolCallEvent(i));
      events.push(makeResultEvent(i, `result ${i}`));
    }
    const cards = buildToolCalls(events);
    const html = cards
      .map((card) => renderToStaticMarkup(<ToolCallCardView card={card} />))
      .join('');
    const matches = html.match(/data-tool-call-card/g) ?? [];
    expect(matches).toHaveLength(5);
  });

  it('renders truncated output with Show full button when output > 200 chars', () => {
    const long = 'x'.repeat(250);
    const card: ToolCallCard = {
      id: 'c1',
      tool: 'metrics_query',
      label: 'Querying metrics',
      status: 'done',
      output: long,
    };
    const html = renderToStaticMarkup(<ToolCallCardView card={card} />);
    expect(html).toContain('Show full');
    // Truncated to 200 chars + ellipsis
    expect(html).toMatch(/x{200}…/);
    // The full 250-x string is NOT shown
    expect(html).not.toMatch(/x{250}/);
  });

  it('does not render Show full button when output <= 200 chars', () => {
    const short = 'short output';
    const card: ToolCallCard = {
      id: 'c1',
      tool: 'metrics_query',
      label: 'Querying metrics',
      status: 'done',
      output: short,
    };
    const html = renderToStaticMarkup(<ToolCallCardView card={card} />);
    expect(html).not.toContain('Show full');
  });

  it('omits cost / evidence chips gracefully when fields absent', () => {
    const card: ToolCallCard = {
      id: 'c1',
      tool: 'metrics_query',
      label: 'Querying metrics',
      status: 'done',
    };
    const html = renderToStaticMarkup(<ToolCallCardView card={card} />);
    expect(html).not.toContain('tool-call-cost');
    expect(html).not.toContain('tool-call-evidence');
  });

  it('renders sanitized params (no leaked secret values)', () => {
    const events: ChatEvent[] = [
      makeToolCallEvent(0, { query: 'up', api_key: 'sk-leakme' }),
      makeResultEvent(0),
    ];
    const [card] = buildToolCalls(events);
    const html = renderToStaticMarkup(<ToolCallCardView card={card!} />);
    expect(html).not.toContain('sk-leakme');
    expect(html).toContain('[REDACTED]');
  });
});

describe('AgentActivityBlock aria-expanded', () => {
  it('exposes aria-expanded=true when isLive (auto-expanded)', () => {
    const events: ChatEvent[] = [makeToolCallEvent(0), makeResultEvent(0)];
    const html = renderToStaticMarkup(<AgentActivityBlock events={events} isLive={true} />);
    expect(html).toContain('aria-expanded="true"');
  });

  it('exposes aria-expanded=false when not live (auto-collapsed)', () => {
    const events: ChatEvent[] = [makeToolCallEvent(0), makeResultEvent(0)];
    const html = renderToStaticMarkup(<AgentActivityBlock events={events} isLive={false} />);
    expect(html).toContain('aria-expanded="false"');
  });
});

describe('liveAgentBlockId', () => {
  it('does not mark the previous agent block live after a new user message', () => {
    const events: ChatEvent[] = [
      makeToolCallEvent(0),
      makeResultEvent(0),
      {
        id: 'user-1',
        kind: 'message',
        message: {
          id: 'user-1',
          role: 'user',
          content: 'next request',
          timestamp: '2026-05-12T01:00:00.000Z',
        },
      },
    ];

    const blocks = groupEvents(events);
    expect(liveAgentBlockId(blocks, true)).toBeNull();
  });

  it('marks only the trailing agent block live once new agent activity starts', () => {
    const events: ChatEvent[] = [
      makeToolCallEvent(0),
      makeResultEvent(0),
      {
        id: 'user-1',
        kind: 'message',
        message: {
          id: 'user-1',
          role: 'user',
          content: 'next request',
          timestamp: '2026-05-12T01:00:00.000Z',
        },
      },
      { id: 'think-1', kind: 'thinking', content: 'Thinking...' },
    ];

    const blocks = groupEvents(events);
    expect(liveAgentBlockId(blocks, true)).toBe('think-1');
  });
});
