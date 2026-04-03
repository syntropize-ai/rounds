import React from 'react';

type Severity = 'low' | 'medium' | 'high' | 'critical';

const SEVERITY_STYLES: Record<Severity, string> = {
  low: 'bg-slate-700/60 text-slate-300',
  medium: 'bg-yellow-900/50 text-yellow-400',
  high: 'bg-orange-900/50 text-orange-400',
  critical: 'bg-red-900/50 text-red-400',
};

interface SeverityBadgeProps {
  severity: Severity;
}

export default function SeverityBadge({ severity }: SeverityBadgeProps) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wide ${SEVERITY_STYLES[severity]}`}
    >
      {severity}
    </span>
  );
}
