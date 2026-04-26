import { createServer } from 'http';
import type { Application } from 'express';
import { Server as SocketServer } from 'socket.io';
import type { Namespace, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { ac, ACTIONS, EventTypes } from '@agentic-obs/common';
import type { Identity, IEventBus, EventEnvelope, OrgRole } from '@agentic-obs/common';
import { createEventBusFromEnv } from '@agentic-obs/common/events';
import { createLogger } from '@agentic-obs/common/logging';
import type {
  IFeedItemRepository,
  IGatewayApprovalStore,
  IGatewayIncidentStore,
  IGatewayInvestigationStore,
} from '@agentic-obs/data-layer';
import type { IUserRepository, IOrgUserRepository } from '@agentic-obs/common';
import { getJwtSecret } from '../auth/jwt-secret.js';
import { SESSION_COOKIE_NAME, type SessionService } from '../auth/session-service.js';
import type { ApiKeyService } from '../services/apikey-service.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';

const log = createLogger('websocket-gateway');

const JWT_SECRET = getJwtSecret('websocket-gateway');

// T9 / Wave 6 — the legacy `API_KEYS` env var is no longer parsed; operators
// convert existing env keys one-shot via `POST /api/serviceaccounts/migrate`
// and rely on the SA token middleware going forward. Leaving the set empty
// means handshake always falls through to JWT auth, which is the only
// supported path now.
const VALID_API_KEYS: ReadonlySet<string> = new Set();

/**
 * Per-socket auth identity. The handshake resolves a verifiable application
 * identity; room joins then use that identity for resource ownership + RBAC
 * checks before subscribing the socket to any resource room.
 */
export interface SocketAuth {
  sub: string;
  type: 'jwt' | 'api_key' | 'session';
  identity: Identity;
}

export interface AuthenticatedSocket extends Socket {
  auth?: SocketAuth;
}

type HandshakeData = {
  auth?: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
};

export interface WebSocketAuthDeps {
  sessions: SessionService;
  users: IUserRepository;
  orgUsers: IOrgUserRepository;
  apiKeyService: ApiKeyService;
}

export interface WebSocketAuthorizationDeps {
  ac: AccessControlSurface;
  resources: {
    investigations: IGatewayInvestigationStore;
    incidents: IGatewayIncidentStore;
    approvals: IGatewayApprovalStore;
    feedItems: IFeedItemRepository;
  };
}

export interface WebSocketGatewayDeps {
  auth?: WebSocketAuthDeps;
  authorization?: WebSocketAuthorizationDeps;
}

function orgRoleFromJwt(value: unknown): OrgRole {
  return value === 'Admin' || value === 'Editor' || value === 'Viewer' || value === 'None'
    ? value
    : 'None';
}

function socketAuthFromIdentity(identity: Identity, type: SocketAuth['type']): SocketAuth {
  return {
    sub: identity.userId,
    type,
    identity,
  };
}

function bearerToken(headers: HandshakeData['headers']): string | null {
  const authHeader = headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const xkey = headers['x-api-key'];
  return typeof xkey === 'string' && xkey.length > 0 ? xkey : null;
}

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=') || null;
  }
  return null;
}

