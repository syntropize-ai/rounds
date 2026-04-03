import type { ContactPoint, ContactPointIntegration, NotificationPolicyNode, MuteTiming, TimeInterval } from '@agentic-obs/common';
import type { Persistable } from '../persistence.js';
export declare class NotificationStore implements Persistable {
    private contactPoints;
    private policyTree;
    private muteTimings;
    constructor();
    createContactPoint(data: {
        name: string;
        integrations: ContactPointIntegration[];
    }): ContactPoint;
    findAllContactPoints(): ContactPoint[];
    findContactPointById(id: string): ContactPoint | undefined;
    updateContactPoint(id: string, patch: Partial<Omit<ContactPoint, 'id' | 'createdAt'>>): ContactPoint | undefined;
    deleteContactPoint(id: string): boolean;
    getPolicyTree(): NotificationPolicyNode;
    updatePolicyTree(tree: NotificationPolicyNode): void;
    addChildPolicy(parentId: string, policy: Omit<NotificationPolicyNode, 'id' | 'children' | 'createdAt' | 'updatedAt'>): NotificationPolicyNode | undefined;
    updatePolicy(id: string, patch: Partial<Omit<NotificationPolicyNode, 'id' | 'children' | 'createdAt'>>): NotificationPolicyNode | undefined;
    deletePolicy(id: string): boolean;
    createMuteTiming(data: {
        name: string;
        timeIntervals: TimeInterval[];
    }): MuteTiming;
    findAllMuteTimings(): MuteTiming[];
    findMuteTimingById(id: string): MuteTiming | undefined;
    updateMuteTiming(id: string, patch: Partial<Omit<MuteTiming, 'id' | 'createdAt'>>): MuteTiming | undefined;
    deleteMuteTiming(id: string): boolean;
    isMuted(muteTimingIds: string[], now?: Date): boolean;
    routeAlert(labels: Record<string, string>): Array<{
        contactPointId: string;
        groupBy: string[];
        isMuted: boolean;
    }>;
    toJSON(): unknown;
    loadJSON(data: unknown): void;
    private findNodeById;
    private removeNodeById;
}
export declare const defaultNotificationStore: NotificationStore;
//# sourceMappingURL=notification-store.d.ts.map