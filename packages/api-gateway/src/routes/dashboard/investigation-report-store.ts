// In-memory store for saved investigation reports

import type { SavedInvestigationReport } from '@agentic-obs/common'
import type { Persistable } from '../../persistence.js'
import { markDirty } from '../../persistence.js'

export class InvestigationReportStore implements Persistable {
  private readonly reports = new Map<string, SavedInvestigationReport>()

  save(report: SavedInvestigationReport): void {
    this.reports.set(report.id, report)
    markDirty()
  }

  findById(id: string): SavedInvestigationReport | undefined {
    return this.reports.get(id)
  }

  findAll(): SavedInvestigationReport[] {
    return [...this.reports.values()]
  }

  findByDashboard(dashboardId: string): SavedInvestigationReport[] {
    return [...this.reports.values()].filter((r) => r.dashboardId === dashboardId)
  }

  delete(id: string): boolean {
    const result = this.reports.delete(id)
    if (result)
      markDirty()
    return result
  }

  toJSON(): unknown {
    return [...this.reports.values()]
  }

  loadJSON(data: unknown): void {
    if (!Array.isArray(data))
      return
    for (const r of data as SavedInvestigationReport[]) {
      if (r.id)
        this.reports.set(r.id, r)
    }
  }
}

/** Module-level singleton */
export const defaultInvestigationReportStore = new InvestigationReportStore()
