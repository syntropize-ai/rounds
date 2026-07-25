/**
 * Scroll-follow rules for the chat transcript. DOM-free on purpose so they are
 * unit-testable (the web package has no jsdom).
 */

/** Sub-pixel layout rounding means the distance is rarely exactly 0. */
export const AT_BOTTOM_THRESHOLD_PX = 24;

export interface ScrollPosition {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Whether the reader is parked at (or within a few px of) the latest output. */
export function isAtBottom(
  position: ScrollPosition,
  threshold = AT_BOTTOM_THRESHOLD_PX,
): boolean {
  return position.scrollHeight - position.scrollTop - position.clientHeight <= threshold;
}

/**
 * Whether a transcript update should jump to the latest output.
 * - a replaced transcript (fresh mount, loaded history, new session) always
 *   opens at the latest message
 * - live output only follows while the reader is still at the bottom, so
 *   scrolling up to read earlier output is not undone by the next token
 */
export function shouldFollowNewOutput(input: {
  eventCount: number;
  previousEventCount: number;
  following: boolean;
}): boolean {
  if (input.eventCount === 0) return false;
  const isReplacedTranscript =
    input.previousEventCount === 0 || input.eventCount < input.previousEventCount;
  if (isReplacedTranscript) return true;
  return input.following;
}
