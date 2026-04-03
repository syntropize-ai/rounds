import { useState, useRef, useEffect } from 'react'
import { useAIPanel } from '@/stores/aiPanel'
import { ChatBubble } from '@/components/ui/ChatBubble'
import { SuggestionChip } from '@/components/ui/SuggestionChip'

interface AIPanelProps {
  suggestions?: { label: string; icon?: string }[]
  onSend?: (message: string) => void
  placeholder?: string
}

export function AIPanel({ suggestions = [], onSend, placeholder = 'Ask AI Curator...' }: AIPanelProps) {
  const { isOpen, close, messages, isStreaming } = useAIPanel()
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  if (!isOpen) return null

  function handleSend() {
    const msg = input.trim()
    if (!msg || isStreaming) return
    setInput('')
    onSend?.(msg)
  }

  return (
    <div className="w-[30%] min-w-[300px] max-w-[420px] h-full flex flex-col bg-surface-low flex-shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-secondary animate-pulse" />
          <span className="font-display font-bold text-sm gradient-text">AI Curator</span>
        </div>
        <button onClick={close} className="text-on-surface-variant hover:text-on-surface transition-all">
          <span className="material-symbols-rounded text-lg">close</span>
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-2 flex flex-col gap-3">
        {messages.length === 0 && (
          <div className="text-on-surface-variant text-sm text-center mt-8">
            Welcome! What would you like to explore?
          </div>
        )}
        {messages.map((msg, i) => (
          <ChatBubble
            key={i}
            role={msg.role}
            content={msg.content}
            streaming={msg.streaming && i === messages.length - 1}
          />
        ))}
        {suggestions.length > 0 && messages.length > 0 && !isStreaming && (
          <div className="flex flex-wrap gap-2 mt-1">
            {suggestions.map((s) => (
              <SuggestionChip key={s.label} label={s.label} icon={s.icon} onClick={() => onSend?.(s.label)} />
            ))}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 flex-shrink-0">
        <div className="ai-input flex items-center gap-2 px-4 py-3">
          <span className="material-symbols-rounded text-on-surface-variant text-base">chat</span>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder={placeholder}
            className="flex-1 bg-transparent text-sm text-on-surface placeholder:text-on-surface-variant outline-none"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isStreaming}
            className="text-primary hover:text-primary-dim disabled:text-on-surface-variant/40 transition-all"
          >
            <span className="material-symbols-rounded text-base">send</span>
          </button>
        </div>
        <p className="text-center text-on-surface-variant text-xs mt-2">Press Enter to chat</p>
      </div>
    </div>
  )
}
