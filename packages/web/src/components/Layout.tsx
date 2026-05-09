import React, { useEffect, useRef } from 'react';
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
    loadSession,
    currentSessionId,
    startNewSession,
  } = useGlobalChat();
  const loadedUrlChatRef = useRef<string | null>(null);

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

  // URL chat identity is canonical on resource pages. Loading here keeps
  // dashboards, investigations, and future resource details on the same path.
  useEffect(() => {
    const chatId = new URLSearchParams(location.search).get('chat');
    if (!chatId) {
      if (showChat) {
        loadedUrlChatRef.current = null;
        startNewSession();
      }
      return;
    }
    if (loadedUrlChatRef.current === chatId) return;
    loadedUrlChatRef.current = chatId;
    void loadSession(chatId);
  }, [location.search, loadSession, showChat, startNewSession]);

  useEffect(() => {
    if (!showChat || !currentSessionId) return;
    const params = new URLSearchParams(location.search);
    if (params.get('chat') === currentSessionId) return;
    params.set('chat', currentSessionId);
    navigate(
      { pathname: location.pathname, search: `?${params.toString()}` },
      { replace: true },
    );
  }, [
    currentSessionId,
    location.pathname,
    location.search,
    navigate,
    showChat,
  ]);

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
