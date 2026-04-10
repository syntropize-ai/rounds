import { createServer } from 'http';
import type { Application } from 'express';
import { Server as SocketServer } from 'socket.io';
import type { Namespace, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { createEventBusFromEnv, EventTypes } from '@agentic-obs/common';
import type { IEventBus, EventEnvelope } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common';
import { roleStore } from '../middleware/rbac.js';

const log = createLogger('websocket-gateway');

const JWT_SECRET: string = (() => {
  const secret = process.env['JWT_SECRET'];
  if (!secret) throw new Error('[websocket-gateway] FATAL: JWT_SECRET environment variable is required. Set a cryptographically random secret of at least 32 characters.');
  return secret;
})();

const VALID_API_KEYS = new Set(
  (process.env['API_KEYS'] ?? '').split(',').map((k) => k.trim()).filter(Boolean),
);

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

export function authenticateHandshake(handshake: HandshakeData): SocketAuth {
  const auth = handshake.auth ?? {};
  const headers = handshake.headers;

  // API key - from auth object or header
  const apiKey
    = typeof auth['apiKey'] === 'string'
      ? auth['apiKey']
      : typeof headers['x-api-key'] === 'string'
        ? headers['x-api-key']
        : typeof headers['x-api-key'.toLowerCase()] === 'string'
          ? headers['x-api-key'.toLowerCase()] as string
          : undefined;

  if (apiKey && VALID_API_KEYS.has(apiKey)) {
    const roles = ['operator'];
    const permissions = roleStore.resolvePermissions(roles);
    return { sub: apiKey, type: 'apikey', roles, permissions };
  }

  // JWT - from auth.token or Authorization header
  let token: string | undefined;
  if (typeof auth['token'] === 'string') {
    token = auth['token'];
  } else {
    const authHeader = headers['authorization'];
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }
  }

  if (token) {
    const payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
    const payloadRoles = payload['roles'];
    const payloadRole = payload['role'];
    let roles: string[];
    if (Array.isArray(payloadRoles) && payloadRoles.length > 0) {
      roles = payloadRoles.map(String);
    } else if (typeof payloadRole === 'string' && payloadRole.length > 0) {
      roles = [payloadRole];
    } else {
      roles = ['viewer'];
    }

    const permissions = roleStore.resolvePermissions(roles);
    return { sub: payload['sub'] ?? '', type: 'jwt', roles, permissions };
  }

  throw new Error('Authentication required');
}

function applyAuthMiddleware(ns: Namespace | SocketServer): void {
  ns.use((socket, next) => {
    try {
      const socketAuth = authenticateHandshake(
        socket.handshake as unknown as HandshakeData,
      );
      (socket as AuthenticatedSocket).auth = socketAuth;
      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  });
}

export interface WebSocketGateway {
  io: SocketServer;
  close(): Promise<void>;
}

export function createWebSocketGateway(
  app: Application,
  eventBus?: IEventBus,
): { httpServer: ReturnType<typeof createServer>; gateway: WebSocketGateway } {
  const httpServer = createServer(app);
  const bus = eventBus ?? createEventBusFromEnv();

  const corsOrigins = process.env['CORS_ORIGINS'] ?? '*';
  const corsOrigin = corsOrigins.split(',').map((s) => s.trim()).filter(Boolean);
  const io = new SocketServer(httpServer, {
    cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
    path: '/ws',
  });

  // Namespaces
  const investigations = io.of('/investigations');
  const incidents = io.of('/incidents');
  const approvals = io.of('/approvals');
  const feed = io.of('/feed');

  // Apply auth to each namespace
  for (const ns of [investigations, incidents, approvals, feed]) {
    applyAuthMiddleware(ns);
  }

  investigations.on('connection', (socket) => {
    log.debug({ id: socket.id }, 'investigations client connected');
    socket.on('join', (investigationId: string) => {
      void socket.join(`investigation:${investigationId}`);
      log.debug({ id: socket.id, investigationId }, 'joined room');
    });
    socket.on('leave', (investigationId: string) => {
      void socket.leave(`investigation:${investigationId}`);
    });
  });

  incidents.on('connection', (socket) => {
    log.debug({ id: socket.id }, 'incidents client connected');
    socket.on('join', (incidentId: string) => {
      void socket.join(`incident:${incidentId}`);
    });
    socket.on('leave', (incidentId: string) => {
      void socket.leave(`incident:${incidentId}`);
    });
  });

  approvals.on('connection', (socket) => {
    log.debug({ id: socket.id }, 'approvals client connected');
  });

  feed.on('connection', (socket) => {
    log.debug({ id: socket.id }, 'feed client connected');
  });

  // EventBus -> WebSocket bridge
  const unsubscribers: Array<() => void> = [];

  // Investigation events - /investigations namespace, scoped to room when possible
  for (const eventType of [
    EventTypes.INVESTIGATION_CREATED,
    EventTypes.INVESTIGATION_UPDATED,
    EventTypes.INVESTIGATION_COMPLETED,
    EventTypes.INVESTIGATION_FAILED,
  ]) {
    unsubscribers.push(
      bus.subscribe<{ investigationId?: string }>(eventType, (event: EventEnvelope<{ investigationId?: string }>) => {
        const { investigationId } = event.payload;
        if (investigationId) {
          investigations.to(`investigation:${investigationId}`).emit(event.type, event);
        }
        investigations.emit(event.type, event);
      }),
    );
  }

  // Incident events - /incidents namespace, scoped to room
  for (const eventType of [
    EventTypes.INCIDENT_CREATED,
    EventTypes.INCIDENT_UPDATED,
    EventTypes.INCIDENT_RESOLVED,
  ]) {
    unsubscribers.push(
      bus.subscribe<{ incidentId?: string }>(eventType, (event: EventEnvelope<{ incidentId?: string }>) => {
        const { incidentId } = event.payload;
        if (incidentId) {
          incidents.to(`incident:${incidentId}`).emit(event.type, event);
        }
        incidents.emit(event.type, event);
      }),
    );
  }

  // Approval/Action events - /approvals namespace (broadcast to all)
  for (const eventType of [
    EventTypes.ACTION_REQUESTED,
    EventTypes.ACTION_APPROVED,
    EventTypes.ACTION_REJECTED,
    EventTypes.ACTION_EXECUTED,
    EventTypes.ACTION_FAILED,
  ]) {
    unsubscribers.push(
      bus.subscribe(eventType, (event) => {
        approvals.emit(event.type, event);
      }),
    );
  }

  // Feed/finding events - /feed namespace
  for (const eventType of [
    EventTypes.FINDING_CREATED,
    EventTypes.FINDING_UPDATED,
    EventTypes.FEED_ITEM_CREATED,
    EventTypes.FEED_ITEM_READ,
  ]) {
    unsubscribers.push(
      bus.subscribe(eventType, (event) => {
        feed.emit(event.type, event);
      }),
    );
  }

  const gateway: WebSocketGateway = {
    io,
    async close() {
      for (const unsub of unsubscribers)
        unsub();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };

  return { httpServer, gateway };
}
