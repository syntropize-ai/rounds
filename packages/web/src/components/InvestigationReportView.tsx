import React from 'react';
import type { InvestigationReport, InvestigationReportSection } from '../hooks/useDashboardChat.js';
import DashboardPanelCard from './DashboardPanelCard.js';

interface Props {
  report: InvestigationReport;
  onClose?: () => void;
}

function MarkdownText({ content }: { content: string }) {
  // Simple markdown rendering: bold, code, headers, paragraphs
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line!.startsWith('### ')) {
      elements.push(
        <h4 key={i} className="text-sm font-semibold text-[#F0EBED] mt-4 mb-1.5">
          {line!.slice(4)}
        </h4>,
      );
    } else if (line!.startsWith('## ')) {
      elements.push(
        <h3 key={i} className="text-base font-semibold text-[#E8E8ED] mt-5 mb-2">
          {line!.slice(3)}
        </h3>,
      );
    } else if (line!.startsWith('# ')) {
      elements.push(
        <h2 key={i} className="text-lg font-bold text-[#E8E8ED] mt-6 mb-2">
          {line!.slice(2)}
        </h2>,
      );
    } else if (line!.startsWith('- ')) {
      elements.push(
        <ul key={i} className="text-sm text-[#BCC0D8] mt-1 list-disc leading-relaxed">
          <li>{InlineMarkdown({ text: line!.slice(2) })}</li>
        </ul>,
      );
    } else if (line!.trim()) {
      elements.push(
        <p key={i} className="text-sm text-[#BCC0D8] leading-relaxed">
          {InlineMarkdown({ text: line! })}
        </p>,
      );
    } else {
      elements.push(<div key={i} className="h-2" />);
    }
  }

  return <>{elements}</>;
}

function InlineMarkdown({ text }: { text: string }) {
  // Handle **bold**, `code`, and italic
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // bold
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    // Code
    const codeMatch = remaining.match(/`(.+?)`/);

    const matches = [
      boldMatch ? { type: 'bold', match: boldMatch, index: boldMatch.index ?? 0 } : null,
      codeMatch ? { type: 'code', match: codeMatch, index: codeMatch.index ?? 0 } : null,
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
        <strong key={key++} className="font-semibold text-[#E8E8ED]">
          {first.match[1]}
        </strong>,
      );
    } else if (first.type === 'code') {
      parts.push(
        <code
          key={key++}
          className="text-xs p-1 bg-[#1C1C2E] text-[#A0B1F0] px-1 py-0.5 rounded font-mono"
        >
          {first.match[1]}
        </code>,
      );
    }

    remaining = remaining.slice(first.index + first.match[0].length);
  }

  return <>{parts}</>;
}

function EvidenceSection({ section }: { section: InvestigationReportSection }) {
  return (
    <div className="mb-6">
      <div className="mb-3 pl-4 border-l-2 border-[#6366F1]/40">
        <MarkdownText content={section.content ?? ''} />
      </div>

      {section.panel && (
        <div className="rounded-xl overflow-hidden" style={{ height: 280 }}>
          <DashboardPanelCard panel={section.panel} />
        </div>
      )}
    </div>
  );
}

function TextSection({ section }: { section: InvestigationReportSection }) {
  return (
    <div className="mb-6">
      <MarkdownText content={section.content ?? ''} />
    </div>
  );
}

export default function InvestigationReportView({ report }: Props) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto">
        <div className="px-3 max-w-auto mx-6 py-6">
          <div className="p-4 rounded-xl bg-[#6366F1]/5 border border-[#6366F1]/20">
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-lg bg-[#6366F1]/10 flex items-center justify-center shrink-0 mt-0.5">
                <svg className="w-4 h-4 text-[#818CF8]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <h3 className="text-xs font-semibold text-[#818CF8] uppercase tracking-wider mb-1">Summary</h3>
                <p className="text-sm text-[#E8E8ED] leading-relaxed">{report.summary}</p>
              </div>
            </div>
          </div>

          {report.sections.map((section, i) => (
            section.type === 'evidence' ? (
              <EvidenceSection key={i} section={section} />
            ) : (
              <TextSection key={i} section={section} />
            )
          ))}
        </div>
      </div>
    </div>
  );
}
