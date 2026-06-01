import React, { useEffect, useMemo, useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import Navigation from './Navigation.js';
import GlobalSearch from './GlobalSearch.js';
import ChatPanel from './ChatPanel.js';
import DemoBanner from './DemoBanner.js';
import { ChatProvider, useGlobalChat } from '../contexts/ChatContext.js';
import { pendingChangesApi } from '../api/client.js';
import type { PendingChangeStatus } from '../types/pending-changes.js';

function LayoutInner() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    events,
    queuedMessages,
    isGenerating,
    sendMessage,
    updateQueuedMessage,
    deleteQueuedMessage,
    stopGeneration,
    pendingNavigation,
    clearPendingNavigation,
    loadError,
    retryLoadSession,
    startNewSession,
  } = useGlobalChat();

  // Hide the global ChatPanel on Home, the top-level list pages
  // (Dashboards / Investigations / Alerts), and configuration surfaces
  // (Settings, Admin). Detail pages keep the panel because that's
  // where a context-specific chat is actually useful.
  const pathname = location.pathname;
  const chatHiddenExact = new Set([
    '/',
    '/dashboards',
    '/investigations',
    '/alerts',
  ]);
  const chatHiddenPrefix = ['/settings', '/admin'];
  const showChat =
    !chatHiddenExact.has(pathname) &&
    !chatHiddenPrefix.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`),
    );
  const chatContextLabel = pathname.startsWith('/dashboards/')
    ? 'dashboard'
    : pathname.startsWith('/investigations/')
      ? 'investigation'
      : pathname.startsWith('/alerts/')
        ? 'alert'
        : undefined;

  // Session id no longer lives in the URL. ChatProvider's React state holds
  // currentSessionId and persists across route changes within the tab, so
  // the ChatPanel here just reflects whatever conversation is live.
  // Refresh / new tab = empty state = new conversation, matching the
  // "open page = fresh slate" UX appropriate for an SRE tool.

  // Handle agent-initiated navigation
  useEffect(() => {
    if (pendingNavigation) {
      navigate(pendingNavigation);
      clearPendingNavigation();
    }
  }, [pendingNavigation, navigate, clearPendingNavigation]);

  // Build a status overlay for every change_proposal event in the current
  // chat history. The card renders pending by default (from the persisted
  // SSE payload); this batch fetches the authoritative current status per
  // referenced dashboard so cards switch to accepted/rejected/expired after
  // a refresh or cross-tab open. Live SSE updates don't need this — they
  // mutate the card's local state on Apply/Cancel.
  const proposalDashboardIds = useMemo(() => {
    const ids = new Set<string>();
    for (const evt of events) {
      if (evt.kind === 'pending_change_created' && evt.pendingChange?.dashboardId) {
        ids.add(evt.pendingChange.dashboardId);
      }
    }
    return Array.from(ids);
  }, [events]);

  const [proposalStatusOverlay, setProposalStatusOverlay] = useState<Map<string, PendingChangeStatus>>(new Map());

  useEffect(() => {
    if (proposalDashboardIds.length === 0) {
      setProposalStatusOverlay(new Map());
      return;
    }
    let cancelled = false;
    void (async () => {
      const map = new Map<string, PendingChangeStatus>();
      const statuses: PendingChangeStatus[] = ['pending', 'accepted', 'rejected', 'expired'];
      await Promise.all(
        proposalDashboardIds.flatMap((dId) =>
          statuses.map(async (st) => {
            try {
              const list = await pendingChangesApi.listForDashboard(dId, st);
              for (const c of list) {
                map.set(c.id, c.status);
              }
            } catch {
              // non-fatal — card falls back to its inline status.
            }
          }),
        ),
      );
      if (cancelled) return;
      // Fold in any optimistic resolutions from live SSE that may not have
      // propagated to the read path yet.
      for (const evt of events) {
        if (evt.kind === 'pending_change_resolved' && evt.pendingChange?.id) {
          const s = evt.pendingChange.status as PendingChangeStatus | undefined;
          if (s) map.set(evt.pendingChange.id, s);
        }
      }
      setProposalStatusOverlay(map);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposalDashboardIds.join(','), events.length]);

  return (
    <div className="flex h-screen">
      <Navigation />
      <main className="flex-1 overflow-y-auto bg-surface-lowest">
        <DemoBanner />
        <Outlet />
      </main>
      {showChat && (
        <ChatPanel
          events={events}
          queuedMessages={queuedMessages}
          isGenerating={isGenerating}
          onSendMessage={(msg) => {
            void sendMessage(msg);
          }}
          onUpdateQueuedMessage={updateQueuedMessage}
          onDeleteQueuedMessage={deleteQueuedMessage}
          onStop={stopGeneration}
          onNewConversation={startNewSession}
          emptyContextLabel={chatContextLabel}
          loadError={loadError}
          onRetryLoad={retryLoadSession}
          proposalStatusOverlay={proposalStatusOverlay}
        />
      )}
      <GlobalSearch />
    </div>
  );
}

export default function Layout() {
  return (
    <ChatProvider>
      <LayoutInner />
    </ChatProvider>
  );
}
