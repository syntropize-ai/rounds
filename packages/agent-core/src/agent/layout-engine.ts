import type { PanelConfig, PanelVisualization } from '@agentic-obs/common'

const GRID_COLS = 12

interface PanelSize {
  width: number
  height: number
}

/**
 * Determine the default size for a panel based on its visualization type
 * and the composition of its section.
 */
export function panelSize(viz: PanelVisualization, sameVizCount: number = 1): PanelSize {
  // Sizes are grid units. The renderer (DashboardGrid) derives row height
  // from column width, so `width: N, height: N` renders as a true square
  // regardless of viewport — the same units mean the same aspect on
  // narrow laptops and wide monitors.
  //
  //   1:1 (square)    → stat, gauge, pie       (3×3)
  //   2:1 (landscape) → time_series, heatmap, bar, histogram, table (6×3)
  //   4:1 (banner)    → status_timeline        (12×3)
  switch (viz) {
    case 'stat':
      // Big number on top, sparkline strip below — reads as a balanced
      // tile at 1:1.
      return { width: 3, height: 3 }
    case 'gauge':
      return { width: 3, height: 3 }
    case 'pie':
      return { width: 3, height: 3 }
    case 'time_series':
      return { width: 6, height: 3 }
    case 'table':
      return { width: sameVizCount >= 2 ? 6 : 12, height: 3 }
    case 'bar':
    case 'histogram':
      return { width: sameVizCount >= 3 ? 4 : 6, height: 3 }
    case 'heatmap':
      return { width: 6, height: 3 }
    case 'status_timeline':
      return { width: 12, height: 3 }
    default:
      return { width: 6, height: 3 }
  }
}

/**
 * Compute deterministic row/col/width/height for all panels.
 *
 * Panels are grouped by sectionId. Within each section, panels are placed
 * left-to-right in a 12-column grid, wrapping to the next row when full.
 * Sections stack top-to-bottom in the order they appear.
 *
 * Panel width adapts based on how many panels of the same visualization
 * type exist in the section — e.g., 2 time_series panels get 6 cols each
 * (side by side), a single time_series gets 12 cols (full width).
 */
export function applyLayout(panels: PanelConfig[]): PanelConfig[] {
  // Group panels by section, preserving order of first appearance
  const sectionOrder: string[] = []
  const sections = new Map<string, PanelConfig[]>()

  for (const panel of panels) {
    const key = panel.sectionId ?? '__default__'
    if (!sections.has(key)) {
      sectionOrder.push(key)
      sections.set(key, [])
    }
    sections.get(key)!.push(panel)
  }

  const result: PanelConfig[] = []
  let currentRow = 0

  for (const sectionId of sectionOrder) {
    const sectionPanels = sections.get(sectionId)!

    // Count panels by visualization type in this section
    const vizCounts = new Map<string, number>()
    for (const p of sectionPanels) {
      vizCounts.set(p.visualization, (vizCounts.get(p.visualization) ?? 0) + 1)
    }

    let col = 0
    let rowHeight = 0

    for (const panel of sectionPanels) {
      const sameVizCount = vizCounts.get(panel.visualization) ?? 1
      const size = panelSize(panel.visualization, sameVizCount)

      // Wrap to next row if this panel doesn't fit
      if (col + size.width > GRID_COLS) {
        currentRow += rowHeight
        col = 0
        rowHeight = 0
      }

      result.push({
        ...panel,
        col,
        row: currentRow,
        width: size.width,
        height: size.height,
      })

      col += size.width
      rowHeight = Math.max(rowHeight, size.height)
    }

    // Advance past the last row of this section
    currentRow += rowHeight
  }

  return result
}
