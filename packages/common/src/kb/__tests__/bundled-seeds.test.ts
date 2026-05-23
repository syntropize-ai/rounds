import { describe, it, expect } from 'vitest';
import { BUNDLED_SEEDS } from '../bundled-seeds.js';
import type { TemplateContent } from '../types.js';

interface MetricDocLike {
  description: string;
  keyMetrics: Array<{ metric: string; type: string; meaning: string; redFlag?: string }>;
  troubleshooting: string[];
}

describe('BUNDLED_SEEDS shape invariants', () => {
  it('every seed has a unique id', () => {
    const ids = BUNDLED_SEEDS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every seed has source=bundled, sourceRef=null, createdBy=null', () => {
    for (const s of BUNDLED_SEEDS) {
      expect(s.source).toBe('bundled');
      expect(s.sourceRef).toBeNull();
      expect(s.createdBy).toBeNull();
    }
  });

  it('every seed has non-empty intentTags', () => {
    for (const s of BUNDLED_SEEDS) {
      expect(Array.isArray(s.intentTags)).toBe(true);
      expect(s.intentTags.length).toBeGreaterThan(0);
    }
  });

  it('every metric_doc has at least 3 keyMetrics, troubleshooting and a description', () => {
    const docs = BUNDLED_SEEDS.filter((s) => s.kind === 'metric_doc');
    expect(docs.length).toBeGreaterThan(0);
    for (const s of docs) {
      const c = s.content as MetricDocLike;
      expect(typeof c.description).toBe('string');
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.keyMetrics.length).toBeGreaterThanOrEqual(3);
      expect(c.troubleshooting.length).toBeGreaterThan(0);
      for (const m of c.keyMetrics) {
        expect(m.metric).toBeTruthy();
        expect(['gauge', 'counter', 'histogram']).toContain(m.type);
        expect(m.meaning).toBeTruthy();
      }
    }
  });

  it('every template has at least 3 panels and at least 1 variable', () => {
    const tmpls = BUNDLED_SEEDS.filter((s) => s.kind === 'template');
    expect(tmpls.length).toBeGreaterThan(0);
    for (const s of tmpls) {
      const c = s.content as TemplateContent;
      expect(c.panels.length).toBeGreaterThanOrEqual(3);
      expect(c.variables.length).toBeGreaterThanOrEqual(1);
      // Panel ids unique within a template
      const pids = c.panels.map((p) => p.id);
      expect(new Set(pids).size).toBe(pids.length);
    }
  });

  it('every per-software metric_doc has a matching template (by slug)', () => {
    const metricSlugs = BUNDLED_SEEDS
      .filter((s) => s.id.startsWith('bundled-metric-'))
      .map((s) => s.id.replace('bundled-metric-', ''));
    for (const slug of metricSlugs) {
      const found = BUNDLED_SEEDS.find((s) => s.id === `bundled-template-${slug}`);
      expect(found, `expected matching template for slug ${slug}`).toBeDefined();
    }
  });
});
