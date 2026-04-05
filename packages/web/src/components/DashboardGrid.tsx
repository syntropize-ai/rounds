import React, { useMemo, useState, useCallback } from 'react';
import { Responsive, useContainerWidth, type LayoutItem } from 'react-grid-layout';
import DashboardPanelCard from './DashboardPanelCard.js';
import type { PanelConfig } from './DashboardPanelCard.js';

interface Props {
  panels: PanelConfig[];
  editMode?: boolean;
  isGenerating?: boolean;
  timeRange?: string;
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
  const COLS = 12;
  const raw = panels.map((panel) => {
    const isStat = panel.visualization === 'stat' || panel.visualization === 'gauge';
    const h = panel.gridHeight ?? panel.height ?? (isStat ? 1 : 3);
    return {
      i: panel.id,
      x: panel.gridCol ?? panel.col ?? 0,
      y: panel.gridRow ?? panel.row ?? 0,
      w: Math.min(COLS, panel.gridWidth ?? panel.width ?? 6),
      h: isStat ? Math.min(h, 1) : Math.max(3, h),
      minW: 2,
      minH: isStat ? 1 : 3,
      static: !editMode,
    };
  });

  // Horizontal compaction: pack panels left-to-right, row by row
  // Sort by row first, then by column
  raw.sort((a, b) => a.y - b.y || a.x - b.x);

  // Group panels by their original row (same y value)
  const rows = new Map<number, typeof raw>();
  for (const item of raw) {
    const rowItems = rows.get(item.y) ?? [];
    rowItems.push(item);
    rows.set(item.y, rowItems);
  }

  // For each row, pack panels left-to-right with no gaps
  for (const rowItems of rows.values()) {
    rowItems.sort((a, b) => a.x - b.x);
    let nextX = 0;
    for (const item of rowItems) {
      item.x = nextX;
      nextX += item.w;
      // Wrap to next conceptual position if exceeds grid
      if (nextX > COLS && item.x > 0) {
        item.x = 0;
        nextX = item.w;
      }
    }
  }

  // Vertical compaction: push panels up to fill vertical gaps
  raw.sort((a, b) => a.y - b.y || a.x - b.x);
  for (const item of raw) {
    let newY = 0;
    for (const other of raw) {
      if (other === item) continue;
      // Check horizontal overlap
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
  timeRange,
  onEditPanel,
  onDeletePanel,
  onLayoutChange,
}: {
  section: Section;
  width: number;
  editMode: boolean;
  timeRange?: string;
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
      rowHeight={100}
      margin={[16, 16]}
      containerPadding={[0, 0]}
      dragConfig={{ enabled: !!editMode, bounded: false, handle: '.panel-drag-handle', threshold: 3 }}
      resizeConfig={{ enabled: !!editMode, handles: ['se'] }}
      onLayoutChange={(next) => onLayoutChange?.(next as Array<{ i: string; x: number; y: number; w: number; h: number }>)}
    >
      {section.panels.map((panel) => (
        <div key={panel.id} id={`panel-${panel.id}`}>
          <DashboardPanelCard
            panel={panel}
            editMode={!!editMode}
            timeRange={timeRange}
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
        className={`w-3.5 h-3.5 text-on-surface-variant transition-transform duration-200 ${collapsed ? '' : 'rotate-90'}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
      <h3 className="text-sm font-semibold text-on-surface tracking-wide">{label}</h3>
      <span className="flex-1 h-px bg-outline-variant" />
      <span className="text-[11px] text-on-surface-variant">{panelCount} panels</span>
    </button>
  );
}

// Main component

export default function DashboardGrid({
  panels,
  editMode,
  isGenerating,
  timeRange,
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
                <div key={i} className="rounded-xl border border-outline-variant bg-surface-high p-4 animate-pulse">
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <div className="h-4 bg-surface-highest rounded w-2/5 mb-2" />
                      <div className="h-20 bg-surface-highest rounded w-full" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 mt-2">
              <span className="inline-block w-4 h-4 border-2 border-outline-variant border-t-primary rounded-full animate-spin" />
              <span className="text-on-surface-variant">Analyzing metrics and building panels...</span>
            </div>
          </>
        ) : (
          <>
            <svg className="w-10 h-10 text-on-surface-variant" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 002-2V7a2 2 0 00-2-2h-3M5 11a2 2 0 01-2-2V7a2 2 0 012-2h3m0 0V3m0 2v6m0 0v8m0-8h8m-8 0H5" />
            </svg>
            <span className="text-on-surface-variant">No panels yet</span>
            <span className="text-xs text-on-surface-variant">Use the chat to describe what you want to monitor</span>
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
                timeRange={timeRange}
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
