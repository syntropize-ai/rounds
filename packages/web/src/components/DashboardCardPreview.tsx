import React from 'react';
import type { PanelConfig } from './DashboardPanelCard.js';

interface DashboardCardPreviewProps {
  panels: PanelConfig[];
  generating?: boolean;
}

const PANEL_COLORS = [
  'bg-[#6366F1]/30',
  'bg-[#58C5C6]/30',
  'bg-[#E86B84]/25',
  'bg-[#F59E0B]/25',
  'bg-[#EC4899]/25',
];

export default function DashboardCardPreview({
  panels,
  generating,
}: DashboardCardPreviewProps) {
  const hasPanels = panels.length > 0;

  return (
    <div className={`h-20 w-full rounded-lg overflow-hidden bg-[#0A0A0F] p-1.5 ${generating ? 'animate-pulse' : ''}`}>
      <div className="grid grid-cols-12 gap-0.5 h-full auto-rows-fr">
        {hasPanels
          ? panels.slice(0, 8).map((panel, i) => {
              const span = Math.min(12, Math.max(1, panel.gridWidth ?? 6));
              return (
                <div
                  key={panel.id}
                  className={`rounded ${PANEL_COLORS[i % PANEL_COLORS.length]}`}
                  style={{ gridColumn: `span ${span}` }}
                />
              );
            })
          : [6, 3, 12, 4, 8].map((span, i) => (
              <div
                key={i}
                className={`rounded ${PANEL_COLORS[i % PANEL_COLORS.length]}`}
                style={{ gridColumn: `span ${span}` }}
              />
            ))}
      </div>
    </div>
  );
}
