import { cn } from '@/lib/cn'

type Status = 'healthy' | 'critical' | 'warning' | 'active'

interface StatusDotProps {
  status: Status
  pulse?: boolean
  className?: string
}

export function StatusDot({ status, pulse = false, className }: StatusDotProps) {
  return (
    <span
      className={cn(
        'inline-block w-2 h-2 rounded-full',
        {
          'bg-secondary': status === 'healthy',
          'bg-error': status === 'critical',
          'bg-yellow-400': status === 'warning',
          'bg-primary': status === 'active',
        },
        pulse && 'animate-pulse',
        className
      )}
    />
  )
}
