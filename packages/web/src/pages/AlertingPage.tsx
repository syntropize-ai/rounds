import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiClient } from '../api/client.js';
import Alerts from './Alerts.js';

interface ContactPointIntegration {
  uid: string;
  type: string;
  name: string;
  settings: Record<string, string>;
  disableResolveMessage?: boolean;
}

interface ContactPoint {
  id: string;
  name: string;
  integrations: ContactPointIntegration[];
  createdAt: string;
  updatedAt: string;
}

interface PolicyNode {
  id: string;
  matchers: Array<{ label: string; operator: string; value: string }>;
  contactPointId: string;
  groupBy: string[];
  groupWaitSec: number;
  groupIntervalSec: number;
  repeatIntervalSec: number;
  continueMatching: boolean;
  muteTimingIds: string[];
  children: PolicyNode[];
  isDefault?: boolean;
}

interface MuteTiming {
  id: string;
  name: string;
  timeIntervals: Array<{
    timesOfDay?: Array<{ startMinute: number; endMinute: number }>;
    weekdays?: number[];
    daysOfMonth?: number[];
    months?: number[];
    location?: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

interface AlertSilence {
  id: string;
  matchers: Array<{ label: string; operator: string; value: string }>;
  startsAt: string;
  endsAt: string;
  comment: string;
  createdBy: string;
  createdAt: string;
  status?: 'active' | 'expired' | 'pending';
}

interface AlertGroup {
  labels: Record<string, string>;
  alerts: Array<{
    ruleId: string;
    ruleName: string;
    state: string;
    severity: string;
    labels: Record<string, string>;
    value?: number;
    startsAt: string;
  }>;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 0) return `in ${Math.abs(mins)}m`;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function durationStr(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const INTEGRATION_COLORS: Record<string, string> = {
  slack: '#4A154B',
  email: '#2563EB',
  pagerduty: '#06AC38',
  webhook: '#6366F1',
  teams: '#6264A7',
  opsgenie: '#2684FF',
  telegram: '#0088CC',
  discord: '#5865F2',
};

function MatcherBadges({ matchers }: { matchers: Array<{ label: string; operator: string; value: string }> }) {
  if (!matchers.length) return <span className="text-[#5555] text-xs">all alerts</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {matchers.map((m, i) => (
        <span key={i} className="px-1.5 py-0.5 rounded bg-[#6366F1]/10 text-[#A3BCFB] text-xs font-mono">
          {m.label} {m.operator} {m.value}
        </span>
      ))}
    </div>
  );
}

const TABS = [
  { key: 'alert-rules', label: 'Alert Rules' },
  { key: 'contact-points', label: 'Contact Points' },
  { key: 'policies', label: 'Notification Policies' },
  { key: 'silences', label: 'Silences' },
  { key: 'mute-timings', label: 'Mute Timings' },
  { key: 'groups', label: 'Groups' },
] as const;

type TabKey = typeof TABS[number]['key'];

function IntegrationForm({
  integration,
  onChange,
  onRemove,
}: {
  integration: ContactPointIntegration;
  onChange: (i: ContactPointIntegration) => void;
  onRemove: () => void;
}) {
  const set = (key: string, val: string) =>
    onChange({ ...integration, settings: { ...integration.settings, [key]: val } });

  return (
    <div className="p-3 rounded-lg bg-[#16161E] border border-[#2A2A3E]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className="px-2 py-0.5 rounded text-xs font-bold text-white"
            style={{ backgroundColor: INTEGRATION_COLORS[integration.type] ?? '#5555' }}
          >
            {integration.type}
          </span>
          <input
            className="bg-transparent text-sm text-[#E8E8DE] border-b border-[#2A2A3E] outline-none px-0"
            value={integration.name}
            placeholder="Integration name"
            onChange={(e) => onChange({ ...integration, name: e.target.value })}
          />
        </div>
        <button onClick={onRemove} className="text-[#EF4444] text-xs hover:underline">Remove</button>
      </div>

      {(integration.type === 'slack' || integration.type === 'discord' || integration.type === 'teams') && (
        <div className="space-y-2 mt-3">
          <input
            className="w-full bg-[#16161E] border border-[#2A2A3E] rounded px-2 py-1.5 text-sm text-[#E8E8DE] outline-none"
            placeholder="Webhook URL"
            value={integration.settings['webhookUrl'] ?? ''}
            onChange={(e) => set('webhookUrl', e.target.value)}
          />
        </div>
      )}

      {integration.type === 'email' && (
        <input
          className="w-full bg-[#16161E] border border-[#2A2A3E] rounded px-2 py-1.5 text-sm text-[#E8E8DE] outline-none"
          placeholder="To addresses (comma-separated)"
          value={integration.settings['addresses'] ?? ''}
          onChange={(e) => set('addresses', e.target.value)}
        />
      )}

      {integration.type === 'pagerduty' && (
        <input
          className="w-full bg-[#16161E] border border-[#2A2A3E] rounded px-2 py-1.5 text-sm text-[#E8E8DE] outline-none"
          placeholder="Integration key"
          value={integration.settings['integrationKey'] ?? ''}
          onChange={(e) => set('integrationKey', e.target.value)}
        />
      )}

      {integration.type === 'webhook' && (
        <div className="space-y-2">
          <input
            className="w-full bg-[#16161E] border border-[#2A2A3E] rounded px-2 py-1.5 text-sm text-[#E8E8DE] outline-none"
            placeholder="Webhook URL"
            value={integration.settings['url'] ?? ''}
            onChange={(e) => set('url', e.target.value)}
          />
          <select
            className="bg-[#16161E] border border-[#2A2A3E] rounded px-2 py-1.5 text-sm text-[#E8E8DE] outline-none"
            value={integration.settings['method'] ?? 'POST'}
            onChange={(e) => set('method', e.target.value)}
          >
            <option>POST</option>
            <option>PUT</option>
          </select>
        </div>
      )}

      {integration.type === 'opsgenie' && (
        <input
          className="w-full bg-[#16161E] border border-[#2A2A3E] rounded px-2 py-1.5 text-sm text-[#E8E8DE] outline-none"
          placeholder="API Key"
          value={integration.settings['apiKey'] ?? ''}
          onChange={(e) => set('apiKey', e.target.value)}
        />
      )}

      {integration.type === 'telegram' && (
        <div className="space-y-2">
          <input
            className="w-full bg-[#16161E] border border-[#2A2A3E] rounded px-2 py-1.5 text-sm text-[#E8E8DE] outline-none"
            placeholder="Bot Token"
            value={integration.settings['botToken'] ?? ''}
            onChange={(e) => set('botToken', e.target.value)}
          />
          <input
            className="w-full bg-[#16161E] border border-[#2A2A3E] rounded px-2 py-1.5 text-sm text-[#E8E8DE] outline-none"
            placeholder="Chat ID"
            value={integration.settings['chatId'] ?? ''}
            onChange={(e) => set('chatId', e.target.value)}
          />
        </div>
      )}

      <label className="flex items-center gap-2 mt-2 text-xs text-[#B8B8A0]">
        <input
          type="checkbox"
          checked={!!integration.disableResolveMessage}
          onChange={(e) => onChange({ ...integration, disableResolveMessage: e.target.checked })}
        />
        Disable resolve message
      </label>
    </div>
  );
}

function ContactPointsTab() {
  const [points, setPoints] = useState<ContactPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formIntegrations, setFormIntegrations] = useState<ContactPointIntegration[]>([]);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(async () => {
    const res = await apiClient.get<ContactPoint[]>('/notifications/contact-points');
    if (!res.error) setPoints(Array.isArray(res.data) ? res.data : []);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const addIntegration = (type: string) => {
    setFormIntegrations((prev) => [
      ...prev,
      { uid: crypto.randomUUID().slice(0, 8), type, name: type, settings: {}, disableResolveMessage: false },
    ]);
  };

  const resetForm = () => { setFormName(''); setFormIntegrations([]); setEditId(null); setShowAdd(false); };
  const startEdit = (cp: ContactPoint) => { setEditId(cp.id); setShowAdd(false); setFormName(cp.name); setFormIntegrations([...cp.integrations]); };

  const handleSave = async () => {
    if (!formName.trim()) return;
    const body = { name: formName.trim(), integrations: formIntegrations };
    if (editId) {
      const res = await apiClient.put<ContactPoint>(`/notifications/contact-points/${editId}`, body);
      if (!res.error) { await load(); resetForm(); }
    } else {
      const res = await apiClient.post<ContactPoint>('/notifications/contact-points', body);
      if (!res.error) { await load(); resetForm(); }
    }
  };

  const handleDelete = async (id: string) => {
    await apiClient.delete(`/notifications/contact-points/${id}`);
    await load();
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    setTestResult(null);
    const res = await apiClient.post<{ ok: boolean; message: string }>(`/notifications/contact-points/${id}/test`, {});
    setTestResult(res.error ? { ok: false, message: 'Request failed' } : res.data);
    setTestingId(null);
  };

  if (loading) return <div className="text-[#B8B8A0] text-center py-8">Loading...</div>;

  const types = ['slack', 'email', 'pagerduty', 'webhook', 'teams', 'opsgenie', 'telegram', 'discord'];
  const isEditing = showAdd || editId !== null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-[#B8B8A0]">{points.length} contact point{points.length === 1 ? '' : 's'}</span>
        <button
          onClick={() => { setShowAdd(true); setFormName(''); setFormIntegrations([]); }}
          className="px-3 py-1.5 rounded-lg bg-[#6366F1] text-white text-sm font-medium hover:bg-[#5555B6]"
        >
          Add contact point
        </button>
      </div>

      {isEditing && (
        <div className="p-4 rounded-lg bg-[#16161E] border border-[#6366F1]/30">
          <div className="text-sm font-semibold text-[#E8E8DE] mb-3">{editId ? 'Edit' : 'New'} Contact Point</div>
          <input
            className="w-full mb-3 rounded border border-[#2A2A3E] bg-[#141420] px-3 py-2 text-sm text-[#E8E8DE] outline-none"
            placeholder="Contact point name"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
          />
          <div className="space-y-2 mb-3">
            {formIntegrations.map((intg) => (
              <IntegrationForm
                key={intg.uid}
                integration={intg}
                onChange={(updated) => setFormIntegrations((prev) => prev.map((x) => x.uid === intg.uid ? updated : x))}
                onRemove={() => setFormIntegrations((prev) => prev.filter((x) => x.uid !== intg.uid))}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-2 mb-3">
            {types.map((type) => (
              <button key={type} onClick={() => addIntegration(type)} className="px-2 py-1 rounded text-xs font-medium border border-[#2A2A3E] text-[#B8B8A0] hover:text-[#E8E8DE] hover:border-[#6366F1]">
                + {type}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={() => void handleSave()} className="px-3 py-1.5 rounded bg-[#6366F1] text-white text-sm">Save</button>
            <button onClick={resetForm} className="px-3 py-1.5 rounded bg-[#1E1E2A] text-[#B8B8A0] text-sm hover:text-[#E8E8DE]">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {points.map((cp) => (
          <div key={cp.id} className="p-3 rounded-lg bg-[#16161E] border border-[#2A2A3E]">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <span className="font-medium text-[#E8E8DE]">{cp.name}</span>
                {cp.integrations.map((intg) => (
                  <span key={intg.uid} className="px-1.5 py-0.5 rounded text-[10px] font-bold text-white" style={{ backgroundColor: INTEGRATION_COLORS[intg.type] ?? '#5555' }}>
                    {intg.type}
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => void handleTest(cp.id)} disabled={testingId === cp.id} className="text-xs text-[#B8B8A0] hover:text-[#E8E8DE]">
                  {testingId === cp.id ? 'Testing…' : 'Test'}
                </button>
                <button onClick={() => startEdit(cp)} className="text-xs text-[#6366F1] hover:underline">Edit</button>
                <button onClick={() => void handleDelete(cp.id)} className="text-xs text-[#EF4444] hover:underline">Delete</button>
              </div>
            </div>
            {testResult && testingId === null && (
              <div className={`text-sm ${testResult.ok ? 'text-[#22C55E]' : 'text-[#EF4444]'}`}>{testResult.message}</div>
            )}
          </div>
        ))}
        {points.length === 0 && !isEditing && <div className="text-center py-8 text-[#5555]">No contact points configured</div>}
      </div>
    </div>
  );
}

function PolicyNodeRow({
  node,
  depth,
  contactPoints,
  muteTimings,
  onEdit,
  onAddChild,
  onDelete,
}: {
  node: PolicyNode;
  depth: number;
  contactPoints: ContactPoint[];
  muteTimings: MuteTiming[];
  onEdit: (id: string) => void;
  onAddChild: (parentId: string) => void;
  onDelete: (id: string) => void;
}) {
  const cp = contactPoints.find((c) => c.id === node.contactPointId);
  const mts = node.muteTimingIds.map((id) => muteTimings.find((m) => m.id === id)?.name).filter(Boolean);

  return (
    <>
      <div className="flex items-start gap-2 py-2 px-3 rounded-lg bg-[#16161E] border border-[#1E1E2A] hover:border-[#2A2A3E]" style={{ marginLeft: `${depth * 24}px` }}>
        <span className="text-[#5555] mt-0.5 shrink-0">{'↳'.repeat(depth + 1)}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-xs text-[#B8B8A0]">
            {node.isDefault && <span className="px-1.5 py-0.5 rounded bg-[#6366F1]/20 text-[#A3BCFB] text-[10px] font-bold">DEFAULT</span>}
            <MatcherBadges matchers={node.matchers} />
            {node.continueMatching && <span className="px-1.5 py-0.5 rounded bg-[#F59E0B]/20 text-[#F59E0B] text-[10px] font-bold">CONTINUE</span>}
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-[#B8B8A0]">
            <span>Contact: <span className="text-[#E8E8DE]">{cp?.name ?? 'none'}</span></span>
            <span>Group: {node.groupBy.join(', ') || '(none)'}</span>
            <span>{durationStr(node.groupWaitSec)} / {durationStr(node.repeatIntervalSec)}</span>
            {mts.length > 0 && <span>Mute: {mts.join(', ')}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => onEdit(node.id)} className="text-xs text-[#6366F1] hover:underline">Edit</button>
          <button onClick={() => onAddChild(node.id)} className="text-xs text-[#22C55E] hover:underline">Add Child</button>
          {!node.isDefault && <button onClick={() => onDelete(node.id)} className="text-xs text-[#EF4444] hover:underline">Delete</button>}
        </div>
      </div>
      {node.children.map((child) => (
        <PolicyNodeRow
          key={child.id}
          node={child}
          depth={depth + 1}
          contactPoints={contactPoints}
          muteTimings={muteTimings}
          onEdit={onEdit}
          onAddChild={onAddChild}
          onDelete={onDelete}
        />
      ))}
    </>
  );
}

function MatcherEditor({
  matchers,
  onChange,
}: {
  matchers: Array<{ label: string; operator: string; value: string }>;
  onChange: (next: Array<{ label: string; operator: string; value: string }>) => void;
}) {
  return (
    <div className="space-y-2">
      {matchers.map((m, i) => (
        <div key={i} className="flex gap-1 items-center">
          <input className="flex-1 bg-[#0B0B15] border border-[#2A2A3E] rounded px-2 py-1 text-xs text-[#E8E8DE] outline-none" placeholder="label" value={m.label} onChange={(e) => onChange(matchers.map((x, idx) => idx === i ? { ...x, label: e.target.value } : x))} />
          <select className="bg-[#0B0B15] border border-[#2A2A3E] rounded px-2 py-1 text-xs text-[#E8E8DE] outline-none" value={m.operator} onChange={(e) => onChange(matchers.map((x, idx) => idx === i ? { ...x, operator: e.target.value } : x))}>
            <option>=</option>
            <option>!=</option>
            <option>=~</option>
            <option>!~</option>
          </select>
          <input className="flex-1 bg-[#0B0B15] border border-[#2A2A3E] rounded px-2 py-1 text-xs text-[#E8E8DE] outline-none" placeholder="value" value={m.value} onChange={(e) => onChange(matchers.map((x, idx) => idx === i ? { ...x, value: e.target.value } : x))} />
          <button onClick={() => onChange(matchers.filter((_, j) => j !== i))} className="text-[#EF4444] text-xs px-2">×</button>
        </div>
      ))}
      <button onClick={() => onChange([...matchers, { label: '', operator: '=', value: '' }])} className="text-xs text-[#6366F1] hover:underline">+ Add matcher</button>
    </div>
  );
}

function PoliciesTab() {
  const [tree, setTree] = useState<PolicyNode | null>(null);
  const [contactPoints, setContactPoints] = useState<ContactPoint[]>([]);
  const [muteTimings, setMuteTimings] = useState<MuteTiming[]>([]);
  const [loading, setLoading] = useState(true);
  const [editId, setEditId] = useState<string | null>(null);
  const [addParentId, setAddParentId] = useState<string | null>(null);
  const [matchers, setMatchers] = useState<Array<{ label: string; operator: string; value: string }>>([]);
  const [fCpId, setFCpId] = useState('');
  const [fGroupBy, setFGroupBy] = useState('');
  const [fWait, setFWait] = useState(30);
  const [fInterval, setFInterval] = useState(300);
  const [fRepeat, setFRepeat] = useState(3600);
  const [fContinue, setFContinue] = useState(false);
  const [fMuteIds, setFMuteIds] = useState<string[]>([]);

  const load = useCallback(async () => {
    const [treeRes, cpRes, mtRes] = await Promise.all([
      apiClient.get<PolicyNode>('/notifications/policies'),
      apiClient.get<ContactPoint[]>('/notifications/contact-points'),
      apiClient.get<MuteTiming[]>('/notifications/mute-timings'),
    ]);
    if (!treeRes.error) setTree(treeRes.data);
    setContactPoints(Array.isArray(cpRes.data) ? cpRes.data : []);
    setMuteTimings(Array.isArray(mtRes.data) ? mtRes.data : []);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const findNode = (node: PolicyNode | null, id: string): PolicyNode | null => {
    if (!node) return null;
    if (node.id === id) return node;
    for (const c of node.children) {
      const r = findNode(c, id);
      if (r) return r;
    }
    return null;
  };

  const startEdit = (id: string) => {
    if (!tree) return;
    const node = findNode(tree, id);
    if (!node) return;
    setEditId(id); setAddParentId(null);
    setMatchers([...node.matchers]); setFCpId(node.contactPointId);
    setFGroupBy(node.groupBy.join(', ')); setFWait(node.groupWaitSec);
    setFInterval(node.groupIntervalSec); setFRepeat(node.repeatIntervalSec);
    setFContinue(node.continueMatching); setFMuteIds(node.muteTimingIds);
  };

  const startAddChild = (parentId: string) => {
    setAddParentId(parentId); setEditId(null);
    setMatchers([{ label: '', operator: '=', value: '' }]);
    setFCpId(contactPoints[0]?.id ?? ''); setFGroupBy('');
    setFWait(30); setFInterval(300); setFRepeat(3600); setFContinue(false); setFMuteIds([]);
  };

  const cancelForm = () => { setEditId(null); setAddParentId(null); };

  const handleSave = async () => {
    const body = {
      matchers: matchers.filter((m) => m.label),
      contactPointId: fCpId,
      groupBy: fGroupBy.split(',').map((s) => s.trim()).filter(Boolean),
      groupWaitSec: fWait,
      groupIntervalSec: fInterval,
      repeatIntervalSec: fRepeat,
      continueMatching: fContinue,
      muteTimingIds: fMuteIds,
    };
    if (editId) {
      await apiClient.put(`/notifications/policies/${editId}`, body);
    } else if (addParentId) {
      await apiClient.post(`/notifications/policies/${addParentId}/children`, body);
    }
    cancelForm();
    await load();
  };

  const handleDelete = async (id: string) => {
    await apiClient.delete(`/notifications/policies/${id}`);
    await load();
  };

  if (loading) return <div className="text-[#B8B8A0] text-center py-8">Loading...</div>;
  if (!tree) return <div className="text-[#5555] text-center py-8">No policy tree</div>;

  const isEditing = editId !== null || addParentId !== null;

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <PolicyNodeRow node={tree} depth={0} contactPoints={contactPoints} muteTimings={muteTimings} onEdit={startEdit} onAddChild={startAddChild} onDelete={handleDelete} />
      </div>

      {isEditing && (
        <div className="p-4 rounded-lg bg-[#16161E] border border-[#6366F1]/30 space-y-3">
          <div className="text-sm font-semibold text-[#E8E8DE]">{editId ? 'Edit Policy' : 'Add Child Policy'}</div>
          <div>
            <label className="text-xs text-[#B8B8A0] block mb-1">Matchers</label>
            <MatcherEditor matchers={matchers} onChange={setMatchers} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <select className="bg-[#0B0B15] border border-[#2A2A3E] rounded px-2 py-1.5 text-sm text-[#E8E8DE]" value={fCpId} onChange={(e) => setFCpId(e.target.value)}>
              {contactPoints.map((cp) => <option key={cp.id} value={cp.id}>{cp.name}</option>)}
            </select>
            <input className="bg-[#0B0B15] border border-[#2A2A3E] rounded px-2 py-1.5 text-sm text-[#E8E8DE]" placeholder="groupBy, labels" value={fGroupBy} onChange={(e) => setFGroupBy(e.target.value)} />
            <input className="bg-[#0B0B15] border border-[#2A2A3E] rounded px-2 py-1.5 text-sm text-[#E8E8DE]" type="number" value={fWait} onChange={(e) => setFWait(Number(e.target.value))} />
            <input className="bg-[#0B0B15] border border-[#2A2A3E] rounded px-2 py-1.5 text-sm text-[#E8E8DE]" type="number" value={fInterval} onChange={(e) => setFInterval(Number(e.target.value))} />
            <input className="bg-[#0B0B15] border border-[#2A2A3E] rounded px-2 py-1.5 text-sm text-[#E8E8DE]" type="number" value={fRepeat} onChange={(e) => setFRepeat(Number(e.target.value))} />
          </div>
          <label className="flex items-center gap-2 text-xs text-[#B8B8A0]">
            <input type="checkbox" checked={fContinue} onChange={(e) => setFContinue(e.target.checked)} />
            Continue matching sublings
          </label>
          <div className="flex gap-2">
            <button onClick={() => void handleSave()} className="px-3 py-1.5 rounded bg-[#6366F1] text-white text-sm">Save</button>
            <button onClick={cancelForm} className="px-3 py-1.5 rounded bg-[#1E1E2A] text-[#B8B8A0] text-sm">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SilencesTab() {
  const [silences, setSilences] = useState<AlertSilence[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'active' | 'expired' | 'pending' | 'all'>('active');
  const [showAdd, setShowAdd] = useState(false);
  const [matchers, setMatchers] = useState<Array<{ label: string; operator: string; value: string }>>([{ label: '', operator: '=', value: '' }]);
  const [duration, setDuration] = useState('2');
  const [comment, setComment] = useState('');

  const load = useCallback(async () => {
    const res = await apiClient.get<AlertSilence[]>('/alert-rules/silences/all');
    if (!res.error) setSilences(Array.isArray(res.data) ? res.data : []);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    if (filter === 'all') return silences;
    return silences.filter((s) => s.status === filter);
  }, [silences, filter]);

  const handleSave = async () => {
    const ms = matchers.filter((m) => m.label);
    if (!ms.length || !comment.trim()) return;
    const hrs = parseInt(duration);
    const endsAt = new Date(Date.now() + (isNaN(hrs) ? 0 : hrs * 3600000));
    await apiClient.post('/alert-rules/silences', {
      matchers: ms,
      startsAt: new Date().toISOString(),
      endsAt: endsAt.toISOString(),
      comment: comment.trim(),
      createdBy: 'user',
    });
    setShowAdd(false);
    setMatchers([{ label: '', operator: '=', value: '' }]);
    setComment('');
    await load();
  };

  const handleDelete = async (id: string) => {
    await apiClient.delete(`/alert-rules/silences/${id}`);
    await load();
  };

  if (loading) return <div className="text-[#B8B8A0] text-center py-8">Loading...</div>;

  const counts = {
    active: silences.filter((s) => s.status === 'active').length,
    expired: silences.filter((s) => s.status === 'expired').length,
    pending: silences.filter((s) => s.status === 'pending').length,
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {(['active', 'expired', 'pending', 'all'] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${filter === f ? 'bg-[#6366F1]/10 text-[#A3BCFB]' : 'text-[#B8B8A0] hover:text-[#E8E8DE]'}`}>
              {f === 'all' ? `All (${silences.length})` : `${f.charAt(0).toUpperCase() + f.slice(1)} (${counts[f] ?? 0})`}
            </button>
          ))}
        </div>
        {!showAdd && <button onClick={() => setShowAdd(true)} className="px-3 py-1.5 rounded-lg bg-[#6366F1] text-white text-sm font-medium hover:bg-[#5555B6]">Add silence</button>}
      </div>

      {showAdd && (
        <div className="p-4 rounded-lg bg-[#16161E] border border-[#6366F1]/30 space-y-3">
          <h3 className="text-sm font-semibold text-[#E8E8DE]">New Silence</h3>
          <div>
            <label className="text-xs text-[#B8B8A0] block mb-1">Matchers</label>
            <MatcherEditor matchers={matchers} onChange={setMatchers} />
          </div>
          <label className="text-xs text-[#B8B8A0] block mb-1">Duration</label>
          <div className="flex gap-2">
            {['2h', '6h', '12h', '24h', '48h'].map((d) => (
              <button key={d} onClick={() => setDuration(d)} className={`px-2.5 py-1 rounded text-xs font-medium border ${duration === d ? 'bg-[#6366F1]/10 text-[#A3BCFB] border-[#6366F1]/40' : 'border-[#2A2A3E] text-[#B8B8A0]'}`}>
                {d}
              </button>
            ))}
          </div>
          <div>
            <label className="text-xs text-[#B8B8A0] block mb-1">Comment</label>
            <input className="w-full bg-[#0B0B15] border border-[#2A2A3E] rounded px-3 py-1.5 text-sm text-[#E8E8DE] outline-none" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Reason for silencing" />
          </div>
          <div className="flex gap-2">
            <button onClick={() => void handleSave()} className="px-3 py-1.5 rounded bg-[#6366F1] text-white text-sm">Create</button>
            <button onClick={() => setShowAdd(false)} className="px-3 py-1.5 rounded bg-[#1E1E2A] text-[#B8B8A0] text-sm">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-1">
        {filtered.map((s) => {
          const statusColor = s.status === 'active' ? '#22C55E' : s.status === 'pending' ? '#F59E0B' : '#5555';
          return (
            <div key={s.id} className="p-3 rounded-lg bg-[#16161E] border border-[#1E1E2A]">
              <div className="flex items-center gap-2 justify-between">
                <span className="px-2 py-0.5 rounded-full text-[10px] uppercase font-bold" style={{ color: statusColor, backgroundColor: `${statusColor}22` }}>
                  {s.status ?? 'active'}
                </span>
                <MatcherBadges matchers={s.matchers} />
              </div>
              <div className="mt-2 text-xs text-[#B8B8A0] shrink-0">
                <span>{relativeTime(s.startsAt)}</span>
                {s.status !== 'expired' && <button onClick={() => void handleDelete(s.id)} className="ml-2 text-[#EF4444] hover:underline">Expire</button>}
              </div>
              {s.comment && <div className="mt-1 text-sm text-[#E8E8DE]">{s.comment}</div>}
              <div className="text-[10px] text-[#5555]">by {s.createdBy} {relativeTime(s.createdAt)}</div>
            </div>
          );
        })}
        {!filtered.length && <div className="text-center py-8 text-[#5555]">No {filter === 'all' ? '' : `${filter} `}silences</div>}
      </div>
    </div>
  );
}

function MuteTimingsTab() {
  const [timings, setTimings] = useState<MuteTiming[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [startMin, setStartMin] = useState(0);
  const [endMin, setEndMin] = useState(1440);

  const load = useCallback(async () => {
    const res = await apiClient.get<MuteTiming[]>('/notifications/mute-timings');
    if (!res.error) setTimings(Array.isArray(res.data) ? res.data : []);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const resetForm = () => { setShowAdd(false); setEditId(null); setName(''); setWeekdays([]); setStartMin(0); setEndMin(1440); };
  const startEdit = (mt: MuteTiming) => {
    setEditId(mt.id); setShowAdd(false); setName(mt.name);
    setWeekdays(mt.timeIntervals?.[0]?.weekdays ?? []);
    setStartMin(mt.timeIntervals?.[0]?.timesOfDay?.[0]?.startMinute ?? 0);
    setEndMin(mt.timeIntervals?.[0]?.timesOfDay?.[0]?.endMinute ?? 1440);
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    const body = {
      name: name.trim(),
      timeIntervals: [{
        ...(weekdays.length ? { weekdays } : {}),
        ...(startMin !== 0 || endMin !== 1440 ? { timesOfDay: [{ startMinute: startMin, endMinute: endMin }] } : {}),
      }],
    };
    if (editId) await apiClient.put(`/notifications/mute-timings/${editId}`, body);
    else await apiClient.post('/notifications/mute-timings', body);
    resetForm();
    await load();
  };

  const handleDelete = async (id: string) => {
    await apiClient.delete(`/notifications/mute-timings/${id}`);
    await load();
  };

  const formatMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const summarize = (mt: MuteTiming): string => {
    const parts: string[] = [];
    if (mt.timeIntervals?.[0]?.weekdays?.length) parts.push(mt.timeIntervals[0].weekdays!.map((d) => WEEKDAYS[d]).join(', '));
    if (mt.timeIntervals?.[0]?.timesOfDay?.length) parts.push(mt.timeIntervals[0].timesOfDay!.map((t) => `${formatMin(t.startMinute)}–${formatMin(t.endMinute)}`).join(', '));
    return parts.join(' • ') || 'Always';
  };

  if (loading) return <div className="text-[#B8B8A0] text-center py-8">Loading...</div>;

  const isEditing = showAdd || editId !== null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-[#B8B8A0]">{timings.length} mute timing{timings.length === 1 ? '' : 's'}</span>
        {!isEditing && <button onClick={() => { setShowAdd(true); resetForm(); setShowAdd(true); }} className="px-3 py-1.5 rounded-lg bg-[#6366F1] text-white text-sm font-medium hover:bg-[#5555B6]">Add mute timing</button>}
      </div>

      {isEditing && (
        <div className="p-4 rounded-lg bg-[#16161E] border border-[#6366F1]/30">
          <div className="text-sm font-semibold text-[#E8E8DE] mb-3">{editId ? 'Edit' : 'New'} Mute Timing</div>
          <input className="w-full bg-[#0B0B15] border border-[#2A2A3E] rounded px-3 py-2 text-sm text-[#E8E8DE] outline-none mb-3" placeholder="Name (e.g. Weekends, Maintenance)" value={name} onChange={(e) => setName(e.target.value)} />
          <label className="text-xs text-[#B8B8A0] block mb-1">Weekdays</label>
          <div className="flex gap-1 flex-wrap mb-3">
            {WEEKDAYS.map((d, i) => (
              <button key={d} onClick={() => setWeekdays((prev) => prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i])} className={`px-2 py-1 rounded text-xs font-medium transition-colors ${weekdays.includes(i) ? 'bg-[#6366F1]/10 text-[#A3BCFB]' : 'border border-[#2A2A3E] text-[#B8B8A0]'}`}>
                {d}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-[#B8B8A0] block mb-1">Start time</label>
              <input type="time" className="w-full bg-[#0B0B15] border border-[#2A2A3E] rounded px-3 py-1.5 text-sm text-[#E8E8DE]" value={formatMin(startMin)} onChange={(e) => { const [h, m] = e.target.value.split(':').map(Number); setStartMin((h ?? 0) * 60 + (m ?? 0)); }} />
            </div>
            <div>
              <label className="text-xs text-[#B8B8A0] block mb-1">End time</label>
              <input type="time" className="w-full bg-[#0B0B15] border border-[#2A2A3E] rounded px-3 py-1.5 text-sm text-[#E8E8DE]" value={formatMin(endMin)} onChange={(e) => { const [h, m] = e.target.value.split(':').map(Number); setEndMin((h ?? 0) * 60 + (m ?? 0)); }} />
            </div>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={() => void handleSave()} className="px-3 py-1.5 rounded bg-[#6366F1] text-white text-sm">Save</button>
            <button onClick={resetForm} className="px-3 py-1.5 rounded bg-[#1E1E2A] text-[#B8B8A0] text-sm">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-1">
        {timings.map((mt) => (
          <div key={mt.id} className="p-3 rounded-lg bg-[#16161E] border border-[#1E1E2A] flex items-center justify-between">
            <div>
              <span className="text-sm font-semibold text-[#E8E8DE]">{mt.name}</span>
              <div className="text-xs text-[#B8B8A0] mt-0.5">{summarize(mt)}</div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => startEdit(mt)} className="text-xs text-[#6366F1] hover:underline">Edit</button>
              <button onClick={() => void handleDelete(mt.id)} className="text-xs text-[#EF4444] hover:underline">Delete</button>
            </div>
          </div>
        ))}
        {timings.length === 0 && !isEditing && <div className="text-center py-8 text-[#5555]">No mute timings configured</div>}
      </div>
    </div>
  );
}

function GroupsTab() {
  const [groups, setGroups] = useState<AlertGroup[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void apiClient.get<AlertGroup[]>('/notifications/alert-groups').then((res) => {
      if (!res.error) setGroups(Array.isArray(res.data) ? res.data : []);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="text-[#B8B8A0] text-center py-8">Loading...</div>;

  const stateColor: Record<string, string> = {
    firing: '#EF4444',
    pending: '#F59E0B',
    normal: '#22C55E',
    resolved: '#38B2F6',
  };

  return (
    <div className="space-y-3">
      {groups.length === 0 && (
        <div className="text-center py-12 text-[#5555] text-sm">No active alert groups</div>
      )}
      {groups.map((g, gi) => (
        <div key={gi} className="rounded-lg bg-[#16161E] border border-[#1E1E2A] overflow-hidden">
          <div className="px-3 py-2 bg-[#1A1A22] flex items-center gap-2">
            {Object.entries(g.labels).map(([k, v]) => (
              <span key={k} className="px-1.5 py-0.5 rounded bg-[#6366F1]/10 text-[#A3BCFB] text-xs font-mono">
                {k}={v}
              </span>
            ))}
            <span className="ml-auto text-xs text-[#B8B8A0]">{g.alerts.length} alert{g.alerts.length === 1 ? '' : 's'}</span>
          </div>
          <div className="divide-y divide-[#1E1E2A]">
            {g.alerts.map((a) => (
              <div key={a.ruleId} className="px-3 py-2 flex items-center gap-3">
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold" style={{ color: stateColor[a.state] ?? '#5555', backgroundColor: `${stateColor[a.state] ?? '#5555'}22` }}>
                  {a.state}
                </span>
                <span className="text-sm text-[#E8E8DE] font-medium">{a.ruleName}</span>
                <span className={`${a.severity === 'critical' ? 'text-[#EF4444]' : a.severity === 'high' ? 'text-[#F97316]' : 'text-[#B8B8A0]'} text-xs`}>
                  {a.severity}
                </span>
                {a.value !== undefined && <span className="text-xs text-[#B8B8A0]">val: {a.value}</span>}
                <span className="ml-auto text-[10px] text-[#5555]">{relativeTime(a.startsAt)}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function AlertingPage() {
  const [params, setParams] = useSearchParams();
  const activeTab = (params.get('tab') ?? 'alert-rules') as TabKey;

  const setTab = useCallback((tab: TabKey) => {
    setParams({ tab }, { replace: true });
  }, [setParams]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="text-2xl font-bold text-[#E8E8DE] mb-4">Alerting</h1>

      <div className="flex gap-4 border-b border-[#1E1E2A] mb-6">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors relative ${
              activeTab === tab.key
                ? 'text-[#E8E8DE]'
                : 'text-[#B8B8A0] hover:text-[#E8E8DE]'
            }`}
          >
            {tab.label}
            {activeTab === tab.key && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#6366F1] rounded-t" />
            )}
          </button>
        ))}
      </div>

      {activeTab === 'alert-rules' && <Alerts />}
      {activeTab === 'contact-points' && <ContactPointsTab />}
      {activeTab === 'policies' && <PoliciesTab />}
      {activeTab === 'silences' && <SilencesTab />}
      {activeTab === 'mute-timings' && <MuteTimingsTab />}
      {activeTab === 'groups' && <GroupsTab />}
    </div>
  );
}
