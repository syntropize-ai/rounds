import React from 'react';

type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  as?: 'input';
};

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  as: 'textarea';
};

type DarkInputProps = InputProps | TextareaProps;

const baseClass =
  'w-full bg-[#1C1C2E] rounded-xl border border-[#2A2A3E] px-4 py-3 text-[#E8E8ED] placeholder:text-[#555570] focus:border-[#6366F1] focus:ring focus:ring-[#6366F1]/20 outline-none transition-colors';

export function DarkInput(props: DarkInputProps) {
  if (props.as === 'textarea') {
    const { as, className = '', ...rest } = props;
    return <textarea className={`${baseClass} ${className} resize-none`} {...rest} />;
  }
  const { as, className = '', ...rest } = props as InputProps;
  return <input className={`${baseClass} ${className}`} {...rest} />;
}
