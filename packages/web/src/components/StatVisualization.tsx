import React from 'react';

interface Props {
  value: number;
  unit?: string;
  title?: string;
}

function formatStatValue(value: number, unit?: string): string {
  if (Number.isNaN(value)) return 'NaN';

  // Handle percentile: multiply by 100 and show with %
  if (unit === 'percentunit') {
    const pct = value * 100;
    if (pct === 100) return '100%';
    if (pct > 10) return `${pct.toFixed(1)}%`;
    return `${pct.toFixed(2)}%`;
  }

  // Handle bytes: format as KiB/MiB/GiB (binary units, 1024-based)
  if (unit === 'bytes') {
    const abs = Math.abs(value);
    if (abs >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(2)} TB`;
    if (abs >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
    if (abs >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)} MB`;
    if (abs >= 1024) return `${(value / 1024).toFixed(2)} KB`;
    return `${value.toFixed(0)} B`;
  }

  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(2)}G`;
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  if (Math.abs(value) < 0.01 && value !== 0) return value.toExponential(2);
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3);
}

function getUnitSuffix(unit?: string): string {
  if (!unit) return '';
  if (unit === 'percentunit' || unit === 'bytes') return ''; // already handled in format
  return unit;
}

function getBackgroundGradient(value: number, unit?: string): string {
  // Only apply color gradient for percentage/ratio-like values
  const isRatio = unit === 'percentunit' || unit === 'percent';
  if (!isRatio) return 'bg-[#141420]';

  const pct = unit === 'percentunit' ? value * 100 : value;
  if (pct < 20) return 'bg-gradient-to-t from-emerald-900/30 to-[#141420]';
  if (pct < 80) return 'bg-gradient-to-t from-amber-900/30 to-[#141420]';
  return 'bg-gradient-to-t from-red-900/30 to-[#141420]';
}

export default function StatVisualization({ value, unit, title }: Props) {
  const bgClass = getBackgroundGradient(value, unit);
  const displayValue = formatStatValue(value, unit);
  const suffix = getUnitSuffix(unit);

  return (
    <div className={`flex flex-col items-center justify-center h-full py-6 gap-2 rounded-lg ${bgClass}`}>
      {title && (
        <p className="text-xs text-[#8888AA] uppercase tracking-wide font-medium">{title}</p>
      )}
      <div className="flex items-baseline gap-1.5">
        <span className="text-5xl font-bold text-[#E8E8ED] font-mono tabular-nums leading-none">
          {displayValue}
        </span>
        {suffix && <span className="text-xl text-[#8888AA] font-medium">{suffix}</span>}
      </div>
    </div>
  );
}
