import { eq } from 'drizzle-orm';
import type { Provenance, SavedInvestigationReport, InvestigationReportSection } from '@agentic-obs/common';
import { toJsonColumn } from '../json-column.js';
import { investigationReports } from '../../db/schema.js';
import type { IInvestigationReportRepository } from '../interfaces.js';

type DbRow = typeof investigationReports.$inferSelect;

function rowToReport(row: DbRow): SavedInvestigationReport {
  const provenance = (row.provenance as Provenance | null) ?? undefined;
  return {
    id: row.id,
    dashboardId: row.dashboardId,
    goal: row.goal,
    summary: row.summary,
    sections: (row.sections as InvestigationReportSection[]) ?? [],
    createdAt: row.createdAt,
    ...(provenance ? { provenance } : {}),
  };
}

export class PostgresInvestigationReportRepository implements IInvestigationReportRepository {
  constructor(private readonly db: any) {}

  async save(report: SavedInvestigationReport): Promise<void> {
    // Upsert: try to find existing, then insert or update
    const existing = await this.db
      .select()
      .from(investigationReports)
      .where(eq(investigationReports.id, report.id));

    const provenanceCol = report.provenance ? toJsonColumn(report.provenance) : null;
    if (existing.length > 0) {
      await this.db
        .update(investigationReports)
        .set({
          dashboardId: report.dashboardId,
          goal: report.goal,
          summary: report.summary,
          sections: toJsonColumn(report.sections),
          provenance: provenanceCol,
        })
        .where(eq(investigationReports.id, report.id));
    } else {
      await this.db.insert(investigationReports).values({
        id: report.id,
        dashboardId: report.dashboardId,
        goal: report.goal,
        summary: report.summary,
        sections: toJsonColumn(report.sections),
        createdAt: report.createdAt,
        provenance: provenanceCol,
      });
    }
  }

  async findById(id: string): Promise<SavedInvestigationReport | undefined> {
    const [row] = await this.db
      .select()
      .from(investigationReports)
      .where(eq(investigationReports.id, id));
    return row ? rowToReport(row) : undefined;
  }

  async findAll(): Promise<SavedInvestigationReport[]> {
    const rows = await this.db.select().from(investigationReports);
    return rows.map(rowToReport);
  }

  async findByDashboard(dashboardId: string): Promise<SavedInvestigationReport[]> {
    const rows = await this.db
      .select()
      .from(investigationReports)
      .where(eq(investigationReports.dashboardId, dashboardId));
    return rows.map(rowToReport);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .delete(investigationReports)
      .where(eq(investigationReports.id, id))
      .returning();
    return result.length > 0;
  }
}
