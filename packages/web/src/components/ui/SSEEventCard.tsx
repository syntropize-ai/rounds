import React from 'react';

interface SSEEventCardProps {
  type: 'tool_call' | 'tool_result' | 'thinking';
  tool?: string;
  content: string;
  success?: boolean;
}

const typeConfig = {
  tool_call: { icon: '↪', label: 'Tool Call', color: 'text-[var(--color-primary)]' },
  tool_result: { icon: '✓', label: 'Tool Result', color: 'text-[#34D399]' },
  thinking: { icon: '◦', label: 'Thinking', color: 'text-[var(--color-on-surface-variant)]' },
};

function renderContent(text: string): React.ReactNode {
  const parts = text.split(/(\[[^\]]+\]\([^)]+\))/g);
  return parts.map((part, i) => {
    const match = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (match) {
      return (
        <a key={i} href={match[2]} className="text-[var(--color-primary)] hover:underline">
          {match[1]}
        </a>
      );
    }
    return part;
  });
}

export function SSEEventCard({ type, tool, content, success }: SSEEventCardProps) {
  const config = typeConfig[type];

  return (
    <div className="bg-[var(--color-surface-high)]/50 rounded-lg px-3 py-2 text-xs flex items-start gap-2">
      <span className="flex-none pt-0.5 shrink-0">{config.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className={`font-medium ${config.color}`}>{config.label}</span>
          {tool && <span className="text-[var(--color-on-surface-variant)]">{tool}</span>}
          {success !== undefined && (
            <span
              className={`ml-auto shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                success ? 'bg-[#34D399]/20 text-[#34D399]' : 'bg-[#EF7171]/20 text-[#EF7171]'
              }`}
            >
              {success ? 'ok' : 'fail'}
            </span>
          )}
        </div>
        <p className="text-[var(--color-on-surface-variant)]">{renderContent(content)}</p>
      </div>
    </div>
  );
}
