import { describe, it, expect } from 'vitest';
import { relativeTime, relativeTimeFromElapsed, expiryLabel } from './time.js';

const NOW = Date.parse('2026-04-17T12:00:00Z');
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const SECOND = 1000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('relativeTime', () => {
  it('walks up the unit ladder', () => {
    expect(relativeTime(at(-30 * SECOND), NOW)).toBe('just now');
    expect(relativeTime(at(-MINUTE), NOW)).toBe('1m ago');
    expect(relativeTime(at(-32 * MINUTE), NOW)).toBe('32m ago');
    expect(relativeTime(at(-3 * HOUR), NOW)).toBe('3h ago');
    expect(relativeTime(at(-9 * DAY), NOW)).toBe('9d ago');
    expect(relativeTime(at(-45 * DAY), NOW)).toBe('1mo ago');
    expect(relativeTime(at(-800 * DAY), NOW)).toBe('2y ago');
  });

  it('keeps counting in days past a week rather than switching to a date', () => {
    // The sidebar's copy used to fall back to toLocaleDateString after 7 days.
    expect(relativeTime(at(-8 * DAY), NOW)).toBe('8d ago');
  });

  it('clamps future timestamps to just now', () => {
    expect(relativeTime(at(2 * HOUR), NOW)).toBe('just now');
  });
});

describe('relativeTimeFromElapsed', () => {
  it('adds second-level precision below a minute', () => {
    expect(relativeTimeFromElapsed(0)).toBe('just now');
    expect(relativeTimeFromElapsed(999)).toBe('just now');
    expect(relativeTimeFromElapsed(5 * SECOND)).toBe('5s ago');
    expect(relativeTimeFromElapsed(59 * SECOND)).toBe('59s ago');
    expect(relativeTimeFromElapsed(MINUTE)).toBe('1m ago');
    expect(relativeTimeFromElapsed(2 * HOUR)).toBe('2h ago');
  });
});

describe('expiryLabel', () => {
  it('counts down while the deadline is still ahead', () => {
    expect(expiryLabel(at(32 * MINUTE), NOW)).toBe('expires in 32m');
    expect(expiryLabel(at(3 * HOUR), NOW)).toBe('expires in 3h');
    expect(expiryLabel(at(2 * DAY), NOW)).toBe('expires in 2d');
  });

  it('says "in <1m" rather than "just now" for the final minute', () => {
    expect(expiryLabel(at(30 * SECOND), NOW)).toBe('expires in <1m');
    expect(expiryLabel(at(SECOND), NOW)).toBe('expires in <1m');
  });

  it('flips to past tense at the boundary', () => {
    expect(expiryLabel(at(0), NOW)).toBe('expired just now');
    expect(expiryLabel(at(-30 * SECOND), NOW)).toBe('expired just now');
    expect(expiryLabel(at(-5 * MINUTE), NOW)).toBe('expired 5m ago');
    expect(expiryLabel(at(-4 * HOUR), NOW)).toBe('expired 4h ago');
  });
});
