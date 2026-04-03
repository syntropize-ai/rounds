import React from 'react';
import { useNavigate } from 'react-router-dom';

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

const TYPE_META: Record<FeedEventType, { icon: string; color: string; label: string }> = {
  anomaly_detected: { icon: '!', color: 'bg-[#EF4444]/15 text-[#EF4444] border-[#EF4444]/20', label: 'Anomaly' },
  investigation_complete: {
    icon: 'i',
    color: 'bg-[#6366F1]/15 text-[#6366F1] border-[#6366F1]/20',
    label: 'Investigation',
  },
  change_impact: { icon: '~', color: 'bg-[#F59E0B]/15 text-[#F59E0B] border-[#F59E0B]/20', label: 'Change' },
};

const TYPE_LABELS: Record<FeedEventType, string> = {
  investigation_complete: 'Investigation',
  anomaly_detected: 'Anomaly',
  change_impact: 'Change',
};

const SEVERITY_COLORS: Record<FeedSeverity, string> = {
  critical: 'bg-[#EF4444]/10 text-[#EF4444]',
  high: 'bg-[#F97316]/10 text-[#F97316]',
  medium: 'bg-[#F59E0B]/10 text-[#F59E0B]',
  low: 'bg-[#1C1C2E] text-[#8888AA]',
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
          ? 'bg-[#141420] border-[#2A2A3E] hover:border-[#6366F1]/30'
          : 'bg-[#0F0F1A] border-[#24243A] opacity-95 hover:opacity-100'
      }`}
    >
      {isUnread && <div className="absolute left-0 top-3 bottom-3 w-0.5 rounded-full bg-[#6366F1]" />}

      <div className="p-3.5">
        <div className="flex items-start gap-3">
          <div className={`h-7 w-7 rounded-lg border flex items-center justify-center text-xs font-bold shrink-0 ${typeInfo.color}`}>
            {typeInfo.icon}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-sm font-medium truncate text-[#E8E8ED]">{item.title}</span>
              {isUnread && <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-[#6366F1]/10 text-[#818CF8]">New</span>}
              <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${SEVERITY_COLORS[item.severity]}`}>
                {item.severity}
              </span>
            </div>

            <p className="text-xs text-[#8888AA] leading-relaxed line-clamp-2 mb-2">{item.summary}</p>

            <div className="flex items-center gap-3 text-xs">
              <span className="text-[#555570]">{TYPE_LABELS[item.type]}</span>
              <span className="text-[#555570]">{formatRelativeTime(item.createdAt)}</span>

              {item.investigationId && (
                <button
                  type="button"
                  onClick={() => navigate(`/investigate/${item.investigationId}`)}
                  className="text-[#6366F1] hover:text-[#818CF8] font-medium transition-colors"
                >
                  View Report
                </button>
              )}

              <button
                type="button"
                onClick={() => navigate('/', { state: { prefill: `Investigate: ${item.title}` } })}
                className="text-[#6366F1] hover:text-[#818CF8] font-medium transition-colors"
              >
                Investigate
              </button>

              {isUnread && (
                <button
                  type="button"
                  onClick={() => onMarkRead(item.id)}
                  className="ml-auto text-[#555570] hover:text-[#8888AA] transition-colors"
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
