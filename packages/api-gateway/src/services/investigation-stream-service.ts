import type { Request, Response } from 'express';
import type { Investigation } from '@agentic-obs/common';
import type { IGatewayInvestigationStore } from '@agentic-obs/data-layer';
import { closeSse, initSse, sendSseEvent, sendSseKeepAlive } from '../routes/investigation/sse.js';

export class InvestigationStreamService {
  constructor(private readonly store: IGatewayInvestigationStore) {}

  async stream(id: string, workspaceId: string, req: Request, res: Response): Promise<boolean> {
    const investigation = await this.store.findById(id);
    if (!investigation || !this.belongsToWorkspace(investigation, workspaceId)) {
      return false;
    }

    initSse(res);
    sendSseEvent(res, {
      type: 'investigation:status',
      data: { id: investigation.id, status: investigation.status },
    });

    if (this.isTerminal(investigation)) {
      sendSseEvent(res, { type: 'investigation:complete', data: investigation });
      closeSse(res);
      return true;
    }

    // Use setTimeout-recursion (not setInterval) to guarantee polls never
    // overlap: the next poll is scheduled only after the current one settles.
    // This avoids racing async runs that could each emit SSE events for the
    // same state change under load.
    let timer: NodeJS.Timeout | null = null;
    let stopped = false;
    const stop = (): void => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const schedule = (): void => {
      if (stopped) return;
      timer = setTimeout(() => {
        timer = null;
        void this.poll(id, workspaceId, res, stop).then(() => {
          if (!stopped) schedule();
        });
      }, 5000);
    };
    schedule();

    req.on('close', stop);
    return true;
  }

  private async poll(id: string, workspaceId: string, res: Response, stop: () => void): Promise<void> {
    try {
      const latest = await this.store.findById(id);
      if (!latest || !this.belongsToWorkspace(latest, workspaceId)) {
        stop();
        closeSse(res);
        return;
      }

      sendSseKeepAlive(res);

      if (this.isTerminal(latest)) {
        stop();
        sendSseEvent(res, { type: 'investigation:complete', data: latest });
        closeSse(res);
      }
    } catch {
      stop();
      closeSse(res);
    }
  }

  private isTerminal(investigation: Investigation): boolean {
    return investigation.status === 'completed' || investigation.status === 'failed';
  }

  private belongsToWorkspace(investigation: Investigation, workspaceId: string): boolean {
    return investigation.workspaceId === workspaceId;
  }
}
