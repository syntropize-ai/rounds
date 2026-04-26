import type { Investigation } from '@agentic-obs/common';
import type { IGatewayInvestigationStore, IInvestigationReportRepository } from '@agentic-obs/data-layer';
import type { FeedbackBody, FollowUpRecord, InvestigationSummary, PlanResponse } from '../routes/investigation/types.js';

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

  async listArchived(workspaceId: string): Promise<Investigation[]> {
    const investigations = await this.store.getArchived();
    return investigations.filter((inv) => this.belongsToWorkspace(inv, workspaceId));
  }

  async restoreArchived(id: string, workspaceId: string): Promise<Investigation | null> {
    const archived = await this.store.getArchived();
    const target = archived.find((inv) => inv.id === id);
    if (!target || !this.belongsToWorkspace(target, workspaceId)) {
      return null;
    }

    const restored = await this.store.restoreFromArchive(id);
    if (!restored || !this.belongsToWorkspace(restored, workspaceId)) {
      return null;
    }
    return restored;
  }

  async findByIdInWorkspace(id: string, workspaceId: string): Promise<Investigation | null> {
    const investigation = await this.store.findById(id);
    if (!investigation || !this.belongsToWorkspace(investigation, workspaceId)) {
      return null;
    }
    return investigation;
  }

  async getLatestReport(id: string, workspaceId: string): Promise<unknown | null | undefined> {
    const investigation = await this.findByIdInWorkspace(id, workspaceId);
    if (!investigation) {
      return null;
    }

    // Reports are stored with investigationId in the dashboardId field.
    const reports = await this.reportStore.findByDashboard(id);
    return reports[reports.length - 1];
  }

  async getPlan(id: string, workspaceId: string): Promise<PlanResponse | null> {
    const investigation = await this.findByIdInWorkspace(id, workspaceId);
    if (!investigation) {
      return null;
    }
    return { investigationId: investigation.id, plan: investigation.plan };
  }

  async addFollowUp(id: string, workspaceId: string, question: string): Promise<FollowUpRecord | null> {
    const investigation = await this.findByIdInWorkspace(id, workspaceId);
    if (!investigation) {
      return null;
    }
    return this.store.addFollowUp(id, question);
  }

  async addFeedback(id: string, workspaceId: string, body: FeedbackBody): Promise<boolean> {
    const investigation = await this.findByIdInWorkspace(id, workspaceId);
    if (!investigation) {
      return false;
    }
    await this.store.addFeedback(id, body);
    return true;
  }

  async getConclusion(id: string, workspaceId: string): Promise<unknown | null | undefined> {
    const investigation = await this.findByIdInWorkspace(id, workspaceId);
    if (!investigation) {
      return null;
    }
    return this.store.getConclusion(id);
  }

  async deleteWithReports(id: string, workspaceId: string): Promise<boolean> {
    const investigation = await this.findByIdInWorkspace(id, workspaceId);
    if (!investigation) {
      return false;
    }

    // Delete child reports first, then the investigation. If report deletion
    // fails partway, the investigation still exists and the user can retry —
    // avoiding orphaned reports that point at a missing investigation.
    const reports = await this.reportStore.findByDashboard(id);
    for (const report of reports) {
      await this.reportStore.delete(report.id);
    }
    await this.store.delete(id);
    return true;
  }

  private belongsToWorkspace(investigation: Investigation, workspaceId: string): boolean {
    return investigation.workspaceId === workspaceId;
  }
}
