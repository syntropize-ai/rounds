import { useEffect, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';

const BASE_URL = ((import.meta as unknown as { env: Record<string, string> }).env.VITE_API_URL ?? '').replace(/\/api$/, '');
const WS_PATH = '/ws';

export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

export interface UseSocketResult {
  socket: Socket | null;
  status: ConnectionStatus;
}

/**
 * Base hook - creates a Socket.io connection to the given namespace.
 * Auth token is read from localStorage key `auth_token`, or falls back to
 * the dev API key via query param.
 */
export function useSocket(namespace: string): UseSocketResult {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const token = localStorage.getItem('auth_token');
    const apiKey = localStorage.getItem('api_key') ?? 'test-api-key';

    const socket = io(`${BASE_URL}${namespace}`, {
      path: WS_PATH,
      auth: token ? { token } : { apiKey },
      autoConnect: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
    });

    socketRef.current = socket;

    socket.on('connect', () => setStatus('connected'));
    socket.on('disconnect', () => setStatus('disconnected'));
    socket.on('connect_error', () => setStatus('reconnecting'));
    socket.io.on('reconnect_attempt', () => setStatus('reconnecting'));
    socket.io.on('reconnect', () => setStatus('connected'));

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setStatus('disconnected');
    };
  }, [namespace]);

  return { socket: socketRef.current, status };
}

// Typed payload interfaces

export interface InvestigationUpdate {
  type: string;
  payload: {
    investigationId: string;
    status?: string;
    userId?: string;
  };
}

export interface IncidentUpdate {
  type: string;
  payload: {
    incidentId: string;
    title?: string;
    severity?: string;
  };
}

export interface ApprovalNotification {
  type: string;
  payload: {
    actionId: string;
    actionType: string;
    investigationId?: string;
    approvedBy?: string;
  };
}

export interface FeedEvent {
  type: string;
  payload: {
    itemId?: string;
    findingId?: string;
    title?: string;
    severity?: string;
  };
}

// Domain-specific hooks

/**
 * Subscribes to real-time investigation updates for a specific investigation.
 * Joins the investigation:{id} room automatically.
 */
export function useInvestigationUpdates(
  investigationId: string | null,
  onUpdate: (update: InvestigationUpdate) => void,
): ConnectionStatus {
  const { socket, status } = useSocket('/investigations');
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    if (!socket || !investigationId) return;

    const handleConnect = () => {
      socket.emit('join', investigationId);
    };

    if (status === 'connected') {
      socket.emit('join', investigationId);
    }

    socket.on('connect', handleConnect);

    const eventTypes = [
      'investigation.created',
      'investigation.updated',
      'investigation.completed',
      'investigation.failed',
    ];

    const handler = (event: InvestigationUpdate) => onUpdateRef.current(event);
    for (const t of eventTypes) socket.on(t, handler);

    return () => {
      socket.off('connect', handleConnect);
      for (const t of eventTypes) socket.off(t, handler);
      socket.emit('leave', investigationId);
    };
  }, [socket, investigationId, status]);

  return status;
}

/**
 * Subscribes to real-time incident updates for a specific incident.
 * Joins the incident:{id} room automatically.
 */
export function useIncidentUpdates(
  incidentId: string | null,
  onUpdate: (update: IncidentUpdate) => void,
): ConnectionStatus {
  const { socket, status } = useSocket('/incidents');
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    if (!socket || !incidentId) return;

    const handleConnect = () => {
      socket.emit('join', incidentId);
    };

    if (status === 'connected') {
      socket.emit('join', incidentId);
    }

    socket.on('connect', handleConnect);

    const eventTypes = ['incident.created', 'incident.updated', 'incident.resolved'];
    const handler = (event: IncidentUpdate) => onUpdateRef.current(event);
    for (const t of eventTypes) socket.on(t, handler);

    return () => {
      socket.off('connect', handleConnect);
      for (const t of eventTypes) socket.off(t, handler);
      socket.emit('leave', incidentId);
    };
  }, [socket, incidentId, status]);

  return status;
}

/**
 * Subscribes to approval/action notifications.
 * Returns pending approval count and a callback for each new notification.
 */
export function useApprovalNotifications(
  onNotification: (notification: ApprovalNotification) => void,
): { status: ConnectionStatus; pendingCount: number } {
  const { socket, status } = useSocket('/approvals');
  const [pendingCount, setPendingCount] = useState(0);
  const onNotificationRef = useRef(onNotification);
  onNotificationRef.current = onNotification;

  useEffect(() => {
    if (!socket) return;

    const handleRequest = (event: ApprovalNotification) => {
      setPendingCount((n) => n + 1);
      onNotificationRef.current(event);
    };
    const handleResolved = () => setPendingCount((n) => Math.max(0, n - 1));

    socket.on('action.requested', handleRequest);
    socket.on('action.approved', handleResolved);
    socket.on('action.rejected', handleResolved);

    return () => {
      socket.off('action.requested', handleRequest);
      socket.off('action.approved', handleResolved);
      socket.off('action.rejected', handleResolved);
    };
  }, [socket]);

  return { status, pendingCount };
}

/**
 * Subscribes to the real-time feed stream (findings, feed items).
 */
export function useFeedStream(onEvent: (event: FeedEvent) => void): ConnectionStatus {
  const { socket, status } = useSocket('/feed');
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!socket) return;

    const handler = (event: FeedEvent) => onEventRef.current(event);
    const eventTypes = [
      'finding.created',
      'finding.updated',
      'feed.item.created',
      'feed.item.read',
    ];

    for (const t of eventTypes) socket.on(t, handler);
    return () => {
      for (const t of eventTypes) socket.off(t, handler);
    };
  }, [socket]);

  return status;
}

// Connection status indicator hook

/**
 * Aggregates connection status across all active namespaces.
 * Returns 'connected' only if all are connected.
 */
export function useConnectionStatus(
  statuses: ConnectionStatus[],
): ConnectionStatus {
  return useCallback(() => {
    if (statuses.every((s) => s === 'connected')) return 'connected';
    if (statuses.some((s) => s === 'reconnecting')) return 'reconnecting';
    return 'disconnected';
  }, [statuses])();
}
