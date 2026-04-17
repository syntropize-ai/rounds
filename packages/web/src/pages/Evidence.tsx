import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { Investigation, Hypothesis, Evidence } from '@agentic-obs/common';
import { apiClient } from '../api/client.js';
import HypothesisEvidence from '../components/HypothesisEvidence.js';
import TopologyGraph from '../components/TopologyGraph.js';
import { getInvestigationStatusStyle } from '../constants/status-styles.js';

export default function EvidencePage() {
  const { id } = useParams<{ id: string }>();
  const [investigation, setInvestigation] = useState<Investigation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    apiClient
      .get<Investigation>(`/investigations/${id}`)
      .then((res) => {
        if (res.error) {
          setError(res.error.message);
        } else {
          setInvestigation(res.data);
        }
      })
      .catch(() => setError('Failed to load investigation'))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center min-h-[40vh]">
        <div className="text-on-surface-variant text-sm animate-pulse">Loading evidence canvas...</div>
      </div>
    );
  }

  if (error || !investigation) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <div className="bg-error/10 border border-error/30 rounded-xl p-4 text-sm text-error">
          {error ?? 'Investigation not found.'}
          <Link to="/" className="mt-4 inline-block text-sm text-primary hover:underline">
            ← Back to Feed
          </Link>
        </div>
      </div>
    );
  }

  const hypotheses: Hypothesis[] = investigation.hypotheses ?? [];
  const allEvidence: Evidence[] = investigation.evidence ?? [];

  // Group all evidence by hypothesis
  const byHypothesis = new Map<string, Evidence[]>();
  for (const ev of allEvidence) {
    const bucket = byHypothesis.get(ev.hypothesisId) ?? [];
    bucket.push(ev);
    byHypothesis.set(ev.hypothesisId, bucket);
  }

  // Sort hypotheses by confidence descending
  const sorted = [...hypotheses].sort((a, b) => b.confidence - a.confidence);
  const dotColor = getInvestigationStatusStyle(investigation.status).dot;

  return (
    <div className="min-h-screen bg-surface-lowest">
      <div className="max-w-7xl mx-auto">
        <div className="py-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-2xl font-bold text-on-surface">Evidence</h1>
              <p className="text-on-surface-variant text-sm leading-relaxed max-w-2xl">
                Investigation evidence and hypothesis coverage for <code>{investigation.id}</code>
              </p>
            </div>

            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${dotColor}`} />
              <span className="text-on-surface-variant font-medium capitalize">{investigation.status}</span>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-on-surface-variant">
            <span>
              ID: <code className="font-mono text-on-surface">{investigation.id}</code>
            </span>
            <span>{hypotheses.length} hypothesis{hypotheses.length === 1 ? '' : 'es'}</span>
            <span>{allEvidence.length} evidence items</span>
          </div>

          {investigation.status === 'completed' && sorted[0] && (
            <div className="mt-5 bg-secondary/10 border border-secondary/30 rounded-xl p-4">
              <p className="text-xs font-semibold text-secondary uppercase tracking-wide mb-1">
                Top hypothesis
              </p>
              <p className="text-sm text-on-surface">{sorted[0].description}</p>
              <p className="text-xs text-secondary mt-1">
                Confidence: {Math.round(sorted[0].confidence * 100)}% • Status: {sorted[0].status}
              </p>
            </div>
          )}

          <TopologyGraph
            entity={investigation.structuredIntent?.entity ?? investigation.intent}
            evidence={allEvidence}
          />

          {sorted.length === 0 ? (
            <div className="mt-5 border border-outline-variant rounded-xl p-10 text-center">
              <p className="text-on-surface-variant text-sm">No hypotheses generated yet.</p>
              <p className="text-on-surface-variant/60 text-xs mt-1">Investigation may still be in progress.</p>
            </div>
          ) : (
            <div className="space-y-3 mt-5">
              {sorted.map((hyp) => {
                const evs = byHypothesis.get(hyp.id) ?? [];
                const supportIds = new Set(hyp.evidenceIds);
                const counterIds = new Set(hyp.counterEvidenceIds);
                const supportEvidence = evs.filter((ev) => supportIds.has(ev.id));
                const counterEvidence = evs.filter((ev) => counterIds.has(ev.id));
                // evidence not categorised yet - fall back to all as support
                const uncategorised = evs.filter(
                  (ev) => !supportIds.has(ev.id) && !counterIds.has(ev.id)
                );

                return (
                  <HypothesisEvidence
                    key={hyp.id}
                    hypothesis={hyp}
                    supportEvidence={[...supportEvidence, ...uncategorised]}
                    counterEvidence={counterEvidence}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
