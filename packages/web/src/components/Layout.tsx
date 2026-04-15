import React, { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import Navigation from './Navigation.js';
import GlobalSearch from './GlobalSearch.js';
import ChatPanel from './ChatPanel.js';
import { ChatProvider, useGlobalChat } from '../contexts/ChatContext.js';

function LayoutInner() {
  const navigate = useNavigate();
  const { events, isGenerating, sendMessage, stopGeneration, pendingNavigation, clearPendingNavigation } = useGlobalChat();

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
      <main className="flex-1 overflow-y-auto bg-surface-container">
        <Outlet />
      </main>
      <ChatPanel
        events={events}
        isGenerating={isGenerating}
        onSendMessage={(msg) => {
          void sendMessage(msg);
        }}
        onStop={stopGeneration}
      />
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
