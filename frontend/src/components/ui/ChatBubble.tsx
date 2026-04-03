import { cn } from '@/lib/cn'

interface ChatBubbleProps {
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
}

export function ChatBubble({ role, content, streaming }: ChatBubbleProps) {
  return (
    <div className={cn('flex', role === 'user' ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] px-4 py-3 text-sm leading-relaxed',
          role === 'assistant'
            ? 'bg-surface-high rounded-2xl rounded-tl-none border-l-2 border-primary/40 text-on-surface'
            : 'bg-surface-variant rounded-2xl rounded-tr-none text-on-surface'
        )}
      >
        {content}
        {streaming && <span className="inline-block w-1 h-4 bg-primary ml-1 animate-pulse" />}
      </div>
    </div>
  )
}
