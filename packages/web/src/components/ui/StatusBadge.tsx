import React from 'react';

interface StatusBadgeProps {
  status: 'generating' | 'ready' | 'error';
}

const statusConfig = {
  generating: {
    dot: 'bg-amber-400 animate-pulse',
    text: 'text-amber-400',
    label: 'Generating',
  },
  ready: {
    dot: 'bg-emerald-400',
    text: 'text-emerald-400',
    label: 'Ready',
  },
  error: {
    dot: 'bg-red-400',
    text: 'text-red-400',
    label: 'Error',
  },
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = statusConfig[status];

  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <span className={`w-1.5 h-1.5 rounded-full ${config.dot}`} />
      <span className={config.text}>{config.label}</span>
    </span>
  );
}
