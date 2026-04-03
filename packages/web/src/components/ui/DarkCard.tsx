import React from 'react';

interface DarkCardProps {
  className?: string;
  children: React.ReactNode;
}

export function DarkCard({ className = '', children }: DarkCardProps) {
  return (
    <div className={`bg-[#141420] rounded-2xl border border-[#2A2A3E] p-4 ${className}`}>
      {children}
    </div>
  );
}
