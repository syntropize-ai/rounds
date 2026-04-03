import { ReactNode } from 'react'
import { cn } from '@/lib/cn'

type BadgeVariant = 'primary' | 'secondary' | 'error' | 'tertiary' | 'outline'

interface BadgeProps {
  variant?: BadgeVariant
  children: ReactNode
  className?: string
}

export function Badge({ variant = 'outline', children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
        {
          'bg-primary/20 text-primary': variant === 'primary',
          'bg-secondary/20 text-secondary': variant === 'secondary',
          'bg-error/20 text-error': variant === 'error',
          'bg-tertiary/20 text-tertiary': variant === 'tertiary',
          'border border-outline/40 text-on-surface-variant': variant === 'outline',
        },
        className
      )}
    >
      {children}
    </span>
  )
}
