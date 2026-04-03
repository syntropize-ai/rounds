import { ReactNode, ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  children: ReactNode
}

export function Button({ variant = 'primary', size = 'md', className, children, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center gap-2 font-medium transition-all active:scale-95 disabled:opacity-50',
        {
          'gradient-primary text-black rounded-xl': variant === 'primary',
          'bg-transparent text-on-surface-variant border border-outline/40 rounded-xl hover:bg-surface-high': variant === 'ghost',
          'bg-error/20 text-error border border-error/40 rounded-xl hover:bg-error/30': variant === 'danger',
        },
        {
          'px-3 py-1.5 text-xs': size === 'sm',
          'px-4 py-2 text-sm': size === 'md',
          'px-6 py-3 text-base': size === 'lg',
        },
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}
