import React, { useState, useEffect, useRef } from 'react';
import { apiClient } from '../api/client.js';
import type { DashboardVariable } from '../hooks/useDashboardChat.js';

interface Props {
  dashboardId: string;
  variables: DashboardVariable[];
  onChange: (name: string, value: string) => void;
}

interface DropdownProps {
  variable: DashboardVariable;
  dashboardId: string;
  onChange: (value: string) => void;
}

function VariablePill({ variable, dashboardId, onChange }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<string[]>(variable.options ?? []);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(variable.current ?? '');
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const openDropdown = async () => {
    setOpen(true);

    if (variable.type === 'query' && options.length === 0) {
      setLoading(true);
      try {
        const res = await apiClient.post<{ options: string[] }>(
          `/dashboards/${dashboardId}/variables/resolve`,
          { name: variable.name, query: variable.query },
        );
        if (!res.error) {
          setOptions(res.data.options);
        }
      } finally {
        setLoading(false);
      }
    }
  };

  const select = (val: string) => {
    setSelected(val);
    onChange(val);
    setOpen(false);
  };

  return (
    <div ref={dropdownRef} className="relative">
      <button
        type="button"
        onClick={() => void openDropdown()}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all duration-150 ${
          open
            ? 'bg-[#1C1C2E] border-[#6366F1] text-[#E8E8ED]'
            : 'bg-[#141420] border-[#2A2A3E] hover:border-[#4F46E5]/60 hover:text-[#E8E8ED]'
        }`}
      >
        <span className="text-[#6366F1] font-mono">$</span>
        <span>{variable.label ?? variable.name}</span>
        {selected && (
          <>
            <span className="text-[#555570]">:</span>
            <span className="text-[#E8E8ED] max-w-[100px] truncate">{selected}</span>
          </>
        )}
        <svg
          className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1.5 z-50 min-w-[160px] max-h-48 overflow-y-auto bg-[#141420] border border-[#2A2A3E] rounded-xl shadow-2xl py-1">
          {loading ? (
            <div className="flex items-center justify-center py-4">
              <span className="inline-block w-3.5 h-3.5 border-2 border-[#2A2A3E] border-t-[#6366F1] rounded-full animate-spin" />
            </div>
          ) : options.length === 0 ? (
            <p className="text-[#555570] text-xs px-3 py-2">No options</p>
          ) : (
            options.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => select(opt)}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                  opt === selected
                    ? 'bg-[#6366F1]/20 text-[#818CF8]'
                    : 'text-[#E8E8ED] hover:bg-[#1C1C2E]'
                }`}
              >
                {opt}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default function VariableBar({ dashboardId, variables, onChange }: Props) {
  if (!variables.length) return null;

  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-[#0A0A0F]/50 border-b border-[#2A2A3E] flex-wrap">
      {variables.map((variable) => (
        <VariablePill
          key={variable.name}
          variable={variable}
          dashboardId={dashboardId}
          onChange={(val) => onChange(variable.name, val)}
        />
      ))}
    </div>
  );
}
