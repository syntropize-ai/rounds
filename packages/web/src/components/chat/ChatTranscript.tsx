import { useMemo, useState } from 'react';
import type { ChatEvent } from '../../hooks/useDashboardChat.js';
import type { PendingChangeKind, PendingChangeStatus } from '../../types/pending-changes.js';
import AgentActivityBlock from './AgentActivityBlock.js';
import AskUserPrompt from './AskUserPrompt.js';
import ChangeProposalCard from './ChangeProposalCard.js';
import { DatasourceChoiceChip } from './DatasourceChoiceChip.js';
import { ErrorMessage, UserMessage, AssistantMessage } from './MessageComponents.js';
import OpsCommandConfirmCard from './OpsCommandConfirmCard.js';
import InlineChartMessage from '../InlineChartMessage.js';
import { groupEvents, liveAgentBlockId } from './event-processing.js';

interface ChatTranscriptProps {
  events: ChatEvent[];
  isGenerating: boolean;
  onSendMessage: (content: string) => void;
  proposalStatusOverlay?: Map<string, PendingChangeStatus>;
}

export default function ChatTranscript({
  events,
  isGenerating,
  onSendMessage,
  proposalStatusOverlay,
}: ChatTranscriptProps) {
  const [opsStatusOverlay, setOpsStatusOverlay] = useState(
    () => new Map<string, NonNullable<ChatEvent['opsConfirmation']>>(),
  );
  const proposalStatusMap = useMemo(() => {
    const out: Record<string, PendingChangeStatus> = {};
    if (proposalStatusOverlay) {
      for (const [id, status] of proposalStatusOverlay) out[id] = status;
    }
    return out;
  }, [proposalStatusOverlay]);
  const blocks = useMemo(
    () => groupEvents(events, proposalStatusMap, opsStatusOverlay),
    [events, proposalStatusMap, opsStatusOverlay],
  );
  const liveBlockId = useMemo(() => liveAgentBlockId(blocks, isGenerating), [blocks, isGenerating]);
  const onOpsConfirmationResolved = (confirmation: NonNullable<ChatEvent['opsConfirmation']>) => {
    setOpsStatusOverlay((prev) => {
      const next = new Map(prev);
      next.set(confirmation.id, confirmation);
      return next;
    });
  };

  return (
    <>
      {blocks.map((block) => {
        if (block.type === 'agent') {
          return (
            <AgentActivityBlock
              key={block.id}
              events={block.events}
              isLive={block.id === liveBlockId}
            />
          );
        }

        return renderMessageBlock(
          block.event,
          onSendMessage,
          proposalStatusOverlay,
          onOpsConfirmationResolved,
        );
      })}
    </>
  );
}

function renderMessageBlock(
  evt: ChatEvent,
  onSendMessage: (content: string) => void,
  proposalStatusOverlay?: Map<string, PendingChangeStatus>,
  onOpsConfirmationResolved?: (confirmation: NonNullable<ChatEvent['opsConfirmation']>) => void,
) {
  if (evt.kind === 'error') {
    return <ErrorMessage key={evt.id} content={evt.content ?? 'An error occurred'} />;
  }

  if (evt.kind === 'ask_user') {
    return (
      <AskUserPrompt
        key={evt.id}
        question={evt.question ?? ''}
        options={evt.options ?? []}
        onSelect={(id) => onSendMessage(`option:${id}`)}
      />
    );
  }

  if (evt.kind === 'inline_chart' && evt.inlineChart) {
    const c = evt.inlineChart;
    return (
      <InlineChartMessage
        key={evt.id}
        id={c.id}
        initialQuery={c.query}
        initialTimeRange={c.timeRange}
        initialSeries={c.series}
        initialSummary={c.summary}
        metricKind={c.metricKind}
        datasourceId={c.datasourceId}
        pivotSuggestions={c.pivotSuggestions}
        warnings={c.warnings}
        onSendMessage={onSendMessage}
      />
    );
  }

  if (evt.kind === 'pending_change_created' && evt.pendingChange) {
    const p = evt.pendingChange;
    const overlay = proposalStatusOverlay?.get(p.id);
    return (
      <ChangeProposalCard
        key={evt.id}
        proposalId={p.id}
        dashboardId={p.dashboardId}
        panelId={p.panelId ?? null}
        changeKind={(p.changeKind as PendingChangeKind) ?? 'modify_panel'}
        summary={p.summary ?? 'Proposed change'}
        beforeJson={p.beforeJson}
        afterJson={p.afterJson}
        initialStatus={(p.status as PendingChangeStatus) ?? 'pending'}
        {...(overlay ? { controlledStatus: overlay } : {})}
      />
    );
  }

  if (evt.kind === 'ops_command_confirmation_required' && evt.opsConfirmation) {
    return (
      <OpsCommandConfirmCard
        key={evt.id}
        confirmation={evt.opsConfirmation}
        onResolved={onOpsConfirmationResolved}
      />
    );
  }

  if (evt.kind === 'ds_choice') {
    return (
      <DatasourceChoiceChip
        key={evt.id}
        chosenName={evt.chosenName ?? ''}
        reason={evt.chooseReason ?? ''}
        confidence={evt.confidence ?? 'low'}
        alternatives={evt.alternatives ?? []}
        onSwitch={(altId) => onSendMessage(`option:${altId}`)}
      />
    );
  }

  if (evt.message?.role === 'user') {
    return <UserMessage key={evt.id} content={evt.message.content} />;
  }

  if (evt.message?.role === 'assistant') {
    return <AssistantMessage key={evt.id} content={evt.message.content} />;
  }

  return null;
}
