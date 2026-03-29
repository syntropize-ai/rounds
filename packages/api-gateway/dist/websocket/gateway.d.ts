import { createServer } from 'http';
import type { Application } from 'express';
import { Server as SocketServer } from 'socket.io';
import type { Socket } from 'socket.io';
import type { IEventBus } from '@agentic-obs/common';
export interface SocketAuth {
    sub: string;
    type: 'jwt' | 'apikey';
    roles: string[];
    permissions: string[];
}
export interface AuthenticatedSocket extends Socket {
    auth?: SocketAuth;
}
type HandshakeData = {
    auth?: Record<string, unknown>;
    headers: Record<string, string | string[] | undefined>;
};
export declare function authenticateHandshake(handshake: HandshakeData): SocketAuth;
export interface WebSocketGateway {
    io: SocketServer;
    close(): Promise<void>;
}
export declare function createWebSocketGateway(app: Application, eventBus?: IEventBus): {
    httpServer: ReturnType<typeof createServer>;
    gateway: WebSocketGateway;
};
export {};
//# sourceMappingURL=gateway.d.ts.map
