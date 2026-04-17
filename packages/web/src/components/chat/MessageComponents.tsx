import React from 'react';

// Message components

export function UserMessage({ content }: { content: string }) {
  return (
    <div className="flex flex-col items-end gap-2 my-4">
      <div className="max-w-[90%] p-4 text-sm leading-relaxed bg-primary/10 border border-primary/20 rounded-xl rounded-tr-none text-on-surface">
        {content}
      </div>
      <span className="text-[10px] text-on-surface-variant uppercase tracking-widest">You</span>
    </div>
  );
}

export function InlineMd({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let rest = text;
  let i = 0;
  while (rest.length > 0) {
    const bold = rest.match(/\*\*(.+?)\*\*/);
    const code = rest.match(/`(.+?)`/);
    const bits = [bold ? { t: 'b', m: bold, i: bold.index! } : null, code ? { t: 'c', m: code, i: code.index! } : null]
      .filter(Boolean)
      .sort((a, b) => a!.i - b!.i);
    if (bits.length === 0) {
      parts.push(rest);
      break;
    }
    const hit = bits[0]!;
    if (hit.i > 0) parts.push(rest.slice(0, hit.i));
    if (hit.t === 'b') {
      parts.push(
        <strong key={i++} className="font-semibold text-on-surface">
          {hit.m![1]}
        </strong>
      );
    } else {
      parts.push(
        <code key={i++} className="text-[11px] bg-surface-high text-primary px-1 py-0.5 rounded font-mono">
          {hit.m![1]}
        </code>
      );
    }
    rest = rest.slice(hit.i + hit.m![0].length);
  }
  return <>{parts}</>;
}

export function AssistantMessage({ content }: { content: string }) {
  const lines = content.split('\n');
  return (
    <div className="my-3 text-[15px] leading-relaxed text-on-surface">
      {lines.map((line, i) => {
        if (line.startsWith('## ')) {
          return (
            <div key={i} className="text-base font-semibold text-on-surface mt-4 mb-2">
              {line.slice(3)}
            </div>
          );
        }
        if (line.startsWith('- ')) {
          return (
            <div key={i} className="pl-4 relative my-0.5">
              <span className="absolute left-0 text-on-surface-variant">•</span>
              <InlineMd text={line.slice(2)} />
            </div>
          );
        }
        if (line.trim() === '') {
          return <div key={i} className="h-2" />;
        }
        return (
          <div key={i} className={i === 0 ? '' : 'mt-1'}>
            <InlineMd text={line} />
          </div>
        );
      })}
    </div>
  );
}

export function ErrorMessage({ content }: { content: string }) {
  return (
    <div className="my-2">
      <div className="flex items-start gap-2 p-3 rounded-lg bg-error/10 border border-error/25">
        <svg className="w-3.5 h-3.5 text-error shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86l-7.5 13A1 1 0 003.66 18h16.68a1 1 0 00.87-1.5l-7.5-13a1 1 0 00-1.74 0z" />
        </svg>
        <span className="text-xs text-error">{content}</span>
      </div>
    </div>
  );
}
