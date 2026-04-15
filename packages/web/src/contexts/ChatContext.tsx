import React, { createContext, useContext } from 'react';
import { useChat } from '../hooks/useChat.js';
import type { UseChatResult } from '../hooks/useChat.js';

const ChatContext = createContext<UseChatResult | null>(null);

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const chat = useChat();
  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}

export function useGlobalChat(): UseChatResult {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error('useGlobalChat must be used within a ChatProvider');
  }
  return ctx;
}
