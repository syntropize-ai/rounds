import type { Investigation } from '@agentic-obs/common';
import type { IGatewayInvestigationStore, IInvestigationReportRepository } from '@agentic-obs/data-layer';
import type { InvestigationSummary } from '../routes/investigation/types.js';

export class InvestigationWorkspaceService {
  constructor(
    private readonly store: IGatewayInvestigationStore,
    private readonly reportStore: IInvestigationReportRepository,
  ) {}

  async listSummaries(workspaceId: string): Promise<InvestigationSummary[]> {
    const investigations = await this.store.findAll();
    return investigations
      .filter((inv) => this.belongsToWorkspace(inv, workspaceId))
      .map((inv) => ({
        id: inv.id,
        status: inv.status,
        intent: inv.intent,
        sessionId: inv.sessionId,
        userId: inv.userId,
        createdAt: inv.createdAt,
        updatedAt: inv.updatedAt,
      }));
  }

  async findByIdInWorkspace(id: string, workspaceId: string): Promise<Investigation | null> {
    const investigation = await this.store.findById(id);
    if (!investigation || !this.belongsToWorkspace(investigation, workspaceId)) {
      return null;
    }
    return investigation;
  }

  async deleteWithReports(id: string, workspaceId: string): Promise<boolean> {
    const investigation = await this.findByIdInWorkspace(id, workspaceId);
    if (!investigation) {
      return false;
    }

    await this.store.delete(id);
    const reports = await this.reportStore.findByDashboard(id);
    for (const report of reports) {
      await this.reportStore.delete(report.id);
    }
    return true;
  }

  private belongsToWorkspace(investigation: Investigation, workspaceId: string): boolean {
    return (investigation.workspaceId ?? 'default') === workspaceId;
  }
}
