import React, { useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import Navigation from './Navigation.js';
import GlobalSearch from './GlobalSearch.js';
import ChatPanel from './ChatPanel.js';
import DemoBanner from './DemoBanner.js';
import { ChatProvider, useGlobalChat } from '../contexts/ChatContext.js';

function LayoutInner() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    events,
    isGenerating,
    sendMessage,
    stopGeneration,
    pendingNavigation,
    clearPendingNavigation,
    loadError,
    retryLoadSession,
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
          isGenerating={isGenerating}
          onSendMessage={(msg) => {
            void sendMessage(msg);
          }}
          onStop={stopGeneration}
          loadError={loadError}
          onRetryLoad={retryLoadSession}
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
