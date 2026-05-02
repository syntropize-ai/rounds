import type { Investigation } from '@agentic-obs/common';
import type { IGatewayInvestigationStore, IInvestigationReportRepository } from '@agentic-obs/data-layer';
import type { FeedbackBody, FollowUpRecord, InvestigationSummary, PlanResponse } from '../routes/investigation/types.js';

export type LatestReportResult =
  | { status: 'investigation_missing' }
  | { status: 'not_found' }
  | { status: 'ok'; report: unknown };

export type ConclusionResult =
  | { status: 'investigation_missing' }
  | { status: 'not_found' }
  | { status: 'ok'; conclusion: unknown };

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
    const restored = await this.store.restoreFromArchiveInWorkspace(id, workspaceId);
    return restored ?? null;
  }

  async findByIdInWorkspace(id: string, workspaceId: string): Promise<Investigation | null> {
    const investigation = await this.store.findById(id);
    if (!investigation || !this.belongsToWorkspace(investigation, workspaceId)) {
      return null;
    }
    return investigation;
  }

  async getLatestReport(id: string, workspaceId: string): Promise<LatestReportResult> {
    const investigation = await this.findByIdInWorkspace(id, workspaceId);
    if (!investigation) {
      return { status: 'investigation_missing' };
    }

    // Reports are stored with investigationId in the dashboardId field.
    const reports = await this.reportStore.findByDashboard(id);
    const report = reports[reports.length - 1];
    return report === undefined ? { status: 'not_found' } : { status: 'ok', report };
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

  async getConclusion(id: string, workspaceId: string): Promise<ConclusionResult> {
    const investigation = await this.findByIdInWorkspace(id, workspaceId);
    if (!investigation) {
      return { status: 'investigation_missing' };
    }
    const conclusion = await this.store.getConclusion(id);
    return conclusion === null || conclusion === undefined
      ? { status: 'not_found' }
      : { status: 'ok', conclusion };
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
