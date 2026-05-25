import { describe, expect, it } from 'vitest';
import { hybridKnowledgeSearch } from '../hybrid-search.js';

describe('hybridKnowledgeSearch', () => {
  it('combines lexical and semantic signals for exact system intents', () => {
    const hits = hybridKnowledgeSearch(
      [
        {
          id: 'istio',
          title: 'Istio data plane dashboard',
          description: 'Envoy sidecar resource usage and ingress gateway traffic.',
          intentTags: ['istio', 'service-mesh', 'envoy'],
        },
        {
          id: 'envoy',
          title: 'Envoy standalone',
          description: 'Standalone proxy upstream and downstream traffic.',
          intentTags: ['envoy', 'proxy'],
        },
      ],
      'create a dashboard for istio dataplane',
      5,
    );
    expect(hits[0]?.id).toBe('istio');
    expect(hits[0]?.lexicalScore).toBeGreaterThan(0);
    expect(hits[0]?.semanticScore).toBeGreaterThan(0);
  });

  it('recovers when the query uses related terms instead of exact title tokens', () => {
    const hits = hybridKnowledgeSearch(
      [
        {
          id: 'istio',
          title: 'Istio data plane dashboard',
          description: 'Service mesh envoy sidecar resources and request flow.',
          intentTags: ['istio', 'service-mesh', 'envoy'],
        },
        {
          id: 'postgres',
          title: 'PostgreSQL',
          description: 'Database locks, WAL, connections, and query latency.',
          intentTags: ['database', 'sql'],
        },
      ],
      'sidecar proxy traffic panels',
      5,
    );
    expect(hits[0]?.id).toBe('istio');
    expect(hits[0]?.semanticScore).toBeGreaterThan(0);
  });

  it('returns no hits when neither lexical nor semantic features overlap', () => {
    const hits = hybridKnowledgeSearch(
      [{ id: 'redis', title: 'Redis', description: 'Cache memory clients', intentTags: ['cache'] }],
      'satellite orbital mechanics',
      5,
    );
    expect(hits).toEqual([]);
  });
});
