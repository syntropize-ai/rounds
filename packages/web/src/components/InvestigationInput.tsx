import React, { useState, useRef } from 'react';
import { apiClient } from '../api/client.js';
import type { Investigation } from '../api/types.js';

interface Props {
  onCreated: (investigation: Investigation) => void;
}

export default function InvestigationInput({ onCreated }: Props) {
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError(null);

    try {
      const res = await apiClient.post<Investigation>('/investigations', { question: trimmed });
      if (res.error) {
        setError(res.error.message);
      } else {
        setMessage('');
        onCreated(res.data);
        textareaRef.current?.focus();
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
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe what you want to investigate. (⌘+Enter to submit)"
          rows={3}
          className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-transparent placeholder:text-slate-400"
        />
      </div>

      {error && <p className="text-xs text-red-500 px-1">{error}</p>}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={message.trim().length === 0 || loading}
          className="px-5 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
        >
          {loading && (
            <span className="inline-block w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
          )}
          {loading ? 'Investigating...' : 'Investigate'}
        </button>
      </div>
    </form>
  );
}
