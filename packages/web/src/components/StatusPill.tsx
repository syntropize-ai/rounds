import React from 'react';

/**
 * StatusPill renders a token-driven pill for severity / alert state /
 * remediation risk. It centralises the hex-color maps that previously
 * lived inline in Alerts, PlanDetail, ActionCenter, Feed and FeedItem.
 *
 * Colors come from CSS custom properties defined in `index.css`
 * (`--color-severity-*`, `--color-state-*`, `--color-risk-*`) so light
 * and dark themes are handled by the existing `data-theme` switch.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type AlertState = 'firing' | 'pending' | 'resolved' | 'normal';
export type Risk = 'critical' | 'high' | 'medium' | 'low';

export type StatusPillKind = 'severity' | 'state' | 'risk';
export type StatusPillSize = 'sm' | 'md';

interface StatusPillProps {
  kind: StatusPillKind;
  value: string;
  /** Override the visible label. Defaults to a Title-Cased value. */
  label?: string;
  size?: StatusPillSize;
  /** Render a leading colored dot instead of a filled background. */
  variant?: 'soft' | 'dot';
  /** Add a pulsing dot — used by `state=firing` etc. */
  pulse?: boolean;
  className?: string;
}

const SEVERITY_VALUES: ReadonlySet<string> = new Set([
  'critical',
  'high',
  'medium',
  'low',
  'info',
]);
const STATE_VALUES: ReadonlySet<string> = new Set([
  'firing',
  'pending',
  'resolved',
  'normal',
]);
const RISK_VALUES: ReadonlySet<string> = new Set([
  'critical',
  'high',
  'medium',
  'low',
]);

function knownValue(kind: StatusPillKind, value: string): boolean {
  if (kind === 'severity') return SEVERITY_VALUES.has(value);
  if (kind === 'state') return STATE_VALUES.has(value);
  return RISK_VALUES.has(value);
}

function defaultLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default function StatusPill({
  kind,
  value,
  label,
  size = 'sm',
  variant = 'soft',
  pulse = false,
  className = '',
}: StatusPillProps) {
  const text = label ?? defaultLabel(value);
  const known = knownValue(kind, value);

  // Tailwind needs static class strings to scan; use full token names per
  // (kind, value) pair so the JIT picks them up.
  const tokenClass: ToneClasses = known
    ? (TOKEN_CLASS[kind][value] ?? NEUTRAL_CLASS)
    : NEUTRAL_CLASS;

  const sizing =
    size === 'md'
      ? 'px-2 py-0.5 text-xs'
      : 'px-1.5 py-0.5 text-[10px]';

  if (variant === 'dot') {
    return (
      <span
        className={`inline-flex items-center gap-1.5 ${sizing} font-semibold uppercase tracking-wide ${tokenClass.text} ${className}`}
        data-status-kind={kind}
        data-status-value={value}
      >
        <span
          aria-hidden="true"
          className={`inline-block w-1.5 h-1.5 rounded-full ${tokenClass.dot} ${pulse ? 'animate-pulse' : ''}`}
        />
        {text}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center rounded ${sizing} font-semibold uppercase tracking-wide ${tokenClass.bg} ${tokenClass.text} ${className}`}
      data-status-kind={kind}
      data-status-value={value}
    >
      {pulse && (
        <span
          aria-hidden="true"
          className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 animate-pulse ${tokenClass.dot}`}
        />
      )}
      {text}
    </span>
  );
}

interface ToneClasses {
  bg: string;
  text: string;
  dot: string;
}

const NEUTRAL_CLASS: ToneClasses = {
  bg: 'bg-[var(--color-surface-high)]',
  text: 'text-[var(--color-on-surface-variant)]',
  dot: 'bg-[var(--color-outline)]',
};

const TOKEN_CLASS: Record<StatusPillKind, Record<string, ToneClasses>> = {
  severity: {
    critical: {
      bg: 'bg-severity-critical/10',
      text: 'text-severity-critical',
      dot: 'bg-severity-critical',
    },
    high: {
      bg: 'bg-severity-high/10',
      text: 'text-severity-high',
      dot: 'bg-severity-high',
    },
    medium: {
      bg: 'bg-severity-medium/10',
      text: 'text-severity-medium',
      dot: 'bg-severity-medium',
    },
    low: {
      bg: 'bg-severity-low/10',
      text: 'text-severity-low',
      dot: 'bg-severity-low',
    },
    info: {
      bg: 'bg-severity-info/10',
      text: 'text-severity-info',
      dot: 'bg-severity-info',
    },
  },
  state: {
    firing: {
      bg: 'bg-state-firing/10',
      text: 'text-state-firing',
      dot: 'bg-state-firing',
    },
    pending: {
      bg: 'bg-state-pending/10',
      text: 'text-state-pending',
      dot: 'bg-state-pending',
    },
    resolved: {
      bg: 'bg-state-resolved/10',
      text: 'text-state-resolved',
      dot: 'bg-state-resolved',
    },
    normal: {
      bg: 'bg-state-normal/10',
      text: 'text-state-normal',
      dot: 'bg-state-normal',
    },
  },
  risk: {
    critical: {
      bg: 'bg-risk-critical/10',
      text: 'text-risk-critical',
      dot: 'bg-risk-critical',
    },
    high: {
      bg: 'bg-risk-high/10',
      text: 'text-risk-high',
      dot: 'bg-risk-high',
    },
    medium: {
      bg: 'bg-risk-medium/10',
      text: 'text-risk-medium',
      dot: 'bg-risk-medium',
    },
    low: {
      bg: 'bg-risk-low/10',
      text: 'text-risk-low',
      dot: 'bg-risk-low',
    },
  },
};