async function authenticateWithDeps(
  handshake: HandshakeData,
  deps: WebSocketAuthDeps,
): Promise<SocketAuth> {
  const cookieHeader = handshake.headers['cookie'];
  const sessionToken = readCookie(
    typeof cookieHeader === 'string' ? cookieHeader : undefined,
    SESSION_COOKIE_NAME,
  );

  if (sessionToken) {
    const row = await deps.sessions.lookupByToken(sessionToken);
    if (!row) throw new Error('session expired');
    const user = await deps.users.findById(row.userId);
    if (!user || user.isDisabled) throw new Error('user disabled');
    const membership = await deps.orgUsers.findMembership(user.orgId, user.id);
    return socketAuthFromIdentity({
      userId: user.id,
      orgId: user.orgId,
      orgRole: membership?.role ?? 'None',
      isServerAdmin: user.isAdmin,
      authenticatedBy: 'session',
      sessionId: row.id,
    }, 'session');
  }

  const token = bearerToken(handshake.headers);
  if (token) {
    const lookup = await deps.apiKeyService.validateAndLookup(token);
    if (!lookup) throw new Error('invalid api key');
    return socketAuthFromIdentity({
      userId: lookup.user.id,
      orgId: lookup.orgId,
      orgRole: lookup.role,
      isServerAdmin: lookup.isServerAdmin,
      authenticatedBy: 'api_key',
      serviceAccountId: lookup.serviceAccountId ?? undefined,
    }, 'api_key');
  }

  throw new Error('Authentication required');
}

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
    return socketAuthFromIdentity({
      userId: apiKey,
      orgId: '',
      orgRole: 'None',
      isServerAdmin: false,
      authenticatedBy: 'api_key',
    }, 'api_key');
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
    const sub = typeof payload['sub'] === 'string' ? payload['sub'] : '';
    const orgId = typeof payload['orgId'] === 'string' ? payload['orgId'] : '';
    if (!sub || !orgId) {
      throw new Error('JWT must include sub and orgId');
    }
    return socketAuthFromIdentity({
      userId: sub,
      orgId,
      orgRole: orgRoleFromJwt(payload['orgRole']),
      isServerAdmin: payload['isServerAdmin'] === true,
      authenticatedBy: 'session',
    }, 'jwt');
  }

  throw new Error('Authentication required');
}

// Per-IP WebSocket connection rate limiter: max 10 attempts per minute
const wsConnAttempts = new Map<string, { count: number; resetAt: number }>();

