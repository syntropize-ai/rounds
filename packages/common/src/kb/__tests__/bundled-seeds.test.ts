import { describe, it, expect } from 'vitest';
import { BUNDLED_SEEDS } from '../bundled-seeds.js';

describe('BUNDLED_SEEDS shape invariants', () => {
  it('has exactly 18 entries', () => {
    expect(BUNDLED_SEEDS.length).toBe(18);
  });

  it('every seed has a unique id', () => {
    const ids = BUNDLED_SEEDS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every id starts with bundled-', () => {
    for (const s of BUNDLED_SEEDS) {
      expect(s.id.startsWith('bundled-')).toBe(true);
    }
  });

  it('every seed has source=bundled, sourceRef=null, createdBy=null', () => {
    for (const s of BUNDLED_SEEDS) {
      expect(s.source).toBe('bundled');
      expect(s.sourceRef).toBeNull();
      expect(s.createdBy).toBeNull();
    }
  });

  it('every seed has non-empty title and description (<=300 chars)', () => {
    for (const s of BUNDLED_SEEDS) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.description.length).toBeLessThanOrEqual(300);
    }
  });

  it('every body is non-empty and has at least one ## heading', () => {
    for (const s of BUNDLED_SEEDS) {
      expect(s.body.length).toBeGreaterThan(0);
      expect(/^##\s/m.test(s.body)).toBe(true);
    }
  });

  it('every seed has non-empty intentTags', () => {
    for (const s of BUNDLED_SEEDS) {
      expect(Array.isArray(s.intentTags)).toBe(true);
      expect(s.intentTags.length).toBeGreaterThan(0);
    }
  });
});
