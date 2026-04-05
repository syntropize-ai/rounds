import React from 'react';

interface Props {
  value: number;
  unit?: string;
  title?: string;
  description?: string;
}

function formatStatValue(value: number, unit?: string): string {
  if (Number.isNaN(value)) return 'NaN';

  if (unit === 'percentunit') {
    if (Math.abs(value) > 1.5) return `${value.toFixed(1)}%`;
    const pct = value * 100;
    if (pct === 100) return '100%';
    if (pct > 10) return `${pct.toFixed(1)}%`;
    return `${pct.toFixed(2)}%`;
  }

  if (unit === 'percent') return `${value.toFixed(1)}%`;

  if (unit === 'bytes') {
    const abs = Math.abs(value);
    if (abs >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(1)} TB`;
    if (abs >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
    if (abs >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    if (abs >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value.toFixed(0)} B`;
  }

  if (unit === 'seconds') {
    const abs = Math.abs(value);
    if (abs >= 3600) return `${(value / 3600).toFixed(1)} h`;
    if (abs >= 60) return `${(value / 60).toFixed(1)} min`;
    if (abs >= 1) return `${value.toFixed(2)} s`;
    if (abs >= 0.001) return `${(value * 1000).toFixed(1)} ms`;
    return `${(value * 1e6).toFixed(0)} µs`;
  }

  if (unit === 'reqps' || unit === 'ops') {
    if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(1)}M req/s`;
    if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}K req/s`;
    return `${value.toFixed(1)} req/s`;
  }

  // Generic number formatting
  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(1)}G`;
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  if (Number.isInteger(value)) return String(value);
  if (Math.abs(value) < 0.01 && value !== 0) return value.toExponential(2);
  return value.toFixed(2);
}

export default function StatVisualization({ value, unit }: Props) {
  return (
    <div className="flex items-center justify-center h-full w-full">
      <span className="text-3xl font-bold text-on-surface font-[Manrope] tabular-nums leading-none tracking-tight">
        {formatStatValue(value, unit)}
      </span>
    </div>
  );
}
