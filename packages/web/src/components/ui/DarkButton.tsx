import React from 'react';

interface DarkButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost';
}

export function DarkButton({
  variant = 'primary',
  className = '',
  children,
  ...rest
}: DarkButtonProps) {
  const variantClass =
    variant === 'primary'
      ? 'bg-[#6366F1] hover:bg-[#818CF8] text-white rounded-xl px-5 py-2.5'
      : 'bg-transparent hover:bg-[#1C1C2E] text-[#8888AA] rounded-lg px-4 py-2';

  return (
    <button
      className={`font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${variantClass} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
