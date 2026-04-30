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

  const isUrgent = URGENT_STATUSES.has(headline.status);

  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 border-b ${
        isUrgent
          ? 'bg-primary/10 border-primary/30'
          : 'bg-surface-high border-outline-variant/40'
      }`}
      data-testid="investigation-plan-banner"
    >
      <span
        className={`shrink-0 w-2 h-2 rounded-full ${
          headline.status === 'pending_approval'
            ? 'bg-primary animate-pulse'
            : headline.status === 'failed'
            ? 'bg-error'
            : 'bg-on-surface-variant'
        }`}
      />
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-semibold ${isUrgent ? 'text-primary' : 'text-on-surface'}`}>
          {headline.status === 'pending_approval'
            ? 'Remediation plan ready for review'
            : headline.status === 'failed'
            ? 'Remediation plan failed'
            : `Remediation plan (${headline.status.replace(/_/g, ' ')})`}
        </div>
        {headline.summary && (
          <div className="text-xs text-on-surface-variant truncate mt-0.5">
            {headline.summary}
          </div>
        )}
      </div>
      <Link
        to="/actions?tab=plans"
        className="shrink-0 text-xs text-on-surface-variant hover:text-on-surface underline-offset-2 hover:underline"
      >
        View all plans
      </Link>
      <Link
        to={`/plans/${headline.id}`}
        className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-opacity ${
          isUrgent
            ? 'bg-primary text-on-primary-fixed hover:opacity-90'
            : 'bg-surface-highest text-on-surface hover:bg-surface-high'
        }`}
      >
        {headline.status === 'pending_approval' ? 'Review plan →' : 'Open plan →'}
        {plans.length > 1 && (
          <span className="ml-1.5 opacity-70 font-normal">+{plans.length - 1} more</span>
        )}
      </Link>
    </div>
  );
}
