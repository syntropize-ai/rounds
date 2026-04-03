import React from 'react';
import type { ConnectionStatus } from '../hooks/useSocket.js';

interface Props {
  status: ConnectionStatus;
  label?: string;
}

const DOT_COLORS: Record<ConnectionStatus, string> = {
  connected: '#22c55e',
  reconnecting: '#f59e0b',
  disconnected: '#ef4444',
};

const TEXT_COLORS: Record<ConnectionStatus, string> = {
  connected: '#15803d',
  reconnecting: '#b45309',
  disconnected: '#b91c1c',
};

const DEFAULT_LABELS: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  reconnecting: 'Reconnecting...',
  disconnected: 'Disconnected',
};

export function ConnectionStatusIndicator({
  status,
  label,
}: Props): React.ReactElement {
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem' }}
      title={`WebSocket: ${DEFAULT_LABELS[status]}`}
    >
      <span
        style={{
          display: 'inline-block',
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          backgroundColor: DOT_COLORS[status],
        }}
      />
      <span style={{ color: TEXT_COLORS[status] }}>
        {label ?? DEFAULT_LABELS[status]}
      </span>
    </span>
  );
}
