/**
 * Tests for chat integration of inline_chart events:
 *   1. groupEvents treats inline_chart as a standalone message block (NOT
 *      merged into an agent activity block), so the chart renders as a
 *      first-class bubble rather than inside the tool-step accordion.
 *   2. payloadToChatEvent (useChat replay path) reconstructs a chat event
 *      from a persisted inline_chart payload, so reloading a session
 *      restores the chart bubble identically.
 *   3. Idempotency: re-deriving the same id for the same content collapses
 *      replays.
 */
import { describe, it, expect } from 'vitest';
import { groupEvents } from '../event-processing.js';
import type { ChatEvent } from '../../../hooks/useDashboardChat.js';
import {
  deriveInlineChartId,
  parseInlineChartPayload,
} from '../../../hooks/useDashboardChat.js';
import { payloadToChatEvent } from '../../../hooks/useChat.js';

function inlineChartEvent(id: string): ChatEvent {
  return {
    id,
    kind: 'inline_chart',
    inlineChart: {
      id,
      query: 'up',
      datasourceId: 'ds1',
      timeRange: { start: '2025-01-01T00:00Z', end: '2025-01-01T01:00Z' },
      step: '60s',
      metricKind: 'gauge',
      series: [],
      summary: { kind: 'gauge', oneLine: '', stats: {} },
      pivotSuggestions: [],
    },
  };
}

describe('groupEvents with inline_chart', () => {
  it('treats inline_chart as a standalone message block', () => {
    const events: ChatEvent[] = [
      { id: 't1', kind: 'tool_call', tool: 'metric_explore', content: 'querying' },
      inlineChartEvent('c1'),
      { id: 't2', kind: 'tool_result', tool: 'metric_explore', content: 'done' },
    ];
    const blocks = groupEvents(events);
    // Expect: [agent-block(tool_call), message-block(chart), agent-block(tool_result)]
    expect(blocks.map((b) => b.type)).toEqual(['agent', 'message', 'agent']);
    const second = blocks[1]!;
    expect(second.type === 'message' && second.event.kind).toBe('inline_chart');
  });

  it('flushes the in-flight agent block when a chart arrives', () => {
    const events: ChatEvent[] = [
      { id: 't1', kind: 'tool_call', tool: 'metric_explore', content: 'querying' },
      inlineChartEvent('c1'),
    ];
    const blocks = groupEvents(events);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe('agent');
    expect(blocks[1]!.type).toBe('message');
  });
});

describe('groupEvents with ops confirmations', () => {
  it('pauses the transcript at a pending ops confirmation', () => {
    const events: ChatEvent[] = [
      { id: 't1', kind: 'tool_call', tool: 'ops_cluster_shell', content: 'running' },
      {
        id: 'c1',
        kind: 'ops_command_confirmation_required',
        opsConfirmation: {
          id: 'confirm-1',
          connectorId: 'kube-prod',
          command: 'istioctl install -y',
          status: 'pending',
        },
      },
      {
        id: 'm1',
        kind: 'message',
        message: {
          id: 'm1',
          role: 'assistant',
          content: 'Istio installed successfully.',
          timestamp: '2026-01-01T00:00:00Z',
        },
      },
    ];

    const blocks = groupEvents(events);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe('agent');
    expect(blocks[1]!.type === 'message' && blocks[1]!.event.kind).toBe('ops_command_confirmation_required');
  });

  it('releases the transcript after an ops confirmation resolves', () => {
    const events: ChatEvent[] = [
      { id: 't1', kind: 'tool_call', tool: 'ops_cluster_shell', content: 'running' },
      {
        id: 'c1',
        kind: 'ops_command_confirmation_required',
        opsConfirmation: {
          id: 'confirm-1',
          connectorId: 'kube-prod',
          command: 'istioctl install -y',
          status: 'pending',
        },
      },
      {
        id: 'r1',
        kind: 'ops_command_confirmation_resolved',
        opsConfirmation: {
          id: 'confirm-1',
          connectorId: '',
          command: '',
          status: 'executed',
        },
      },
      {
        id: 'm1',
        kind: 'message',
        message: {
          id: 'm1',
          role: 'assistant',
          content: 'Istio installed successfully.',
          timestamp: '2026-01-01T00:00:00Z',
        },
      },
    ];

    const blocks = groupEvents(events);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]!.type === 'message' && blocks[1]!.event.opsConfirmation?.status).toBe('executed');
    expect(blocks[2]!.type === 'message' && blocks[2]!.event.kind).toBe('message');
  });
});

describe('payloadToChatEvent replay', () => {
  it('reconstructs an inline_chart ChatEvent from a persisted payload', () => {
    const payload = {
      type: 'inline_chart',
      query: 'rate(http_requests_total[5m])',
      datasourceId: 'ds1',
      timeRange: { start: '2025-01-01T00:00Z', end: '2025-01-01T01:00Z' },
      step: '60s',
      metricKind: 'counter',
      series: [],
      summary: { kind: 'counter', oneLine: '12 rps avg', stats: {} },
      pivotSuggestions: [],
    };
    const evt = payloadToChatEvent('persisted-id', 'inline_chart', payload);
    expect(evt).not.toBeNull();
    expect(evt!.kind).toBe('inline_chart');
    expect(evt!.inlineChart?.query).toBe('rate(http_requests_total[5m])');
    // id is derived from content, not the original DB id — same content =
    // same id across replays / live SSE.
    expect(evt!.id).toBe(
      deriveInlineChartId(
        payload.query,
        payload.datasourceId,
        payload.timeRange.start,
        payload.timeRange.end,
      ),
    );
  });

  it('returns null for an inline_chart with missing fields', () => {
    expect(payloadToChatEvent('id', 'inline_chart', { query: 'up' })).toBeNull();
  });
});

describe('idempotency', () => {
  it('same payload → same id on both live and replay paths', () => {
    const payload = {
      type: 'inline_chart',
      query: 'up',
      datasourceId: 'ds1',
      timeRange: { start: 's', end: 'e' },
      step: '60s',
      metricKind: 'gauge',
      series: [],
      summary: { kind: 'gauge', oneLine: '', stats: {} },
      pivotSuggestions: [],
    };
    const live = parseInlineChartPayload(payload);
    const replay = payloadToChatEvent('whatever', 'inline_chart', payload);
    expect(live!.id).toBe(replay!.id);
  });
});
