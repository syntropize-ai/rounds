import { describe, expect, it } from 'vitest';
import {
  rebuildChatEventsFromSession,
  shouldProcessSubscriptionEventDuringPost,
  type PersistedChatSessionEvent,
} from './useChat.js';
import type { ChatMessage } from './useDashboardChat.js';

describe('rebuildChatEventsFromSession', () => {
  it('replays persisted assistant replies in live-stream order', () => {
    const messages: ChatMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'delete ingress gateway dashboard',
        timestamp: '2026-05-12T01:00:00.000Z',
      },
      {
        id: 'assistant-final',
        role: 'assistant',
        content: 'Done.',
        timestamp: '2026-05-12T01:00:05.000Z',
      },
    ];
    const persistedEvents: PersistedChatSessionEvent[] = [
      {
        id: 'reply-1',
        seq: 0,
        kind: 'reply',
        payload: { type: 'reply', content: 'I found two matching dashboards.' },
        timestamp: '2026-05-12T01:00:01.000Z',
      },
      {
        id: 'tool-1',
        seq: 1,
        kind: 'tool_call',
        payload: {
          type: 'tool_call',
          tool: 'dashboard_list',
          displayText: 'Listing dashboards',
        },
        timestamp: '2026-05-12T01:00:02.000Z',
      },
      {
        id: 'tool-result-1',
        seq: 2,
        kind: 'tool_result',
        payload: {
          type: 'tool_result',
          tool: 'dashboard_list',
          summary: '2 dashboards',
          success: true,
        },
        timestamp: '2026-05-12T01:00:03.000Z',
      },
      {
        id: 'reply-2',
        seq: 3,
        kind: 'reply',
        payload: { type: 'reply', content: 'Which one should I delete?' },
        timestamp: '2026-05-12T01:00:04.000Z',
      },
    ];

    const rebuilt = rebuildChatEventsFromSession(messages, persistedEvents);

    expect(rebuilt.map((evt) => evt.kind)).toEqual([
      'message',
      'message',
      'tool_call',
      'tool_result',
      'message',
    ]);
    expect(rebuilt.map((evt) => evt.message?.content ?? evt.content)).toEqual([
      'delete ingress gateway dashboard',
      'I found two matching dashboards.',
      'Listing dashboards',
      '2 dashboards',
      'Which one should I delete?',
    ]);
    expect(rebuilt.some((evt) => evt.message?.id === 'assistant-final')).toBe(false);
  });

  it('keeps legacy assistant messages when no reply trace was persisted', () => {
    const messages: ChatMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'hello',
        timestamp: '2026-05-12T01:00:00.000Z',
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'hi',
        timestamp: '2026-05-12T01:00:01.000Z',
      },
    ];

    const rebuilt = rebuildChatEventsFromSession(messages, []);

    expect(rebuilt.map((evt) => evt.message?.content)).toEqual(['hello', 'hi']);
  });

  it('replays only queued messages that have not started or been deleted', () => {
    const persistedEvents: PersistedChatSessionEvent[] = [
      {
        id: 'q1',
        seq: 0,
        kind: 'message_queued',
        payload: {
          type: 'message_queued',
          queueItemId: 'q1',
          sessionId: 's1',
          position: 1,
          content: 'first',
        },
        timestamp: '2026-05-12T01:00:00.000Z',
      },
      {
        id: 'q2',
        seq: 1,
        kind: 'message_queued',
        payload: {
          type: 'message_queued',
          queueItemId: 'q2',
          sessionId: 's1',
          position: 2,
          content: 'second',
        },
        timestamp: '2026-05-12T01:00:01.000Z',
      },
      {
        id: 'q1-started',
        seq: 2,
        kind: 'queued_message_started',
        payload: {
          type: 'queued_message_started',
          queueItemId: 'q1',
          sessionId: 's1',
          runId: 'run-1',
          content: 'first',
        },
        timestamp: '2026-05-12T01:00:02.000Z',
      },
    ];

    const rebuilt = rebuildChatEventsFromSession([], persistedEvents);

    expect(rebuilt.map((evt) => evt.queuedMessage?.id).filter(Boolean)).toEqual(['q2']);
    expect(rebuilt.map((evt) => evt.message?.content).filter(Boolean)).toEqual(['first']);
  });
});

describe('shouldProcessSubscriptionEventDuringPost', () => {
  it('keeps queue drain events while suppressing mirrored active-run events', () => {
    expect(shouldProcessSubscriptionEventDuringPost('reply', false)).toBe(false);
    expect(shouldProcessSubscriptionEventDuringPost('done', false)).toBe(false);
    expect(shouldProcessSubscriptionEventDuringPost('queued_message_started', false)).toBe(true);
    expect(shouldProcessSubscriptionEventDuringPost('message_queue_deleted', false)).toBe(true);
    expect(shouldProcessSubscriptionEventDuringPost('reply', true)).toBe(true);
    expect(shouldProcessSubscriptionEventDuringPost('done', true)).toBe(true);
  });
});
