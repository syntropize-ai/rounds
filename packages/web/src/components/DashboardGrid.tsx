import React, { useEffect, useMemo, useState, useCallback } from 'react';
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
  /** Fired when a panel's user-driven zoom selects a new time window. */
  onTimeRangeChange?: (range: string) => void;
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
    const isStat = panel.visualization === 'stat';
    const isGauge = panel.visualization === 'gauge';
    // Per-viz default heights — stat reads as a tight number tile (≈ 200px),
    // gauge needs vertical room for the SVG arc, everything else (time_series
    // / heatmap / table / bar / pie) wants a real chart area. Old dashboards
    // with explicit gridHeight win over the default.
    const defaultH = isStat ? 2 : isGauge ? 3 : 3;
    const defaultW = isStat ? 3 : 6;
    const h = panel.gridHeight ?? panel.height ?? defaultH;
    const w = panel.gridWidth ?? panel.width ?? defaultW;
    // Minimum heights per type, mirroring the defaults: stat tolerates
    // smaller cells, gauge needs at least 2 to render the arc, everything
    // else needs 3 so the chart area is meaningful.
    const finalH = isStat ? Math.max(2, h) : isGauge ? Math.max(2, h) : Math.max(3, h);
    return {
      i: panel.id,
      x: panel.gridCol ?? panel.col ?? 0,
      y: panel.gridRow ?? panel.row ?? 0,
      w: Math.min(COLS, w),
      h: finalH,
      minW: 2,
      minH: isStat ? 2 : isGauge ? 2 : 3,
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

/** True mobile = the device's screen is narrow (not the dashboard container).
 *  This distinguishes "phone" from "desktop with chat side-panel open" — the
 *  latter shouldn't switch to single-column stacking. */
function useIsMobileScreen(thresholdPx = 600): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === 'undefined' ? false : window.innerWidth < thresholdPx,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(`(max-width: ${thresholdPx - 1}px)`);
    const onChange = (): void => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [thresholdPx]);
  return isMobile;
}

function SectionGrid({
  section,
  width,
  editMode,
  timeRange,
  onEditPanel,
  onDeletePanel,
  onLayoutChange,
  onTimeRangeChange,
}: {
  section: Section;
  width: number;
  editMode: boolean;
  timeRange?: string;
  onEditPanel?: (id: string) => void;
  onDeletePanel?: (id: string) => void;
  onLayoutChange?: Props['onLayoutChange'];
  onTimeRangeChange?: Props['onTimeRangeChange'];
}) {
  const layout = useMemo(() => compactLayout(section.panels, !!editMode), [section.panels, editMode]);
  const isMobileScreen = useIsMobileScreen(600);

  // Mobile layout: every panel becomes full-width (1 col), stacked top-to-bottom
  // in original order. Heights are preserved so a heatmap stays visually
  // dominant relative to a stat tile.
  const mobileLayout = useMemo(() => {
    let y = 0;
    return [...layout]
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((item) => {
        const next = { ...item, x: 0, w: 1, y };
        y += item.h;
        return next;
      });
  }, [layout]);

  const ResponsiveGrid = Responsive;
  const cols = isMobileScreen
    ? { lg: 1, md: 1, sm: 1, xs: 1, xxs: 1 }
    : { lg: 12, md: 12, sm: 12, xs: 12, xxs: 12 };
  const activeLayout = isMobileScreen ? mobileLayout : layout;

  return (
    <ResponsiveGrid
      className="layout"
      // Same layout across every breakpoint within the chosen mode (desktop or
      // mobile) so the dashboard container width never causes a re-flow on its
      // own — only an actual screen-width change does.
      layouts={{
        lg: activeLayout,
        md: activeLayout,
        sm: activeLayout,
        xs: activeLayout,
        xxs: activeLayout,
      }}
      width={width}
      cols={cols}
      rowHeight={100}
      margin={[8, 8]}
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
            onTimeRangeChange={onTimeRangeChange}
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
  onTimeRangeChange,
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
                onTimeRangeChange={onTimeRangeChange}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export type { PanelConfig };
