import type { Request, Response } from 'express';
import type { Investigation } from '@agentic-obs/common';
import type { IGatewayInvestigationStore } from '@agentic-obs/data-layer';
import { closeSse, initSse, sendSseEvent, sendSseKeepAlive } from '../routes/investigation/sse.js';

export class InvestigationStreamService {
  constructor(private readonly store: IGatewayInvestigationStore) {}

  async stream(id: string, req: Request, res: Response): Promise<boolean> {
    const investigation = await this.store.findById(id);
    if (!investigation) {
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

    const keepalive = setInterval(() => {
      void this.poll(id, res, keepalive);
    }, 5000);

    req.on('close', () => {
      clearInterval(keepalive);
    });
    return true;
  }

  private async poll(id: string, res: Response, keepalive: NodeJS.Timeout): Promise<void> {
    try {
      const latest = await this.store.findById(id);
      if (!latest) {
        clearInterval(keepalive);
        closeSse(res);
        return;
      }

      sendSseKeepAlive(res);

      if (this.isTerminal(latest)) {
        clearInterval(keepalive);
        sendSseEvent(res, { type: 'investigation:complete', data: latest });
        closeSse(res);
      }
    } catch {
      clearInterval(keepalive);
      closeSse(res);
    }
  }

  private isTerminal(investigation: Investigation): boolean {
    return investigation.status === 'completed' || investigation.status === 'failed';
  }
}
