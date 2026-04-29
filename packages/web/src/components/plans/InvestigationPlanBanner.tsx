/**
 * Banner that surfaces remediation plans tied to an investigation.
 *
 * Used at the top of the InvestigationDetail page (P7 of the
 * auto-remediation design). Renders nothing if there are no plans for
 * this investigation — keeps the existing layout intact when no plan
 * has been proposed yet.
 *
 * The component fetches by `investigationId` only; the orgId comes from
 * the API gateway via the session, so we don't surface it here.
 */

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { plansApi } from '../../api/client.js';
import type { RemediationPlan } from '../../api/client.js';

interface Props {
  investigationId: string;
}

const URGENT_STATUSES: ReadonlySet<RemediationPlan['status']> = new Set(['pending_approval', 'failed']);

export default function InvestigationPlanBanner({ investigationId }: Props) {
  const [plans, setPlans] = useState<RemediationPlan[]>([]);

  useEffect(() => {
    let cancelled = false;
    void plansApi.list({ investigationId }).then(({ data }) => {
      if (!cancelled) setPlans(data);
    }).catch(() => { /* non-fatal — banner just stays hidden */ });
    return () => { cancelled = true; };
  }, [investigationId]);

  if (plans.length === 0) return null;

  // Surface the most actionable plan first: pending_approval > failed > others.
  const ordered = [...plans].sort((a, b) => {
    const ua = URGENT_STATUSES.has(a.status) ? 0 : 1;
    const ub = URGENT_STATUSES.has(b.status) ? 0 : 1;
    return ua - ub;
  });
  const headline = ordered[0];
  if (!headline) return null;

  return (
    <Link
      to={`/plans/${headline.id}`}
      className="block px-3 py-1.5 rounded-md bg-primary/10 text-primary hover:bg-primary/15 text-xs font-medium border border-primary/20 transition-colors"
    >
      {headline.status === 'pending_approval'
        ? 'Remediation plan ready → Review'
        : headline.status === 'failed'
        ? 'Remediation plan failed → Open'
        : `Remediation plan (${headline.status.replace(/_/g, ' ')})`}
      {plans.length > 1 && (
        <span className="ml-1 opacity-70">+{plans.length - 1} more</span>
      )}
    </Link>
  );
}
