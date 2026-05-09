import React from 'react';
import { useNavigate } from 'react-router-dom';
import StatusPill from './StatusPill.js';

export type FeedEventType = 'investigation_complete' | 'anomaly_detected' | 'change_impact';
export type FeedSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface FeedItemData {
  id: string;
  type: FeedEventType;
  title: string;
  summary: string;
  severity: FeedSeverity;
  status: 'unread' | 'read';
  investigationId?: string;
  createdAt: string;
}

interface FeedItemProps {
  item: FeedItemData;
  onMarkRead: (id: string) => void;
}

// Icon chip per feed event kind. `color` keys to severity / state tokens
// rather than raw hex so the avatar shifts with the active theme.
const TYPE_META: Record<FeedEventType, { icon: string; color: string; label: string }> = {
  anomaly_detected: {
    icon: '!',
    color: 'bg-severity-critical/15 text-severity-critical border-severity-critical/20',
    label: 'Anomaly',
  },
  investigation_complete: {
    icon: 'i',
    color: 'bg-[var(--color-primary)]/15 text-[var(--color-primary)] border-[var(--color-primary)]/20',
    label: 'Investigation',
  },
  change_impact: {
    icon: '~',
    color: 'bg-state-pending/15 text-state-pending border-state-pending/20',
    label: 'Change',
  },
};

const TYPE_LABELS: Record<FeedEventType, string> = {
  investigation_complete: 'Investigation',
  anomaly_detected: 'Anomaly',
  change_impact: 'Change',
};

function formatRelativeTime(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  if (diffMs < 60 * 1000) return 'just now';
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export default function FeedItem({ item, onMarkRead }: FeedItemProps) {
  const navigate = useNavigate();
  const isUnread = item.status === 'unread';
  const typeInfo = TYPE_META[item.type];

  return (
    <div
      className={`relative rounded-xl border transition-all group ${
        isUnread
          ? 'bg-[var(--color-surface-highest)] border-[var(--color-outline-variant)] hover:border-[var(--color-primary)]/30'
          : 'bg-[var(--color-surface-low)] border-[var(--color-outline-variant)] opacity-95 hover:opacity-100'
      }`}
    >
      {isUnread && <div className="absolute left-0 top-3 bottom-3 w-0.5 rounded-full bg-[var(--color-primary)]" />}

      <div className="p-3.5">
        <div className="flex items-start gap-3">
          <div className={`h-7 w-7 rounded-lg border flex items-center justify-center text-xs font-bold shrink-0 ${typeInfo.color}`}>
            {typeInfo.icon}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-sm font-medium truncate text-[var(--color-on-surface)]">{item.title}</span>
              {isUnread && <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-[var(--color-primary)]/10 text-[var(--color-primary)]">New</span>}
              <StatusPill kind="severity" value={item.severity} className="shrink-0" />
            </div>

            <p className="text-xs text-[var(--color-on-surface-variant)] leading-relaxed line-clamp-2 mb-2">{item.summary}</p>

            <div className="flex items-center gap-3 text-xs">
              <span className="text-[var(--color-outline)]">{TYPE_LABELS[item.type]}</span>
              <span className="text-[var(--color-outline)]">{formatRelativeTime(item.createdAt)}</span>

              {item.investigationId && (
                <button
                  type="button"
                  onClick={() => navigate(`/dashboards/${item.investigationId}`)}
                  className="text-[var(--color-primary)] hover:text-[var(--color-primary)] font-medium transition-colors"
                >
                  View Report
                </button>
              )}

              <button
                type="button"
                onClick={() => navigate('/', { state: { prefill: `Investigate: ${item.title}` } })}
                className="text-[var(--color-primary)] hover:text-[var(--color-primary)] font-medium transition-colors"
              >
                Investigate
              </button>

              {isUnread && (
                <button
                  type="button"
                  onClick={() => onMarkRead(item.id)}
                  className="ml-auto text-[var(--color-outline)] hover:text-[var(--color-on-surface-variant)] transition-colors"
                >
                  Mark read
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
