import React, { useState } from 'react';
import { apiClient } from '../api/client.js';

interface DashboardStub {
  id: string;
  title: string;
  status: string;
}

interface Props {
  onCreated: (dashboard: DashboardStub) => void;
}

export default function DashboardCreateInput({ onCreated }: Props) {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.post<DashboardStub>('/dashboards', { prompt: trimmed });
      if (res.error) {
        setError(res.error.message ?? 'Failed to create dashboard');
      } else {
        setPrompt('');
        onCreated(res.data);
      }
    } catch {
      setError('Network error - please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      void handleSubmit(e as unknown as React.FormEvent);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <div className="relative">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder='Describe the dashboard you want (e.g., "Create an Istio service mesh dashboard")'
          rows={3}
          className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-transparent placeholder:text-slate-400"
        />
      </div>
      {error && <p className="text-xs text-red-500 px-1">{error}</p>}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={!prompt.trim() || loading}
          className="px-5 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-40 transition-colors flex items-center gap-2"
        >
          {loading && (
            <span className="inline-block w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
          )}
          {loading ? 'Generating...' : 'Generate Dashboard'}
        </button>
      </div>
    </form>
  );
}
