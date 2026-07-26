/**
 * These strings appear in the chat transcript where an answer would go.
 *
 * The user asked "why is checkout latency high?" and the reply was
 * `Stream request failed: 500 Internal Server Error` — with their own message
 * still above it, looking delivered. Whether it was actually sent is the first
 * thing they need to know and the thing the old copy never said.
 */

import { describe, it, expect } from 'vitest';
import { describeStreamFailure, describeSubscriptionLoss } from './streaming.js';

const STATUSES = [400, 404, 413, 429, 500, 502, 503];

describe('describeStreamFailure', () => {
  it('never shows a raw status line', () => {
    for (const status of STATUSES) {
      const msg = describeStreamFailure(status);
      expect(msg, String(status)).not.toMatch(/Internal Server Error|Bad Gateway|Stream request failed/);
      expect(msg.startsWith('HTTP'), String(status)).toBe(false);
    }
  });

  it('always says whether the message was sent', () => {
    // Without this the user does not know whether to retype it, and a retry
    // may duplicate an action the agent already started.
    for (const status of STATUSES) {
      const msg = describeStreamFailure(status);
      if (status === 404) continue; // the conversation is gone; nothing to resend into
      expect(msg, String(status)).toContain('not sent');
    }
  });

  it('always gives the reader something to do', () => {
    for (const status of STATUSES) {
      expect(describeStreamFailure(status), String(status))
        .toMatch(/send it again|Send it again|Start a new one|report it/);
    }
  });

  it('separates a server fault from a client one', () => {
    expect(describeStreamFailure(503)).toContain('server');
    expect(describeStreamFailure(429)).toContain('rate-limited');
    // A malformed request is not something the user can fix, so it says so and
    // keeps the number for whoever they report it to.
    expect(describeStreamFailure(400)).toContain('bug');
    expect(describeStreamFailure(400)).toContain('400');
  });

  it('does not tell someone to resend into a conversation that is gone', () => {
    const msg = describeStreamFailure(404);
    expect(msg).toContain('no longer exists');
    expect(msg).not.toContain('again');
  });
});

describe('describeSubscriptionLoss', () => {
  it('does not claim the run stopped, because it may not have', () => {
    // The request landed. Telling the user their message failed would be a
    // second lie on top of the first — and might get an action run twice.
    const msg = describeSubscriptionLoss();
    expect(msg).toContain('may still be going');
    expect(msg).toContain('reload');
    expect(msg).not.toContain('not sent');
    expect(msg).not.toMatch(/subscription|giving up|Failed to fetch/);
  });
});
