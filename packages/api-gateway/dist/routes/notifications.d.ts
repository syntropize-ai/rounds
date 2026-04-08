import { Router } from 'express';
import type { INotificationRepository, IAlertRuleRepository } from '@agentic-obs/data-layer';
export interface NotificationsRouterDeps {
    notificationStore?: INotificationRepository;
    alertRuleStore?: IAlertRuleRepository;
}
export declare function createNotificationsRouter(deps?: NotificationsRouterDeps): Router;
export declare const notificationsRouter: Router;
//# sourceMappingURL=notifications.d.ts.map