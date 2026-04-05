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
function panelSize(viz: PanelVisualization, sectionPanels: PanelConfig[]): PanelSize {
  switch (viz) {
    case 'stat':
    case 'gauge':
      return { width: 3, height: 2 }
    case 'time_series':
      return { width: 12, height: 3 }
    case 'table':
      return { width: 6, height: 4 }
    case 'bar':
    case 'histogram':
      return { width: 4, height: 3 }
    case 'pie':
      return { width: 4, height: 3 }
    case 'heatmap':
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

    let col = 0
    let rowHeight = 0 // tallest panel in the current row

    for (const panel of sectionPanels) {
      const size = panelSize(panel.visualization, sectionPanels)

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
