import { useMemo, useState } from 'react';
import type { ChatEvent } from '../../hooks/useDashboardChat.js';
import type { PendingChangeKind, PendingChangeStatus } from '../../types/pending-changes.js';
import AgentActivityBlock from './AgentActivityBlock.js';
import AskUserPrompt from './AskUserPrompt.js';
import DashboardChangeConfirmCard from './DashboardChangeConfirmCard.js';
import { DatasourceChoiceChip } from './DatasourceChoiceChip.js';
import { ErrorMessage, UserMessage, AssistantMessage } from './MessageComponents.js';
import OpsCommandConfirmCard from './OpsCommandConfirmCard.js';
import InlineChartMessage from '../InlineChartMessage.js';
import { groupEvents, liveAgentBlockId } from './event-processing.js';

interface ChatTranscriptProps {
  events: ChatEvent[];
  isGenerating: boolean;
  onSendMessage: (content: string) => void;
  onUpdateQueuedMessage?: (queueItemId: string, content: string) => Promise<void>;
  onDeleteQueuedMessage?: (queueItemId: string) => Promise<void>;
  proposalStatusOverlay?: Map<string, PendingChangeStatus>;
}

export default function ChatTranscript({
  events,
  isGenerating,
  onSendMessage,
  onUpdateQueuedMessage,
  onDeleteQueuedMessage,
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
          onUpdateQueuedMessage,
          onDeleteQueuedMessage,
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
  onUpdateQueuedMessage?: (queueItemId: string, content: string) => Promise<void>,
  onDeleteQueuedMessage?: (queueItemId: string) => Promise<void>,
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

  if (evt.kind === 'message_queued' && evt.queuedMessage) {
    return (
      <QueuedMessage
        key={evt.id}
        queuedMessage={evt.queuedMessage}
        onUpdate={onUpdateQueuedMessage}
        onDelete={onDeleteQueuedMessage}
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

  if (evt.kind === 'pending_change_created' && evt.pendingChange) {
    const p = evt.pendingChange;
    const overlay = proposalStatusOverlay?.get(p.id);
    return (
      <DashboardChangeConfirmCard
        key={evt.id}
        proposalId={p.id}
        dashboardId={p.dashboardId}
        panelId={p.panelId ?? null}
        changeKind={(p.changeKind as PendingChangeKind) ?? 'modify_panel'}
        summary={p.summary ?? 'Apply proposed dashboard update'}
        initialStatus={(p.status as PendingChangeStatus) ?? 'pending'}
        {...(overlay ? { controlledStatus: overlay } : {})}
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

function QueuedMessage({
  queuedMessage,
  onUpdate,
  onDelete,
}: {
  queuedMessage: NonNullable<ChatEvent['queuedMessage']>;
  onUpdate?: (queueItemId: string, content: string) => Promise<void>;
  onDelete?: (queueItemId: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(queuedMessage.content);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const next = draft.trim();
    if (!next || next === queuedMessage.content) {
      setEditing(false);
      setDraft(queuedMessage.content);
      return;
    }
    setBusy(true);
    try {
      await onUpdate?.(queuedMessage.id, next);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await onDelete?.(queuedMessage.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex justify-end mb-3">
      <div className="max-w-[85%] rounded-lg border border-outline-variant bg-surface-container px-3 py-2 text-sm text-on-surface">
        <div className="mb-1 flex items-center justify-between gap-3 text-[10px] uppercase tracking-wide text-on-surface-variant">
          <span>Queued</span>
          <div className="flex items-center gap-2 normal-case tracking-normal">
            {editing ? (
              <>
                <button type="button" onClick={() => void save()} disabled={busy} className="hover:text-on-surface disabled:opacity-50">
                  Save
                </button>
                <button type="button" onClick={() => { setEditing(false); setDraft(queuedMessage.content); }} disabled={busy} className="hover:text-on-surface disabled:opacity-50">
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => setEditing(true)} disabled={busy || !onUpdate} className="hover:text-on-surface disabled:opacity-50">
                  Edit
                </button>
                <button type="button" onClick={() => void remove()} disabled={busy || !onDelete} className="hover:text-error disabled:opacity-50">
                  Delete
                </button>
              </>
            )}
          </div>
        </div>
        {editing ? (
          <textarea
            data-queue-editing="true"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void save();
              }
            }}
            className="min-h-[72px] w-full resize-none rounded-md border border-outline-variant bg-surface-lowest px-2 py-1.5 text-sm outline-none focus:border-primary"
          />
        ) : (
          <p className="whitespace-pre-wrap">{queuedMessage.content}</p>
        )}
      </div>
    </div>
  );
}
