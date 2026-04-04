import React, { useMemo, useState, useCallback } from 'react';
import { Responsive, useContainerWidth, type LayoutItem } from 'react-grid-layout';
import DashboardPanelCard from './DashboardPanelCard.js';
import type { PanelConfig } from './DashboardPanelCard.js';

interface Props {
  panels: PanelConfig[];
  editMode?: boolean;
  isGenerating?: boolean;
  onEditPanel?: (id: string) => void;
  onDeletePanel?: (id: string) => void;
  onLayoutChange?: (layout: Array<{ i: string; x: number; y: number; w: number; h: number }>) => void;
}

// Section grouping

interface Section {
  id: string;
  label: string;
  panels: PanelConfig[];
}

function groupBySection(panels: PanelConfig[]): Section[] {
  const sections: Section[] = [];
  const sectionMap = new Map<string, Section>();

  for (const panel of panels) {
    const sid = panel.sectionId ?? '__default__';
    let section = sectionMap.get(sid);
    if (!section) {
      section = { id: sid, label: panel.sectionLabel ?? '', panels: [] };
      sectionMap.set(sid, section);
      sections.push(section);
    }
    section.panels.push(panel);
  }

  return sections;
}

// Compact layout for a set of panels

function compactLayout(panels: PanelConfig[], editMode: boolean): LayoutItem[] {
  const raw = panels.map((panel) => ({
    i: panel.id,
    x: panel.gridCol ?? panel.col ?? 0,
    y: panel.gridRow ?? panel.row ?? 0,
    w: panel.gridWidth ?? panel.width ?? 6,
    h: Math.max(3, panel.gridHeight ?? panel.height ?? 3),
    minW: 2,
    minH: 3,
    static: !editMode,
  }));

  // Vertical compaction within this section
  raw.sort((a, b) => a.y - b.y || a.x - b.x);
  for (const item of raw) {
    let newY = 0;
    for (const other of raw) {
      if (other === item) continue;
      if (other.x < item.x + item.w && other.x + other.w > item.x) {
        if (other.y + other.h > newY && other.y < item.y) {
          newY = Math.max(newY, other.y + other.h);
        }
      }
    }
    item.y = newY;
  }

  return raw;
}

// Section grid

function SectionGrid({
  section,
  width,
  editMode,
  onEditPanel,
  onDeletePanel,
  onLayoutChange,
}: {
  section: Section;
  width: number;
  editMode: boolean;
  onEditPanel?: (id: string) => void;
  onDeletePanel?: (id: string) => void;
  onLayoutChange?: Props['onLayoutChange'];
}) {
  const layout = useMemo(() => compactLayout(section.panels, !!editMode), [section.panels, editMode]);
  const ResponsiveGrid = Responsive;

  return (
    <ResponsiveGrid
      className="layout"
      layouts={{ lg: layout }}
      width={width}
      cols={{ lg: 12, md: 12, sm: 6, xs: 2, xxs: 1 }}
      rowHeight={60}
      margin={[12, 12]}
      containerPadding={[0, 0]}
      dragConfig={{ enabled: !!editMode, bounded: false, handle: '.drag-handle', threshold: 3 }}
      resizeConfig={{ enabled: !!editMode, handles: ['se'] }}
      onLayoutChange={(next) => onLayoutChange?.(next as Array<{ i: string; x: number; y: number; w: number; h: number }>)}
    >
      {section.panels.map((panel) => (
        <div key={panel.id} id={`panel-${panel.id}`}>
          <DashboardPanelCard
            panel={panel}
            editMode={!!editMode}
            onEdit={() => onEditPanel?.(panel.id)}
            onDelete={() => onDeletePanel?.(panel.id)}
          />
        </div>
      ))}
    </ResponsiveGrid>
  );
}

function SectionHeader({
  label,
  panelCount,
  collapsed,
  onToggle,
}: {
  label: string;
  panelCount: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center gap-3 px-2 pt-6 pb-2 w-full text-left group"
    >
      <svg
        className={`w-3.5 h-3.5 text-[#555570] transition-transform duration-200 ${collapsed ? '' : 'rotate-90'}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
      <h3 className="text-sm font-semibold text-[#E8E8ED] tracking-wide">{label}</h3>
      <span className="flex-1 h-px bg-[#2A2A3E]" />
      <span className="text-[11px] text-[#555570]">{panelCount} panels</span>
    </button>
  );
}

// Main component

export default function DashboardGrid({
  panels,
  editMode,
  isGenerating,
  onEditPanel,
  onDeletePanel,
  onLayoutChange,
}: Props) {
  const { width, containerRef } = useContainerWidth();
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  const sections = useMemo(() => groupBySection(panels), [panels]);
  const hasSections = sections.length > 1 || (sections.length === 1 && sections[0]!.id !== '__default__');

  const toggleSection = useCallback((sectionId: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      return next;
    });
  }, []);

  if (panels.length === 0) {
    return (
      <div ref={containerRef as React.RefObject<HTMLDivElement>} className="flex flex-col items-center justify-center py-20 text-center gap-3">
        {isGenerating ? (
          <>
            <div className="w-full max-w-2xl space-y-3 px-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="rounded-xl border border-[#2A2A3E] bg-[#141420] p-4 animate-pulse">
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <div className="h-4 bg-[#1C1C2E] rounded w-2/5 mb-2" />
                      <div className="h-20 bg-[#1C1C2E] rounded w-full" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 mt-2">
              <span className="inline-block w-4 h-4 border-2 border-[#2A2A3E] border-t-[#6366F1] rounded-full animate-spin" />
              <span className="text-[#8888AA]">Analyzing metrics and building panels...</span>
            </div>
          </>
        ) : (
          <>
            <svg className="w-10 h-10 text-[#555570]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 002-2V7a2 2 0 00-2-2h-3M5 11a2 2 0 01-2-2V7a2 2 0 012-2h3m0 0V3m0 2v6m0 0v8m0-8h8m-8 0H5" />
            </svg>
            <span className="text-[#8888AA]">No panels yet</span>
            <span className="text-xs text-[#555570]">Use the chat to describe what you want to monitor</span>
          </>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef as React.RefObject<HTMLDivElement>}>
      {sections.map((section) => {
        const isCollapsed = collapsedSections.has(section.id);
        return (
          <div key={section.id}>
            {hasSections && section.label && (
              <SectionHeader
                label={section.label}
                panelCount={section.panels.length}
                collapsed={isCollapsed}
                onToggle={() => toggleSection(section.id)}
              />
            )}
            {!isCollapsed && (
              <SectionGrid
                section={section}
                width={width}
                editMode={!!editMode}
                onEditPanel={onEditPanel}
                onDeletePanel={onDeletePanel}
                onLayoutChange={onLayoutChange}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export type { PanelConfig };
