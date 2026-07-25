import { describe, expect, it } from 'vitest';
import { AT_BOTTOM_THRESHOLD_PX, isAtBottom, shouldFollowNewOutput } from '../scroll-follow.js';

describe('isAtBottom', () => {
  it('treats an exactly-bottomed viewport as at the bottom', () => {
    expect(isAtBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
  });

  it('tolerates sub-pixel rounding within the threshold', () => {
    expect(
      isAtBottom({ scrollTop: 600 - AT_BOTTOM_THRESHOLD_PX, scrollHeight: 1000, clientHeight: 400 }),
    ).toBe(true);
  });

  it('is false once the reader has scrolled up past the threshold', () => {
    expect(
      isAtBottom({
        scrollTop: 600 - AT_BOTTOM_THRESHOLD_PX - 1,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
    ).toBe(false);
  });

  it('is true when the content does not overflow', () => {
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 400, clientHeight: 400 })).toBe(true);
  });
});

describe('shouldFollowNewOutput', () => {
  it('does not scroll an empty transcript', () => {
    expect(
      shouldFollowNewOutput({ eventCount: 0, previousEventCount: 0, following: true }),
    ).toBe(false);
  });

  it('follows streamed output while the reader is at the bottom', () => {
    expect(
      shouldFollowNewOutput({ eventCount: 8, previousEventCount: 7, following: true }),
    ).toBe(true);
  });

  it('stops following once the reader has scrolled up', () => {
    expect(
      shouldFollowNewOutput({ eventCount: 8, previousEventCount: 7, following: false }),
    ).toBe(false);
  });

  it('keeps ignoring further streamed events while scrolled up', () => {
    expect(
      shouldFollowNewOutput({ eventCount: 40, previousEventCount: 39, following: false }),
    ).toBe(false);
  });

  it('opens a freshly loaded transcript at the latest message', () => {
    expect(
      shouldFollowNewOutput({ eventCount: 25, previousEventCount: 0, following: false }),
    ).toBe(true);
  });

  it('snaps to the bottom when a shorter transcript replaces the current one', () => {
    expect(
      shouldFollowNewOutput({ eventCount: 3, previousEventCount: 25, following: false }),
    ).toBe(true);
  });
});
