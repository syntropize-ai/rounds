import { describe, it, expect } from 'vitest';
import { BUNDLED_SEEDS } from '../bundled-seeds.js';

describe('BUNDLED_SEEDS shape invariants', () => {
  it('has broad built-in coverage', () => {
    expect(BUNDLED_SEEDS.length).toBeGreaterThanOrEqual(40);
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

  it('ships compact Istio and Kubernetes alert guidance', () => {
    const ids = new Set(BUNDLED_SEEDS.map((s) => s.id));
    const istio = BUNDLED_SEEDS.find((s) => s.id === 'bundled-istio');
    expect(istio?.title).toBe('Istio');
    expect(istio?.body).toContain('## Data plane dashboard');
    expect(istio?.body).toContain('## Control plane dashboard');
    expect(istio?.body).toContain('## Alerts');
    expect(ids.has('bundled-k8s-workload-alerts')).toBe(true);
  });

  it('covers common infra, cloud, and managed-service families', () => {
    const ids = new Set(BUNDLED_SEEDS.map((s) => s.id));
    for (const id of [
      'bundled-prometheus',
      'bundled-loki',
      'bundled-opentelemetry-collector',
      'bundled-elasticsearch',
      'bundled-clickhouse',
      'bundled-aws-eks',
      'bundled-aws-rds',
      'bundled-gcp-gke',
      'bundled-gcp-pubsub',
      'bundled-azure-aks',
      'bundled-azure-cosmosdb',
    ]) {
      expect(ids.has(id)).toBe(true);
    }
  });
});