function checkWsConnectionRate(ip: string): boolean {
  const now = Date.now();
  const entry = wsConnAttempts.get(ip);
  if (!entry || now >= entry.resetAt) {
    wsConnAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  entry.count++;
  return entry.count <= 10;
}

function applyAuthMiddleware(ns: Namespace | SocketServer, deps?: WebSocketAuthDeps): void {
  ns.use((socket, next) => {
    // Rate-limit connection attempts per IP before auth
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    const ip = typeof forwarded === 'string'
      ? forwarded.split(',')[0]?.trim() ?? 'unknown'
      : socket.handshake.address ?? 'unknown';
    if (!checkWsConnectionRate(ip)) {
      next(new Error('Too many connection attempts'));
      return;
    }

    void (async () => {
      const { auth, headers } = socket.handshake;
      const socketAuth = deps
        ? await authenticateWithDeps({ auth, headers }, deps)
        : authenticateHandshake({ auth, headers });
      (socket as AuthenticatedSocket).auth = socketAuth;
      next();
    })().catch(() => {
      next(new Error('Authentication failed'));
    });
  });
}

export interface WebSocketGateway {
  io: SocketServer;
  close(): Promise<void>;
}

export function createWebSocketGateway(
  app: Application,
  eventBus?: IEventBus,
  deps: WebSocketGatewayDeps = {},
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
    applyAuthMiddleware(ns, deps.auth);
  }

  const authorize = deps.authorization;

  function emitJoinDenied(socket: Socket, room: string): void {
    socket.emit('join_error', { room, code: 'FORBIDDEN', message: 'Not allowed to join room' });
  }

  function socketIdentity(socket: Socket): Identity | null {
    return (socket as AuthenticatedSocket).auth?.identity ?? null;
  }

  async function authorizeInvestigation(identity: Identity, investigationId: string): Promise<boolean> {
    if (!authorize) return false;
    const investigation = await authorize.resources.investigations.findById(investigationId);
    if (!investigation?.workspaceId || investigation.workspaceId !== identity.orgId) return false;
    return authorize.ac.evaluate(
      identity,
      ac.eval(ACTIONS.InvestigationsRead, `investigations:uid:${investigationId}`),
    );
  }

  async function authorizeIncident(identity: Identity, incidentId: string): Promise<boolean> {
    if (!authorize) return false;
    const incident = await authorize.resources.incidents.findById(incidentId);
    if (!incident?.workspaceId || incident.workspaceId !== identity.orgId) return false;
    return authorize.ac.evaluate(
      identity,
      ac.eval(ACTIONS.InvestigationsRead, 'investigations:*'),
    );
  }

  async function authorizeApproval(identity: Identity, approvalId: string): Promise<boolean> {
    if (!authorize) return false;
    const approval = await authorize.resources.approvals.findById(approvalId);
    if (!approval?.context.investigationId) return false;
    const canReadApproval = await authorize.ac.evaluate(
      identity,
      ac.eval(ACTIONS.ApprovalsRead, `approvals:uid:${approvalId}`),
    );
    if (!canReadApproval) return false;
    return authorizeInvestigation(identity, approval.context.investigationId);
  }

  async function authorizeFeedItem(identity: Identity, itemId: string): Promise<boolean> {
    if (!authorize) return false;
    const item = await authorize.resources.feedItems.get(itemId);
    if (!item?.investigationId) return false;
    return authorizeInvestigation(identity, item.investigationId);
  }

  async function joinIfAuthorized(
    socket: Socket,
    room: string,
    isAllowed: (identity: Identity) => Promise<boolean>,
  ): Promise<void> {
    const identity = socketIdentity(socket);
    if (!identity || !await isAllowed(identity)) {
      emitJoinDenied(socket, room);
      return;
    }
    await socket.join(room);
    socket.emit('join_ok', { room });
  }

  investigations.on('connection', (socket) => {
    log.debug({ id: socket.id }, 'investigations client connected');
    socket.on('join', (investigationId: string) => {
      if (typeof investigationId !== 'string' || investigationId.trim() === '') {
        emitJoinDenied(socket, 'investigation:');
        return;
      }
      const id = investigationId.trim();
      const room = `investigation:${id}`;
      void joinIfAuthorized(socket, room, (identity) => authorizeInvestigation(identity, id));
      log.debug({ id: socket.id, investigationId: id }, 'join requested');
    });
    socket.on('leave', (investigationId: string) => {
      void socket.leave(`investigation:${investigationId}`);
    });
  });

  incidents.on('connection', (socket) => {
    log.debug({ id: socket.id }, 'incidents client connected');
    socket.on('join', (incidentId: string) => {
      if (typeof incidentId !== 'string' || incidentId.trim() === '') {
        emitJoinDenied(socket, 'incident:');
        return;
      }
      const id = incidentId.trim();
      void joinIfAuthorized(socket, `incident:${id}`, (identity) => authorizeIncident(identity, id));
    });
    socket.on('leave', (incidentId: string) => {
      void socket.leave(`incident:${incidentId}`);
    });
  });

  approvals.on('connection', (socket) => {
    log.debug({ id: socket.id }, 'approvals client connected');
    socket.on('join', (approvalId: string) => {
      if (typeof approvalId !== 'string' || approvalId.trim() === '') {
        emitJoinDenied(socket, 'approval:');
        return;
      }
      const id = approvalId.trim();
      void joinIfAuthorized(socket, `approval:${id}`, (identity) => authorizeApproval(identity, id));
    });
    socket.on('leave', (approvalId: string) => {
      void socket.leave(`approval:${approvalId}`);
    });
  });

  feed.on('connection', (socket) => {
    log.debug({ id: socket.id }, 'feed client connected');
    socket.on('join', (itemId: string) => {
      if (typeof itemId !== 'string' || itemId.trim() === '') {
        emitJoinDenied(socket, 'feed:');
        return;
      }
      const id = itemId.trim();
      void joinIfAuthorized(socket, `feed:${id}`, (identity) => authorizeFeedItem(identity, id));
    });
    socket.on('leave', (itemId: string) => {
      void socket.leave(`feed:${itemId}`);
    });
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
          return;
        }
        log.warn({ eventType: event.type }, 'dropping investigation event without investigationId');
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
          return;
        }
        log.warn({ eventType: event.type }, 'dropping incident event without incidentId');
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
      bus.subscribe<{ actionId?: string }>(eventType, (event) => {
        const { actionId } = event.payload;
        if (actionId) {
          approvals.to(`approval:${actionId}`).emit(event.type, event);
          return;
        }
        log.warn({ eventType: event.type }, 'dropping approval event without actionId');
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
      bus.subscribe<{ itemId?: string; findingId?: string }>(eventType, (event) => {
        const { itemId, findingId } = event.payload;
        if (itemId) {
          feed.to(`feed:${itemId}`).emit(event.type, event);
          return;
        }
        if (findingId) {
          feed.to(`finding:${findingId}`).emit(event.type, event);
          return;
        }
        log.warn({ eventType: event.type }, 'dropping feed event without itemId/findingId');
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
