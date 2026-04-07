import React from 'react';
import type { InvestigationReport, InvestigationReportSection } from '../hooks/useDashboardChat.js';
import DashboardPanelCard from './DashboardPanelCard.js';

interface Props {
  report: InvestigationReport;
  title?: string;
  onClose?: () => void;
}

/* ── Inline markdown ── */

function InlineMarkdown({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    const codeMatch = remaining.match(/`(.+?)`/);

    const matches = [
      boldMatch ? { type: 'bold' as const, match: boldMatch, index: boldMatch.index ?? 0 } : null,
      codeMatch ? { type: 'code' as const, match: codeMatch, index: codeMatch.index ?? 0 } : null,
    ]
      .filter(Boolean)
      .sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));

    if (!matches.length) {
      parts.push(remaining);
      break;
    }

    const first = matches[0]!;
    if (first.index > 0) {
      parts.push(remaining.slice(0, first.index));
    }

    if (first.type === 'bold') {
      parts.push(
        <strong key={key++} className="font-semibold text-on-surface">
          {first.match[1]}
        </strong>,
      );
    } else if (first.type === 'code') {
      parts.push(
        <code
          key={key++}
          className="text-xs bg-surface-variant text-tertiary px-1.5 py-0.5 rounded font-mono"
        >
          {first.match[1]}
        </code>,
      );
    }

    remaining = remaining.slice(first.index + first.match[0].length);
  }

  return <>{parts}</>;
}

/* ── Block-level markdown ── */

function MarkdownText({ content }: { content: string }) {
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.startsWith('### ')) {
      elements.push(
        <h4 key={i} className="text-base font-bold font-[Manrope] text-on-surface mt-6 mb-2 flex items-center gap-2">
          <span className="w-1 h-5 bg-primary rounded-full" />
          {line.slice(4)}
        </h4>,
      );
    } else if (line.startsWith('## ')) {
      elements.push(
        <h3 key={i} className="text-xl font-bold font-[Manrope] text-on-surface mt-8 mb-3 flex items-center gap-2">
          <span className="w-1.5 h-6 bg-primary rounded-full" />
          {line.slice(3)}
        </h3>,
      );
    } else if (line.startsWith('# ')) {
      elements.push(
        <h2 key={i} className="text-2xl font-extrabold font-[Manrope] text-on-surface mt-8 mb-3 flex items-center gap-2">
          <span className="w-1.5 h-6 bg-primary rounded-full" />
          {line.slice(2)}
        </h2>,
      );
    } else if (line.startsWith('- ')) {
      elements.push(
        <div key={i} className="flex gap-3 mt-2">
          <span className="text-primary mt-0.5 shrink-0">&#x2022;</span>
          <span className="text-[15px] text-on-surface-variant leading-relaxed">
            <InlineMarkdown text={line.slice(2)} />
          </span>
        </div>,
      );
    } else if (line.trim()) {
      elements.push(
        <p key={i} className="text-[15px] text-on-surface-variant leading-relaxed mt-1">
          <InlineMarkdown text={line} />
        </p>,
      );
    } else {
      elements.push(<div key={i} className="h-3" />);
    }
  }

  return <>{elements}</>;
}

/* ── Section renderers ── */

function formatCapturedAt(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function EvidenceSection({ section }: { section: InvestigationReportSection }) {
  const capturedAt = section.panel?.snapshotData?.capturedAt;
  return (
    <div className="mt-8">
      {section.content && (
        <div className="mb-4 pl-5 border-l-2 border-primary/40">
          <MarkdownText content={section.content} />
        </div>
      )}

      {section.panel && (
        <div className="rounded-2xl overflow-hidden bg-surface-high relative" style={{ height: 280 }}>
          <DashboardPanelCard panel={section.panel} />
          {capturedAt && (
            <div className="absolute top-2 right-3 text-[10px] text-on-surface-variant/60 font-mono select-none">
              captured {formatCapturedAt(capturedAt)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TextSection({ section }: { section: InvestigationReportSection }) {
  return (
    <div className="mt-6">
      <MarkdownText content={section.content ?? ''} />
    </div>
  );
}

/* ── Main component ── */

export default function InvestigationReportView({ report, title }: Props) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto">
        <div className="px-12 py-10 max-w-4xl mx-auto space-y-8">

          {/* Header */}
          <header className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="px-2 py-0.5 rounded bg-error/10 text-error text-[10px] font-bold tracking-widest uppercase">
                Investigation Report
              </span>
            </div>

            <h1 className="text-4xl font-extrabold font-[Manrope] tracking-tight text-on-surface leading-tight">
              {title ?? report.summary}
            </h1>
          </header>

          {/* Summary */}
          <section className="space-y-3">
            <h3 className="text-xl font-bold font-[Manrope] text-on-surface flex items-center gap-2">
              <span className="w-1.5 h-6 bg-primary rounded-full" />
              Summary
            </h3>
            <p className="text-[15px] text-on-surface-variant leading-relaxed pl-4 border-l-2 border-primary/40">
              {report.summary}
            </p>
          </section>

          {/* Sections */}
          {report.sections.map((section, i) =>
            section.type === 'evidence' ? (
              <EvidenceSection key={i} section={section} />
            ) : (
              <TextSection key={i} section={section} />
            ),
          )}
        </div>
      </div>
    </div>
  );
}
