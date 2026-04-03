# Prism Frontend Implementation Spec

## Overview

Build a React 18 + TypeScript frontend for the Prism AI observability platform.
Location: `packages/frontend` (npm workspace, part of the monorepo).

The UI is called **"Curator"** in the brand. Design is dark-themed, AI-centric, with a persistent right-side AI chat panel.

---

## Tech Stack

- **React 18 + TypeScript**
- **Vite** (build tool)
- **Tailwind CSS** (styling — color tokens already defined below)
- **React Router v6** (routing)
- **TanStack Query / React Query v5** (server state)
- **Zustand** (global UI state)
- **Recharts** (charts)
- **Google Material Symbols** (icons, via CDN in index.html)
- **Fonts**: Manrope + Inter (via Google Fonts in index.html)
- **Native EventSource** (SSE streaming)

---

## Package Setup

### `packages/frontend/package.json`

```json
{
  "name": "@agentic-obs/frontend",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.28.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.22.0",
    "recharts": "^2.12.0",
    "zustand": "^4.5.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.19",
    "postcss": "^8.4.38",
    "tailwindcss": "^3.4.3",
    "typescript": "*",
    "vite": "^5.2.0"
  }
}
```

### `packages/frontend/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noFallthroughCasesInSwitch": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

### `packages/frontend/tsconfig.node.json`

```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true
  },
  "include": ["vite.config.ts"]
}
```

### `packages/frontend/vite.config.ts`

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
})
```

### `packages/frontend/postcss.config.js`

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
```

### `packages/frontend/tailwind.config.ts`

```ts
import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: '#a3a6ff',
        'primary-container': '#9396ff',
        'primary-dim': '#6063ee',
        secondary: '#62fae3',
        error: '#ff6e84',
        tertiary: '#c180ff',
        surface: {
          base: '#0e0e0e',
          low: '#131313',
          DEFAULT: '#1a1919',
          high: '#201f1f',
          highest: '#262626',
          bright: '#2c2c2c',
          variant: '#262626',
        },
        'on-surface': '#ffffff',
        'on-surface-variant': '#adaaaa',
        outline: '#777575',
      },
      fontFamily: {
        display: ['Manrope', 'sans-serif'],
        body: ['Inter', 'sans-serif'],
      },
      borderRadius: {
        xl: '1.5rem',
        '2xl': '2rem',
      },
      backdropBlur: {
        ai: '20px',
      },
    },
  },
  plugins: [],
} satisfies Config
```

---

## `packages/frontend/index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Curator — AI Observability</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Manrope:wght@400;700;800&display=swap"
      rel="stylesheet"
    />
    <link
      rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200"
    />
  </head>
  <body class="bg-surface-base text-on-surface font-body">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

---

## `packages/frontend/src/index.css`

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  * {
    box-sizing: border-box;
  }

  body {
    background-color: #0e0e0e;
    color: #ffffff;
    font-family: 'Inter', sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  ::-webkit-scrollbar {
    width: 4px;
    height: 4px;
  }

  ::-webkit-scrollbar-track {
    background: transparent;
  }

  ::-webkit-scrollbar-thumb {
    background: #262626;
    border-radius: 2px;
  }
}

@layer components {
  .material-symbols-rounded {
    font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
  }

  .gradient-primary {
    background: linear-gradient(135deg, #a3a6ff, #6063ee);
  }

  .gradient-text {
    background: linear-gradient(135deg, #a3a6ff, #c180ff);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .ai-input {
    background: rgba(44, 44, 44, 0.6);
    backdrop-filter: blur(20px);
    border-radius: 1.5rem;
  }
}
```

---

## `packages/frontend/src/main.tsx`

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </BrowserRouter>
  </React.StrictMode>
)
```

---

## `packages/frontend/src/App.tsx`

```tsx
import { Routes, Route, Navigate } from 'react-router-dom'
import Home from '@/pages/Home'
import DashboardCanvas from '@/pages/DashboardCanvas'
import InvestigationReport from '@/pages/InvestigationReport'
import AlertCreation from '@/pages/AlertCreation'
import Explorer from '@/pages/Explorer'
import ExplorerFolder from '@/pages/ExplorerFolder'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/dashboards/:id" element={<DashboardCanvas />} />
      <Route path="/reports/:id" element={<InvestigationReport />} />
      <Route path="/alerts/new" element={<AlertCreation />} />
      <Route path="/explorer" element={<Explorer />} />
      <Route path="/explorer/folder/:id" element={<ExplorerFolder />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
```

---

## Design Tokens (use these everywhere)

```
Primary:           #a3a6ff
Primary Container: #9396ff
Primary Dim:       #6063ee
Secondary:         #62fae3   (healthy/success)
Error:             #ff6e84   (critical/alert)
Tertiary:          #c180ff   (AI keywords/syntax)

Surface Base:      #0e0e0e   (page background)
Surface Low:       #131313   (sidebar/AI panel bg)
Surface Default:   #1a1919   (canvas area)
Surface High:      #201f1f   (cards)
Surface Highest:   #262626   (elevated elements)
Surface Bright:    #2c2c2c   (inputs, float 60% opacity)
Surface Variant:   #262626   (user chat bubbles)

On Surface:        #ffffff   (primary text)
On Surface Variant:#adaaaa   (secondary text/metadata)
Outline:           #777575   (dividers, subtle borders)
```

**Critical Rules:**
- NO 1px border lines for layout sectioning — use background color shifts only
- Glassmorphism on AI inputs: `background: rgba(44,44,44,0.6); backdrop-filter: blur(20px)`
- Buttons use 135° gradient from `#a3a6ff` to `#6063ee`
- Elevation via tonal stacking, not drop shadows

---

## API Clients (`src/api/`)

Backend runs on `http://localhost:4000`. Vite proxies `/api` → backend.

### `src/api/client.ts`

```ts
const BASE = '/api'

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}
```

### `src/api/intent.ts`

```ts
import { apiFetch } from './client'

export interface IntentResult {
  type: 'create_dashboard' | 'investigate' | 'create_alert' | 'explore'
  entityId?: string
  redirect: string   // e.g. "/dashboards/new-id" or "/reports/new-id"
}

export const intentApi = {
  parse: (prompt: string) =>
    apiFetch<IntentResult>('/intent', {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }),
}
```

### `src/api/dashboards.ts`

```ts
import { apiFetch } from './client'

export interface Dashboard {
  id: string
  title: string
  panels: Panel[]
  variables: Variable[]
  timeRange: { from: string; to: string }
  createdAt: string
  updatedAt: string
}

export interface Panel {
  id: string
  title: string
  type: 'timeseries' | 'bar' | 'table' | 'stat'
  query: string
  gridPos: { x: number; y: number; w: number; h: number }
}

export interface Variable {
  name: string
  value: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

export const dashboardApi = {
  list: () => apiFetch<Dashboard[]>('/dashboards'),
  get: (id: string) => apiFetch<Dashboard>(`/dashboards/${id}`),
  create: (data: { title: string; prompt?: string }) =>
    apiFetch<Dashboard>('/dashboards', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<Dashboard>) =>
    apiFetch<Dashboard>(`/dashboards/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  getChatHistory: (id: string) => apiFetch<ChatMessage[]>(`/dashboards/${id}/chat`),
  // SSE streaming — returns EventSource
  streamChat: (id: string, message: string): EventSource => {
    const url = `/api/dashboards/${id}/chat?message=${encodeURIComponent(message)}`
    return new EventSource(url)
  },
}
```

### `src/api/query.ts`

```ts
import { apiFetch } from './client'

export interface TimeSeriesData {
  metric: Record<string, string>
  values: [number, number][]  // [timestamp, value]
}

export interface QueryResult {
  data: TimeSeriesData[]
}

export const queryApi = {
  range: (expr: string, from: string, to: string, step = '60s') =>
    apiFetch<QueryResult>('/query/range', {
      method: 'POST',
      body: JSON.stringify({ expr, from, to, step }),
    }),
  instant: (expr: string) =>
    apiFetch<QueryResult>('/query/instant', {
      method: 'POST',
      body: JSON.stringify({ expr }),
    }),
}
```

### `src/api/investigations.ts`

```ts
import { apiFetch } from './client'

export interface Investigation {
  id: string
  title: string
  status: 'planning' | 'investigating' | 'evidencing' | 'explaining' | 'completed'
  summary?: string
  findings: Finding[]
  hypotheses: Hypothesis[]
  timeline: TimelineEvent[]
  recommendations: Recommendation[]
  createdAt: string
}

export interface Finding {
  id: string
  type: string
  value: string
  unit?: string
  label: string
}

export interface Hypothesis {
  id: string
  text: string
  confidence: number
  supported: boolean
}

export interface TimelineEvent {
  id: string
  timestamp: string
  label: string
  severity: 'info' | 'warning' | 'critical' | 'resolved'
}

export interface Recommendation {
  id: string
  title: string
  description: string
  icon: string
  priority: 'high' | 'medium' | 'low'
}

export const investigationApi = {
  get: (id: string) => apiFetch<Investigation>(`/investigations/${id}`),
  list: () => apiFetch<Investigation[]>('/investigations'),
}
```

### `src/api/alerts.ts`

```ts
import { apiFetch } from './client'

export interface AlertRule {
  id: string
  title: string
  condition: {
    metric: string
    operator: 'gt' | 'lt' | 'gte' | 'lte'
    threshold: number
    duration: string
  }
  severity: 'P0' | 'P1' | 'P2' | 'P3'
  notifications: {
    slack: boolean
    pagerduty: boolean
    email: boolean
  }
  createdAt: string
}

export interface GeneratedRule {
  rule: AlertRule
  previewData: [number, number][]  // [timestamp, value]
}

export const alertApi = {
  generate: (prompt: string) =>
    apiFetch<GeneratedRule>('/alert-rules/generate', {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }),
  create: (rule: Omit<AlertRule, 'id' | 'createdAt'>) =>
    apiFetch<AlertRule>('/alert-rules', { method: 'POST', body: JSON.stringify(rule) }),
  update: (id: string, data: Partial<AlertRule>) =>
    apiFetch<AlertRule>(`/alert-rules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  test: (id: string) => apiFetch<{ firing: boolean; message: string }>(`/alert-rules/${id}/test`, { method: 'POST' }),
  list: () => apiFetch<AlertRule[]>('/alert-rules'),
}
```

### `src/api/explorer.ts`

```ts
import { apiFetch } from './client'

export type AssetType = 'dashboard' | 'report' | 'alert'
export type AssetStatus = 'healthy' | 'critical' | 'warning'

export interface Asset {
  id: string
  name: string
  type: AssetType
  status: AssetStatus
  origin: 'ai_generated' | 'manual'
  lastActivity: string
  author: string
  tags: string[]
}

export interface Folder {
  id: string
  name: string
  children?: Folder[]
}

export interface ExplorerResult {
  assets: Asset[]
  total: number
  folders: Folder[]
}

export const explorerApi = {
  list: (params?: { type?: AssetType; status?: AssetStatus; folderId?: string; page?: number }) =>
    apiFetch<ExplorerResult>('/investigations?' + new URLSearchParams(params as Record<string, string>)),
}
```

---

## Zustand Stores (`src/stores/`)

### `src/stores/aiPanel.ts`

```ts
import { create } from 'zustand'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
}

interface AIPanelState {
  isOpen: boolean
  messages: ChatMessage[]
  isStreaming: boolean
  toggle: () => void
  open: () => void
  close: () => void
  addMessage: (msg: ChatMessage) => void
  appendToLastMessage: (chunk: string) => void
  setStreaming: (v: boolean) => void
  clearMessages: () => void
}

export const useAIPanel = create<AIPanelState>((set) => ({
  isOpen: true,
  messages: [],
  isStreaming: false,
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  appendToLastMessage: (chunk) =>
    set((s) => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (last && last.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, content: last.content + chunk }
      }
      return { messages: msgs }
    }),
  setStreaming: (v) => set({ isStreaming: v }),
  clearMessages: () => set({ messages: [] }),
}))
```

### `src/stores/timeRange.ts`

```ts
import { create } from 'zustand'

export type TimeRangePreset = '15m' | '1h' | '3h' | '6h' | '12h' | '24h' | '7d'

interface TimeRangeState {
  preset: TimeRangePreset
  from: string
  to: string
  setPreset: (preset: TimeRangePreset) => void
}

function presetToRange(preset: TimeRangePreset): { from: string; to: string } {
  const now = new Date()
  const map: Record<TimeRangePreset, number> = {
    '15m': 15, '1h': 60, '3h': 180, '6h': 360, '12h': 720, '24h': 1440, '7d': 10080,
  }
  const from = new Date(now.getTime() - map[preset] * 60 * 1000)
  return { from: from.toISOString(), to: now.toISOString() }
}

export const useTimeRange = create<TimeRangeState>((set) => ({
  preset: '24h',
  ...presetToRange('24h'),
  setPreset: (preset) => set({ preset, ...presetToRange(preset) }),
}))
```

---

## Hooks (`src/hooks/`)

### `src/hooks/useSSEStream.ts`

```ts
import { useEffect, useRef } from 'react'

interface UseSSEStreamOptions {
  url: string | null          // null = don't connect
  onChunk: (chunk: string) => void
  onDone?: () => void
  onError?: (err: Event) => void
}

export function useSSEStream({ url, onChunk, onDone, onError }: UseSSEStreamOptions) {
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (!url) return

    const es = new EventSource(url)
    esRef.current = es

    es.onmessage = (e) => {
      if (e.data === '[DONE]') {
        onDone?.()
        es.close()
      } else {
        onChunk(e.data)
      }
    }

    es.onerror = (e) => {
      onError?.(e)
      es.close()
    }

    return () => {
      es.close()
      esRef.current = null
    }
  }, [url])
}
```

---

## UI Base Components (`src/components/ui/`)

### `src/components/ui/Button.tsx`

```tsx
import { ReactNode, ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  children: ReactNode
}

export function Button({ variant = 'primary', size = 'md', className, children, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center gap-2 font-medium transition-all active:scale-95 disabled:opacity-50',
        {
          'gradient-primary text-black rounded-xl': variant === 'primary',
          'bg-transparent text-on-surface-variant border border-outline/40 rounded-xl hover:bg-surface-high': variant === 'ghost',
          'bg-error/20 text-error border border-error/40 rounded-xl hover:bg-error/30': variant === 'danger',
        },
        {
          'px-3 py-1.5 text-xs': size === 'sm',
          'px-4 py-2 text-sm': size === 'md',
          'px-6 py-3 text-base': size === 'lg',
        },
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}
```

### `src/components/ui/Badge.tsx`

```tsx
import { ReactNode } from 'react'
import { cn } from '@/lib/cn'

type BadgeVariant = 'primary' | 'secondary' | 'error' | 'tertiary' | 'outline'

interface BadgeProps {
  variant?: BadgeVariant
  children: ReactNode
  className?: string
}

export function Badge({ variant = 'outline', children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
        {
          'bg-primary/20 text-primary': variant === 'primary',
          'bg-secondary/20 text-secondary': variant === 'secondary',
          'bg-error/20 text-error': variant === 'error',
          'bg-tertiary/20 text-tertiary': variant === 'tertiary',
          'border border-outline/40 text-on-surface-variant': variant === 'outline',
        },
        className
      )}
    >
      {children}
    </span>
  )
}
```

### `src/components/ui/StatusDot.tsx`

```tsx
import { cn } from '@/lib/cn'

type Status = 'healthy' | 'critical' | 'warning' | 'active'

interface StatusDotProps {
  status: Status
  pulse?: boolean
  className?: string
}

export function StatusDot({ status, pulse = false, className }: StatusDotProps) {
  return (
    <span
      className={cn(
        'inline-block w-2 h-2 rounded-full',
        {
          'bg-secondary': status === 'healthy',
          'bg-error': status === 'critical',
          'bg-yellow-400': status === 'warning',
          'bg-primary': status === 'active',
        },
        pulse && 'animate-pulse',
        className
      )}
    />
  )
}
```

### `src/components/ui/SuggestionChip.tsx`

```tsx
interface SuggestionChipProps {
  label: string
  icon?: string
  onClick?: () => void
}

export function SuggestionChip({ label, icon, onClick }: SuggestionChipProps) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-2 rounded-xl border border-outline/30 text-on-surface-variant text-sm hover:border-primary/40 hover:text-on-surface transition-all"
    >
      {icon && <span className="material-symbols-rounded text-base">{icon}</span>}
      {label}
    </button>
  )
}
```

### `src/components/ui/ChatBubble.tsx`

```tsx
import { cn } from '@/lib/cn'

interface ChatBubbleProps {
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
}

export function ChatBubble({ role, content, streaming }: ChatBubbleProps) {
  return (
    <div className={cn('flex', role === 'user' ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] px-4 py-3 text-sm leading-relaxed',
          role === 'assistant'
            ? 'bg-surface-high rounded-2xl rounded-tl-none border-l-2 border-primary/40 text-on-surface'
            : 'bg-surface-variant rounded-2xl rounded-tr-none text-on-surface'
        )}
      >
        {content}
        {streaming && <span className="inline-block w-1 h-4 bg-primary ml-1 animate-pulse" />}
      </div>
    </div>
  )
}
```

### `src/lib/cn.ts`

```ts
export function cn(...classes: (string | boolean | undefined | null | Record<string, boolean>)[]): string {
  return classes
    .map((c) => {
      if (!c) return ''
      if (typeof c === 'string') return c
      if (typeof c === 'object') return Object.entries(c).filter(([, v]) => v).map(([k]) => k).join(' ')
      return ''
    })
    .filter(Boolean)
    .join(' ')
}
```

---

## Chart Components (`src/components/charts/`)

### `src/components/charts/LineChart.tsx`

```tsx
import {
  ResponsiveContainer,
  LineChart as ReLineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'

interface Series {
  name: string
  data: { time: string; value: number }[]
  color?: string
}

interface LineChartProps {
  series: Series[]
  height?: number
  unit?: string
}

const COLORS = ['#a3a6ff', '#62fae3', '#c180ff', '#ff6e84', '#ffd166']

export function LineChart({ series, height = 200, unit = '' }: LineChartProps) {
  // Merge all series into unified time-keyed records
  const timeMap = new Map<string, Record<string, number>>()
  series.forEach((s, i) => {
    s.data.forEach(({ time, value }) => {
      if (!timeMap.has(time)) timeMap.set(time, { time: +new Date(time) })
      timeMap.get(time)![s.name] = value
    })
  })
  const chartData = Array.from(timeMap.values()).sort((a, b) => (a.time as number) - (b.time as number))

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ReLineChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#262626" />
        <XAxis
          dataKey="time"
          tickFormatter={(v) => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          stroke="#777575"
          tick={{ fontSize: 11, fill: '#adaaaa' }}
        />
        <YAxis
          stroke="#777575"
          tick={{ fontSize: 11, fill: '#adaaaa' }}
          tickFormatter={(v) => `${v}${unit}`}
        />
        <Tooltip
          contentStyle={{ background: '#201f1f', border: '1px solid #262626', borderRadius: 8, fontSize: 12 }}
          labelFormatter={(v) => new Date(v).toLocaleTimeString()}
          formatter={(v: number) => [`${v}${unit}`]}
        />
        <Legend wrapperStyle={{ fontSize: 11, color: '#adaaaa' }} />
        {series.map((s, i) => (
          <Line
            key={s.name}
            type="monotone"
            dataKey={s.name}
            stroke={s.color || COLORS[i % COLORS.length]}
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 4 }}
          />
        ))}
      </ReLineChart>
    </ResponsiveContainer>
  )
}
```

### `src/components/charts/BarChart.tsx`

```tsx
import {
  ResponsiveContainer,
  BarChart as ReBarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts'

interface BarChartProps {
  data: { label: string; value: number }[]
  height?: number
  color?: string
  unit?: string
}

export function BarChart({ data, height = 180, color = '#a3a6ff', unit = '' }: BarChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ReBarChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#262626" />
        <XAxis dataKey="label" stroke="#777575" tick={{ fontSize: 11, fill: '#adaaaa' }} />
        <YAxis stroke="#777575" tick={{ fontSize: 11, fill: '#adaaaa' }} tickFormatter={(v) => `${v}${unit}`} />
        <Tooltip
          contentStyle={{ background: '#201f1f', border: '1px solid #262626', borderRadius: 8, fontSize: 12 }}
          formatter={(v: number) => [`${v}${unit}`]}
        />
        <Bar dataKey="value" fill={color} radius={[3, 3, 0, 0]} />
      </ReBarChart>
    </ResponsiveContainer>
  )
}
```

---

## Layout Components (`src/components/layout/`)

### `src/components/layout/SideNav.tsx`

Design: Collapsible dark sidebar. Collapsed = w-16 (icon only). Expanded = w-56.
Background: `surface-low (#131313)`. No border lines.

Nav items:
- Home (home icon → `/`)
- Dashboards (dashboard icon → `/dashboards/new` but for now link to explorer)
- Explorer (folder icon → `/explorer`)
- Reports (description icon → `/reports`)
- Alerts (notifications icon → `/alerts/new`)

Bottom items:
- Docs (menu_book icon)
- Settings (settings icon)
- User avatar + name (collapsed: avatar only)

```tsx
import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { cn } from '@/lib/cn'

const navItems = [
  { icon: 'home', label: 'Home', to: '/' },
  { icon: 'grid_view', label: 'Dashboards', to: '/explorer' },
  { icon: 'folder_open', label: 'Explorer', to: '/explorer' },
  { icon: 'description', label: 'Reports', to: '/explorer' },
  { icon: 'notifications', label: 'Alerts', to: '/alerts/new' },
]

export function SideNav() {
  const [expanded, setExpanded] = useState(false)
  const location = useLocation()

  return (
    <nav
      className={cn(
        'flex flex-col h-screen bg-surface-low transition-all duration-300 flex-shrink-0',
        expanded ? 'w-56' : 'w-16'
      )}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
    >
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 py-5 h-16">
        <div className="w-8 h-8 rounded-lg gradient-primary flex items-center justify-center flex-shrink-0">
          <span className="material-symbols-rounded text-black text-sm">auto_awesome</span>
        </div>
        {expanded && (
          <span className="font-display font-bold text-base gradient-text whitespace-nowrap">Curator</span>
        )}
      </div>

      {/* New Analysis button */}
      <div className="px-3 mb-4">
        <Link to="/" className={cn('gradient-primary rounded-xl flex items-center gap-2 text-black font-medium text-sm', expanded ? 'px-3 py-2' : 'p-2 justify-center')}>
          <span className="material-symbols-rounded text-base">add</span>
          {expanded && 'New Analysis'}
        </Link>
      </div>

      {/* Nav items */}
      <div className="flex flex-col gap-1 px-2 flex-1">
        {navItems.map((item) => {
          const active = location.pathname === item.to || (item.to !== '/' && location.pathname.startsWith(item.to))
          return (
            <Link
              key={item.label}
              to={item.to}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all text-sm',
                active
                  ? 'bg-primary/20 text-primary'
                  : 'text-on-surface-variant hover:bg-surface-high hover:text-on-surface'
              )}
            >
              <span className="material-symbols-rounded text-xl flex-shrink-0">{item.icon}</span>
              {expanded && <span className="whitespace-nowrap">{item.label}</span>}
            </Link>
          )
        })}
      </div>

      {/* Bottom */}
      <div className="px-2 pb-4 flex flex-col gap-1">
        {[{ icon: 'menu_book', label: 'Docs' }, { icon: 'settings', label: 'Settings' }].map((item) => (
          <button
            key={item.label}
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-on-surface-variant hover:bg-surface-high hover:text-on-surface transition-all text-sm"
          >
            <span className="material-symbols-rounded text-xl flex-shrink-0">{item.icon}</span>
            {expanded && <span className="whitespace-nowrap">{item.label}</span>}
          </button>
        ))}
        {/* User */}
        <div className={cn('flex items-center gap-3 px-3 py-2.5 rounded-xl text-on-surface-variant text-sm')}>
          <div className="w-7 h-7 rounded-full bg-primary/30 flex items-center justify-center text-primary text-xs font-bold flex-shrink-0">
            A
          </div>
          {expanded && (
            <div className="overflow-hidden">
              <div className="text-on-surface text-xs font-medium truncate">Alex Chen</div>
              <div className="text-on-surface-variant text-xs truncate">Site Reliability</div>
            </div>
          )}
        </div>
      </div>
    </nav>
  )
}
```

### `src/components/layout/TopBar.tsx`

```tsx
import { useTimeRange, TimeRangePreset } from '@/stores/timeRange'
import { useAIPanel } from '@/stores/aiPanel'

const PRESETS: TimeRangePreset[] = ['15m', '1h', '3h', '6h', '12h', '24h', '7d']

interface TopBarProps {
  title?: string
  showTimeRange?: boolean
}

export function TopBar({ title, showTimeRange = true }: TopBarProps) {
  const { preset, setPreset } = useTimeRange()
  const { toggle } = useAIPanel()

  return (
    <div className="flex items-center justify-between px-6 h-14 bg-surface flex-shrink-0">
      {title && <h1 className="font-display font-bold text-base text-on-surface">{title}</h1>}
      <div className="flex items-center gap-3 ml-auto">
        {showTimeRange && (
          <div className="flex items-center gap-1 bg-surface-high rounded-xl p-1">
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => setPreset(p)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                  preset === p
                    ? 'bg-primary/20 text-primary'
                    : 'text-on-surface-variant hover:text-on-surface'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        )}
        <button className="p-2 rounded-xl text-on-surface-variant hover:bg-surface-high hover:text-on-surface transition-all">
          <span className="material-symbols-rounded text-xl">share</span>
        </button>
        <button className="p-2 rounded-xl text-on-surface-variant hover:bg-surface-high hover:text-on-surface transition-all">
          <span className="material-symbols-rounded text-xl">notifications</span>
        </button>
        <button
          onClick={toggle}
          className="p-2 rounded-xl text-on-surface-variant hover:bg-surface-high hover:text-on-surface transition-all"
          title="Toggle AI Panel"
        >
          <span className="material-symbols-rounded text-xl">smart_toy</span>
        </button>
      </div>
    </div>
  )
}
```

### `src/components/layout/AIPanel.tsx`

Design: Right-side panel, 30% width, `surface-low` background. AI chat with SSE streaming.
Header: pulsing secondary dot + "AI Curator" + close button.
Chat history renders ChatBubble components.
Input: glassmorphic pill input at bottom.

```tsx
import { useState, useRef, useEffect } from 'react'
import { useAIPanel } from '@/stores/aiPanel'
import { ChatBubble } from '@/components/ui/ChatBubble'
import { SuggestionChip } from '@/components/ui/SuggestionChip'

interface AIPanelProps {
  suggestions?: { label: string; icon?: string }[]
  onSend?: (message: string) => void
  placeholder?: string
}

export function AIPanel({ suggestions = [], onSend, placeholder = 'Ask AI Curator...' }: AIPanelProps) {
  const { isOpen, close, messages, isStreaming } = useAIPanel()
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  if (!isOpen) return null

  function handleSend() {
    const msg = input.trim()
    if (!msg || isStreaming) return
    setInput('')
    onSend?.(msg)
  }

  return (
    <div className="w-[30%] min-w-[300px] max-w-[420px] h-full flex flex-col bg-surface-low flex-shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-secondary animate-pulse" />
          <span className="font-display font-bold text-sm gradient-text">AI Curator</span>
        </div>
        <button onClick={close} className="text-on-surface-variant hover:text-on-surface transition-all">
          <span className="material-symbols-rounded text-lg">close</span>
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-2 flex flex-col gap-3">
        {messages.length === 0 && (
          <div className="text-on-surface-variant text-sm text-center mt-8">
            Welcome! What would you like to explore?
          </div>
        )}
        {messages.map((msg, i) => (
          <ChatBubble
            key={i}
            role={msg.role}
            content={msg.content}
            streaming={msg.streaming && i === messages.length - 1}
          />
        ))}
        {suggestions.length > 0 && messages.length > 0 && !isStreaming && (
          <div className="flex flex-wrap gap-2 mt-1">
            {suggestions.map((s) => (
              <SuggestionChip key={s.label} label={s.label} icon={s.icon} onClick={() => onSend?.(s.label)} />
            ))}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 flex-shrink-0">
        <div className="ai-input flex items-center gap-2 px-4 py-3">
          <span className="material-symbols-rounded text-on-surface-variant text-base">chat</span>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder={placeholder}
            className="flex-1 bg-transparent text-sm text-on-surface placeholder:text-on-surface-variant outline-none"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isStreaming}
            className="text-primary hover:text-primary-dim disabled:text-on-surface-variant/40 transition-all"
          >
            <span className="material-symbols-rounded text-base">send</span>
          </button>
        </div>
        <p className="text-center text-on-surface-variant text-xs mt-2">Press Enter to chat</p>
      </div>
    </div>
  )
}
```

---

## Dashboard Components (`src/components/dashboard/`)

### `src/components/dashboard/PanelCard.tsx`

```tsx
import { ReactNode } from 'react'

interface PanelCardProps {
  title: string
  children: ReactNode
  className?: string
}

export function PanelCard({ title, children, className = '' }: PanelCardProps) {
  return (
    <div className={`bg-surface-high rounded-2xl p-4 flex flex-col gap-3 ${className}`}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-on-surface-variant">{title}</h3>
        <button className="text-on-surface-variant/40 hover:text-on-surface-variant transition-all">
          <span className="material-symbols-rounded text-base">drag_indicator</span>
        </button>
      </div>
      {children}
    </div>
  )
}
```

### `src/components/dashboard/DashboardGrid.tsx`

```tsx
import { Panel } from '@/api/dashboards'
import { PanelCard } from './PanelCard'
import { LineChart } from '@/components/charts/LineChart'
import { BarChart } from '@/components/charts/BarChart'

interface DashboardGridProps {
  panels: Panel[]
}

// Mock data for display — in real app fetched via queryApi
function mockLineSeries(names: string[]) {
  const now = Date.now()
  return names.map((name) => ({
    name,
    data: Array.from({ length: 24 }, (_, i) => ({
      time: new Date(now - (23 - i) * 3600_000).toISOString(),
      value: Math.random() * 80 + 10,
    })),
  }))
}

function mockBarData(labels: string[]) {
  return labels.map((label) => ({ label, value: Math.random() * 100 }))
}

export function DashboardGrid({ panels }: DashboardGridProps) {
  if (panels.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-on-surface-variant text-sm">
        No panels yet. Ask AI Curator to add some.
      </div>
    )
  }

  return (
    <div className="grid grid-cols-12 gap-4 p-6 overflow-y-auto">
      {panels.map((panel) => {
        const colSpan = Math.min(panel.gridPos.w, 12)
        return (
          <div key={panel.id} className={`col-span-${colSpan}`}>
            <PanelCard title={panel.title}>
              {panel.type === 'timeseries' && (
                <LineChart series={mockLineSeries(['service-a', 'service-b'])} height={180} unit="%" />
              )}
              {panel.type === 'bar' && (
                <BarChart data={mockBarData(['Auth', 'DB', 'API', 'Web'])} height={160} />
              )}
              {panel.type === 'stat' && (
                <div className="text-3xl font-display font-bold text-primary">
                  {(Math.random() * 100).toFixed(1)}%
                </div>
              )}
            </PanelCard>
          </div>
        )
      })}
    </div>
  )
}
```

---

## Pages

### `src/pages/Home.tsx`

Layout: Full screen, centered content, no split. SideNav on left.
- Large headline: "Welcome, what are we **investigating** today?"
- Subheading: "Curator is analyzing your telemetry in real-time."
- Glassmorphic large chat input
- 3-column suggestion grid
- Bottom right: pulsing indicator

```tsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SideNav } from '@/components/layout/SideNav'
import { SuggestionChip } from '@/components/ui/SuggestionChip'
import { intentApi } from '@/api/intent'

const SUGGESTIONS = [
  { label: 'Analyze CPU spike in checkout-service', icon: 'speed', category: 'PERFORMANCE' },
  { label: 'Create a dashboard for user login latency', icon: 'grid_view', category: 'DASHBOARDS' },
  { label: 'Explain the recent 5xx error surge', icon: 'crisis_alert', category: 'INCIDENT' },
]

export default function Home() {
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  async function handleSubmit(text?: string) {
    const msg = (text || prompt).trim()
    if (!msg) return
    setLoading(true)
    try {
      const result = await intentApi.parse(msg)
      navigate(result.redirect)
    } catch {
      // On error, navigate to explorer as fallback
      navigate('/explorer')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-screen bg-surface-base overflow-hidden">
      <SideNav />

      <main className="flex-1 flex flex-col items-center justify-center px-8">
        {/* Headline */}
        <div className="max-w-2xl w-full text-center mb-10">
          <h1 className="font-display font-extrabold text-5xl text-on-surface mb-4 leading-tight">
            Welcome, what are we{' '}
            <em className="not-italic gradient-text">investigating</em>{' '}
            today?
          </h1>
          <p className="text-on-surface-variant text-lg">
            Curator is analyzing your telemetry in real-time.
          </p>
        </div>

        {/* Main input */}
        <div className="max-w-2xl w-full mb-8">
          <div className="ai-input flex items-center gap-3 px-5 py-4">
            <span className="material-symbols-rounded text-primary text-2xl">search</span>
            <input
              autoFocus
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              placeholder="Ask about a service, create a dashboard, investigate an incident..."
              className="flex-1 bg-transparent text-on-surface placeholder:text-on-surface-variant outline-none text-base"
            />
            {loading ? (
              <span className="material-symbols-rounded text-primary text-xl animate-spin">progress_activity</span>
            ) : (
              <button
                onClick={() => handleSubmit()}
                className="gradient-primary rounded-lg p-1.5 text-black"
              >
                <span className="material-symbols-rounded text-base">arrow_forward</span>
              </button>
            )}
          </div>
        </div>

        {/* Suggestions */}
        <div className="max-w-2xl w-full grid grid-cols-3 gap-3">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              onClick={() => handleSubmit(s.label)}
              className="flex flex-col gap-2 p-4 rounded-2xl bg-surface-high hover:bg-surface-highest transition-all text-left group"
            >
              <div className="flex items-center gap-2">
                <span className="material-symbols-rounded text-primary text-base">{s.icon}</span>
                <span className="text-on-surface-variant text-xs font-medium tracking-widest uppercase">{s.category}</span>
              </div>
              <p className="text-on-surface text-sm group-hover:text-primary transition-all leading-snug">{s.label}</p>
            </button>
          ))}
        </div>
      </main>

      {/* Bottom-right status */}
      <div className="absolute bottom-6 right-6 flex items-center gap-2 text-secondary text-xs">
        <span className="w-2 h-2 rounded-full bg-secondary animate-pulse" />
        Collector Active
      </div>
    </div>
  )
}
```

### `src/pages/DashboardCanvas.tsx`

Layout: SideNav + TopBar + 70/30 split (DashboardGrid left, AIPanel right).

```tsx
import { useState, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { SideNav } from '@/components/layout/SideNav'
import { TopBar } from '@/components/layout/TopBar'
import { AIPanel } from '@/components/layout/AIPanel'
import { DashboardGrid } from '@/components/dashboard/DashboardGrid'
import { useAIPanel } from '@/stores/aiPanel'
import { dashboardApi } from '@/api/dashboards'
import { useSSEStream } from '@/hooks/useSSEStream'

const DEFAULT_SUGGESTIONS = [
  { label: 'Show error rates', icon: 'error' },
  { label: 'Compare to last week', icon: 'compare_arrows' },
  { label: 'Add memory panel', icon: 'memory' },
]

export default function DashboardCanvas() {
  const { id } = useParams<{ id: string }>()
  const { addMessage, appendToLastMessage, setStreaming, isOpen } = useAIPanel()
  const [sseUrl, setSseUrl] = useState<string | null>(null)

  const { data: dashboard, isLoading } = useQuery({
    queryKey: ['dashboard', id],
    queryFn: () => dashboardApi.get(id!),
    enabled: !!id && id !== 'new',
  })

  useSSEStream({
    url: sseUrl,
    onChunk: (chunk) => appendToLastMessage(chunk),
    onDone: () => {
      setStreaming(false)
      setSseUrl(null)
    },
    onError: () => {
      setStreaming(false)
      setSseUrl(null)
    },
  })

  const handleSend = useCallback((message: string) => {
    addMessage({ role: 'user', content: message })
    addMessage({ role: 'assistant', content: '', streaming: true })
    setStreaming(true)
    setSseUrl(`/api/dashboards/${id}/chat?message=${encodeURIComponent(message)}`)
  }, [id])

  return (
    <div className="flex h-screen bg-surface-base overflow-hidden">
      <SideNav />

      <div className="flex-1 flex flex-col overflow-hidden">
        <TopBar title={dashboard?.title || 'Dashboard'} showTimeRange />

        <div className="flex-1 flex overflow-hidden">
          {/* Left: Dashboard grid (70%) */}
          <div className={`flex-1 bg-surface overflow-hidden flex flex-col`}>
            {isLoading ? (
              <div className="flex-1 flex items-center justify-center text-on-surface-variant">
                Loading dashboard...
              </div>
            ) : (
              <DashboardGrid panels={dashboard?.panels || []} />
            )}
          </div>

          {/* Right: AI Panel (30%) */}
          {isOpen && (
            <AIPanel
              suggestions={DEFAULT_SUGGESTIONS}
              onSend={handleSend}
              placeholder="Ask to add or modify panels..."
            />
          )}
        </div>
      </div>
    </div>
  )
}
```

### `src/pages/InvestigationReport.tsx`

Layout: SideNav + 70/30 split. Left: report document. Right: AIPanel.

The report left panel shows:
- Badge "Critical Incident" + ref number
- Title with timestamp
- Metadata (date, author)
- Summary with primary left-bar accent
- Key Findings: stat cards (peak latency, error rate)
- Timeline: vertical dots + events
- Embedded bar chart (latency spike)
- Recommendations: 2-col cards

```tsx
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { SideNav } from '@/components/layout/SideNav'
import { AIPanel } from '@/components/layout/AIPanel'
import { TopBar } from '@/components/layout/TopBar'
import { Badge } from '@/components/ui/Badge'
import { StatusDot } from '@/components/ui/StatusDot'
import { BarChart } from '@/components/charts/BarChart'
import { useAIPanel } from '@/stores/aiPanel'
import { investigationApi } from '@/api/investigations'

const MOCK_TIMELINE = [
  { id: '1', timestamp: '3:10 PM', label: 'Initial DB latency increase', severity: 'info' as const },
  { id: '2', timestamp: '3:15 PM', label: 'Alert Fired', severity: 'critical' as const },
  { id: '3', timestamp: '3:22 PM', label: 'Manual connection pool restart', severity: 'info' as const },
  { id: '4', timestamp: '3:25 PM', label: 'Incident mitigated', severity: 'resolved' as const },
]

const MOCK_RECOMMENDATIONS = [
  { id: '1', title: 'Scale Replica Count', icon: 'dynamic_feed', color: 'text-primary' },
  { id: '2', title: 'Optimize DB Pooling', icon: 'settings_input_component', color: 'text-secondary' },
  { id: '3', title: 'Circuit Breaker Update', icon: 'shield', color: 'text-tertiary' },
  { id: '4', title: 'Post-Mortem Review', icon: 'history_edu', color: 'text-on-surface-variant' },
]

const MOCK_SPIKE_DATA = Array.from({ length: 12 }, (_, i) => ({
  label: `${3 + Math.floor(i / 4)}:${String((i % 4) * 5).padStart(2, '0')} PM`,
  value: i === 6 ? 420 : Math.random() * 30 + 10,
}))

export default function InvestigationReport() {
  const { id } = useParams<{ id: string }>()
  const { isOpen, addMessage } = useAIPanel()

  const { data: report, isLoading } = useQuery({
    queryKey: ['investigation', id],
    queryFn: () => investigationApi.get(id!),
    enabled: !!id,
  })

  const severityColors: Record<string, string> = {
    info: 'bg-on-surface-variant',
    warning: 'bg-yellow-400',
    critical: 'bg-error',
    resolved: 'bg-secondary',
  }

  return (
    <div className="flex h-screen bg-surface-base overflow-hidden">
      <SideNav />

      <div className="flex-1 flex flex-col overflow-hidden">
        <TopBar title="Investigation Report" showTimeRange={false} />

        <div className="flex-1 flex overflow-hidden">
          {/* Left: Report document */}
          <div className="flex-1 bg-surface overflow-y-auto p-8">
            {isLoading ? (
              <div className="text-on-surface-variant">Loading report...</div>
            ) : (
              <div className="max-w-3xl mx-auto space-y-8">
                {/* Header */}
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <Badge variant="error">Critical Incident</Badge>
                    <span className="text-on-surface-variant text-sm">{id || 'INC-4092-A'}</span>
                  </div>
                  <h1 className="font-display font-bold text-2xl">
                    {report?.title || 'Investigation Report: Auth Service Spike (3:15 PM)'}
                  </h1>
                  <div className="flex items-center gap-4 text-on-surface-variant text-sm">
                    <span className="flex items-center gap-1">
                      <span className="material-symbols-rounded text-base">calendar_today</span>
                      {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="material-symbols-rounded text-base">person</span>
                      AI Curator & Engineering Team
                    </span>
                  </div>
                </div>

                {/* Summary */}
                <div className="flex gap-4 bg-surface-high rounded-2xl p-5">
                  <div className="w-1 bg-primary rounded-full flex-shrink-0" />
                  <p className="text-on-surface text-sm leading-relaxed">
                    {report?.summary || (
                      <>
                        The <span className="text-tertiary font-medium">auth-service</span> experienced a{' '}
                        <span className="text-error font-medium">450% increase</span> in p99 latency reaching{' '}
                        <span className="text-error font-medium">4.2s</span> (baseline 150ms) caused by connection
                        pool exhaustion following an upstream database failover at 3:10 PM.
                      </>
                    )}
                  </p>
                </div>

                {/* Key Findings */}
                <div>
                  <h2 className="font-display font-bold text-base mb-4">Key Findings</h2>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-surface-high rounded-2xl p-4">
                      <div className="text-on-surface-variant text-xs mb-1">Peak Latency</div>
                      <div className="text-error text-2xl font-display font-bold">4.2s</div>
                      <div className="text-on-surface-variant text-xs mt-1">vs 150ms avg</div>
                    </div>
                    <div className="bg-surface-high rounded-2xl p-4">
                      <div className="text-on-surface-variant text-xs mb-1">Error Rate</div>
                      <div className="text-secondary text-2xl font-display font-bold">12.4%</div>
                      <div className="text-on-surface-variant text-xs mt-1">HTTP 503</div>
                    </div>
                  </div>
                </div>

                {/* Timeline */}
                <div>
                  <h2 className="font-display font-bold text-base mb-4">Timeline</h2>
                  <div className="relative pl-4">
                    <div className="absolute left-4 top-2 bottom-2 w-px bg-outline/30" />
                    <div className="space-y-4">
                      {MOCK_TIMELINE.map((event, i) => (
                        <div key={event.id} className="flex items-start gap-4 relative">
                          <div className={`w-3 h-3 rounded-full mt-0.5 flex-shrink-0 relative z-10 ${severityColors[event.severity]}`} />
                          <div>
                            <span className="text-on-surface-variant text-xs">{event.timestamp}</span>
                            <p className={`text-sm mt-0.5 ${event.severity === 'critical' ? 'text-error font-semibold' : 'text-on-surface'}`}>
                              {event.label}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Latency spike chart */}
                <div className="bg-surface-high rounded-2xl p-4">
                  <h3 className="text-sm text-on-surface-variant mb-3">Latency Spike (ms)</h3>
                  <BarChart
                    data={MOCK_SPIKE_DATA}
                    height={160}
                    color="#ff6e84"
                    unit="ms"
                  />
                </div>

                {/* Recommendations */}
                <div>
                  <h2 className="font-display font-bold text-base mb-4">Recommendations</h2>
                  <div className="grid grid-cols-2 gap-3">
                    {MOCK_RECOMMENDATIONS.map((rec) => (
                      <button
                        key={rec.id}
                        className="flex items-center gap-3 bg-surface-high rounded-2xl p-4 text-left hover:bg-surface-highest transition-all"
                      >
                        <span className={`material-symbols-rounded text-xl ${rec.color}`}>{rec.icon}</span>
                        <span className="text-sm text-on-surface">{rec.title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Right: AI Panel */}
          {isOpen && (
            <AIPanel
              suggestions={[
                { label: 'How to fix?', icon: 'build' },
                { label: 'Show DB logs', icon: 'article' },
                { label: 'Compare to last week', icon: 'compare' },
              ]}
              onSend={(msg) => addMessage({ role: 'user', content: msg })}
            />
          )}
        </div>
      </div>
    </div>
  )
}
```

### `src/pages/AlertCreation.tsx`

Layout: SideNav + TopBar + 70/30 split.
Left: Alert builder (condition, severity, preview chart, notifications).
Right: AIPanel.

```tsx
import { useState } from 'react'
import { SideNav } from '@/components/layout/SideNav'
import { TopBar } from '@/components/layout/TopBar'
import { AIPanel } from '@/components/layout/AIPanel'
import { Button } from '@/components/ui/Button'
import { useAIPanel } from '@/stores/aiPanel'
import { BarChart } from '@/components/charts/BarChart'

const SEVERITIES = [
  { key: 'P0', label: 'P0 Critical' },
  { key: 'P1', label: 'P1 High' },
  { key: 'P2', label: 'P2 Med' },
  { key: 'P3', label: 'P3 Low' },
]

const PREVIEW_DATA = Array.from({ length: 24 }, (_, i) => ({
  label: `${i}:00`,
  value: Math.random() * 8 + (i >= 14 && i <= 16 ? 12 : 1),
}))

export default function AlertCreation() {
  const [severity, setSeverity] = useState('P1')
  const [notifications, setNotifications] = useState({ slack: true, pagerduty: true, email: false })
  const { isOpen, addMessage } = useAIPanel()

  function toggleNotification(key: keyof typeof notifications) {
    setNotifications((n) => ({ ...n, [key]: !n[key] }))
  }

  return (
    <div className="flex h-screen bg-surface-base overflow-hidden">
      <SideNav />

      <div className="flex-1 flex flex-col overflow-hidden">
        <TopBar title="Create Alert" showTimeRange={false} />

        <div className="flex-1 flex overflow-hidden">
          {/* Left: Alert builder */}
          <div className="flex-1 bg-surface overflow-y-auto p-8">
            <div className="max-w-2xl mx-auto space-y-8">
              {/* Header */}
              <div>
                <h2 className="font-display font-bold text-xl">Create Alert: High Error Rate</h2>
                <p className="text-on-surface-variant text-sm mt-1">Define operational thresholds and notification logic</p>
              </div>

              {/* Condition */}
              <div className="bg-surface-high rounded-2xl p-5 space-y-3">
                <h3 className="text-sm font-medium text-on-surface-variant">Condition</h3>
                <div className="flex items-center gap-2 flex-wrap">
                  {['If', 'Error Rate', 'is greater than', '5%', 'for at least', '5m'].map((token, i) => (
                    <span
                      key={i}
                      className={`px-3 py-1.5 rounded-lg text-sm ${
                        i % 2 === 0
                          ? 'text-on-surface-variant'
                          : 'bg-surface-bright text-primary font-medium'
                      }`}
                    >
                      {token}
                    </span>
                  ))}
                </div>
              </div>

              {/* Severity */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-on-surface-variant">Severity</h3>
                <div className="flex gap-3">
                  {SEVERITIES.map((s) => (
                    <button
                      key={s.key}
                      onClick={() => setSeverity(s.key)}
                      className={`px-4 py-2 rounded-xl text-sm font-medium transition-all border ${
                        severity === s.key
                          ? 'bg-error/20 text-error border-error/60'
                          : 'bg-surface-high text-on-surface-variant border-transparent hover:bg-surface-highest'
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Preview chart */}
              <div className="bg-surface-high rounded-2xl p-5">
                <h3 className="text-sm text-on-surface-variant mb-3">Preview — Past 24h Error Rate</h3>
                <BarChart data={PREVIEW_DATA} height={160} color="#a3a6ff" unit="%" />
                <div className="mt-2 flex items-center gap-2">
                  <div className="flex-1 border-t border-dashed border-error/60" />
                  <span className="text-error text-xs font-medium">THRESHOLD 5%</span>
                </div>
              </div>

              {/* Notifications */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-on-surface-variant">Notification Channels</h3>
                <div className="space-y-2">
                  {[
                    { key: 'slack' as const, label: 'Slack', icon: 'chat' },
                    { key: 'pagerduty' as const, label: 'PagerDuty', icon: 'emergency' },
                    { key: 'email' as const, label: 'Email', icon: 'mail' },
                  ].map((ch) => (
                    <div
                      key={ch.key}
                      className="flex items-center justify-between bg-surface-high rounded-xl p-4"
                    >
                      <div className="flex items-center gap-3">
                        <span className="material-symbols-rounded text-on-surface-variant">{ch.icon}</span>
                        <span className="text-sm">{ch.label}</span>
                      </div>
                      <button
                        onClick={() => toggleNotification(ch.key)}
                        className={`w-10 h-6 rounded-full transition-all ${
                          notifications[ch.key] ? 'bg-primary' : 'bg-surface-highest'
                        }`}
                      >
                        <span
                          className={`block w-4 h-4 bg-white rounded-full shadow transition-transform mx-1 ${
                            notifications[ch.key] ? 'translate-x-4' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Save */}
              <Button size="lg" className="w-full justify-center">
                <span className="material-symbols-rounded text-base">save</span>
                Save Alert Rule
              </Button>
            </div>
          </div>

          {/* Right: AI Panel */}
          {isOpen && (
            <AIPanel
              suggestions={[
                { label: 'Adjust threshold', icon: 'tune' },
                { label: 'Add runbook link', icon: 'link' },
              ]}
              onSend={(msg) => addMessage({ role: 'user', content: msg })}
              placeholder="Refine alert or ask AI..."
            />
          )}
        </div>
      </div>
    </div>
  )
}
```

### `src/pages/Explorer.tsx`

Layout: SideNav + left folder sidebar + main content table + right AIPanel.

```tsx
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { SideNav } from '@/components/layout/SideNav'
import { AIPanel } from '@/components/layout/AIPanel'
import { Badge } from '@/components/ui/Badge'
import { StatusDot } from '@/components/ui/StatusDot'
import { Button } from '@/components/ui/Button'
import { useAIPanel } from '@/stores/aiPanel'
import { explorerApi, Asset, AssetType, AssetStatus } from '@/api/explorer'

const MOCK_ASSETS: Asset[] = [
  { id: '1', name: 'Kubernetes Cluster Health', type: 'dashboard', status: 'healthy', origin: 'ai_generated', lastActivity: '12m ago', author: 'AI', tags: ['production'] },
  { id: '2', name: 'Auth Service Spike Analysis', type: 'report', status: 'critical', origin: 'manual', lastActivity: '3h ago', author: 'Alex', tags: ['production'] },
  { id: '3', name: 'Postgres Read Latency', type: 'dashboard', status: 'healthy', origin: 'manual', lastActivity: '1d ago', author: 'Sam', tags: ['staging'] },
]

const FOLDERS = [
  { id: 'all', label: 'All Assets', count: 415 },
  { id: 'production', label: 'Production', count: 243 },
  { id: 'staging', label: 'Staging', count: 87 },
  { id: 'team-alpha', label: 'Team Alpha', count: 54 },
  { id: 'ai-insights', label: 'AI Insights', count: 31 },
]

const TYPE_ICONS: Record<string, string> = {
  dashboard: 'grid_view',
  report: 'description',
  alert: 'notifications',
}

export default function Explorer() {
  const [activeFolder, setActiveFolder] = useState('all')
  const [filterType, setFilterType] = useState<string>('all')
  const { isOpen, addMessage } = useAIPanel()

  const statusVariant = (status: AssetStatus) => {
    if (status === 'healthy') return 'secondary' as const
    if (status === 'critical') return 'error' as const
    return 'outline' as const
  }

  return (
    <div className="flex h-screen bg-surface-base overflow-hidden">
      <SideNav />

      {/* Folder sidebar */}
      <div className="w-48 flex-shrink-0 bg-surface-low flex flex-col py-4">
        <div className="px-4 mb-4">
          <span className="text-xs font-medium text-on-surface-variant uppercase tracking-widest">Library</span>
        </div>
        <div className="flex flex-col gap-0.5 px-2">
          {FOLDERS.map((folder) => (
            <button
              key={folder.id}
              onClick={() => setActiveFolder(folder.id)}
              className={`flex items-center justify-between px-3 py-2 rounded-xl text-sm transition-all ${
                activeFolder === folder.id
                  ? 'bg-primary/20 text-primary'
                  : 'text-on-surface-variant hover:bg-surface-high hover:text-on-surface'
              }`}
            >
              <span className="truncate">{folder.label}</span>
              <span className="text-xs opacity-60">{folder.count}</span>
            </button>
          ))}
        </div>
        <div className="mt-auto px-3">
          <button className="w-full text-xs text-on-surface-variant/60 hover:text-on-surface-variant py-2 flex items-center gap-1">
            <span className="material-symbols-rounded text-sm">create_new_folder</span>
            New Folder
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden bg-surface">
        {/* Header */}
        <div className="px-6 py-4 flex items-center justify-between flex-shrink-0">
          <div>
            <h1 className="font-display font-bold text-lg">All Assets</h1>
            <p className="text-on-surface-variant text-sm">Manage and filter your observability library</p>
          </div>
          <Button size="sm">
            <span className="material-symbols-rounded text-base">upload</span>
            Import Asset
          </Button>
        </div>

        {/* Filter bar */}
        <div className="px-6 pb-4 flex items-center gap-3 flex-shrink-0">
          {['all', 'dashboard', 'report', 'alert'].map((type) => (
            <button
              key={type}
              onClick={() => setFilterType(type)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-all ${
                filterType === type
                  ? 'bg-primary/20 text-primary'
                  : 'bg-surface-high text-on-surface-variant hover:text-on-surface'
              }`}
            >
              {type}
            </button>
          ))}
        </div>

        {/* Table */}
        <div className="flex-1 overflow-y-auto px-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-on-surface-variant text-xs uppercase tracking-wider border-b border-outline/20">
                <th className="text-left pb-3 font-medium">Asset Name</th>
                <th className="text-left pb-3 font-medium">Type</th>
                <th className="text-left pb-3 font-medium">Status</th>
                <th className="text-left pb-3 font-medium">Last Activity</th>
                <th className="text-left pb-3 font-medium">Author</th>
              </tr>
            </thead>
            <tbody>
              {MOCK_ASSETS.map((asset) => (
                <tr key={asset.id} className="border-b border-outline/10 hover:bg-white/[0.02] transition-all">
                  <td className="py-3.5">
                    <Link
                      to={asset.type === 'dashboard' ? `/dashboards/${asset.id}` : `/reports/${asset.id}`}
                      className="flex items-center gap-2 text-on-surface hover:text-primary transition-all"
                    >
                      <span className="material-symbols-rounded text-on-surface-variant text-base">
                        {TYPE_ICONS[asset.type]}
                      </span>
                      {asset.name}
                    </Link>
                  </td>
                  <td className="py-3.5">
                    <Badge variant={asset.origin === 'ai_generated' ? 'primary' : 'tertiary'}>
                      {asset.origin === 'ai_generated' ? 'AI Generated' : 'Manual'}
                    </Badge>
                  </td>
                  <td className="py-3.5">
                    <div className="flex items-center gap-2">
                      <StatusDot status={asset.status} />
                      <span className="capitalize text-on-surface-variant">{asset.status}</span>
                    </div>
                  </td>
                  <td className="py-3.5 text-on-surface-variant">{asset.lastActivity}</td>
                  <td className="py-3.5 text-on-surface-variant">{asset.author}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="py-4 flex items-center justify-between text-on-surface-variant text-xs">
            <span>Showing 1–3 of 415 results</span>
            <div className="flex items-center gap-1">
              {[1, 2, 3, '...', 8].map((p, i) => (
                <button key={i} className={`w-7 h-7 rounded-lg ${p === 1 ? 'bg-primary/20 text-primary' : 'hover:bg-surface-high'}`}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Right: AI Panel */}
      {isOpen && (
        <AIPanel
          suggestions={[
            { label: 'Compare Dashboard trends', icon: 'compare_arrows' },
            { label: 'Find critical alerts in prod', icon: 'crisis_alert' },
            { label: 'Generate Weekly Report', icon: 'summarize' },
          ]}
          onSend={(msg) => addMessage({ role: 'user', content: msg })}
          placeholder="Ask AI Curator..."
        />
      )}
    </div>
  )
}
```

### `src/pages/ExplorerFolder.tsx`

Same as Explorer but with folder-scoped view. Reuse Explorer with a `folderId` param.

```tsx
import Explorer from './Explorer'

// ExplorerFolder reuses Explorer layout but could be extended with folder-specific header
export default function ExplorerFolder() {
  return <Explorer />
}
```

---

## Implementation Notes

1. Run `npm install` in `packages/frontend` after creating package.json
2. The Vite dev server proxies `/api` to `http://localhost:4000` (backend)
3. All pages use mock data where backend APIs might not be ready — the structure is in place
4. `cn()` utility is in `src/lib/cn.ts` — used for conditional class merging
5. No 1px border lines for layout sections — use background color shifts only
6. The `col-span-${n}` Tailwind classes in DashboardGrid need to be in the safelist or use inline style for dynamic values — add to tailwind config:

```ts
safelist: [
  'col-span-1','col-span-2','col-span-3','col-span-4','col-span-5','col-span-6',
  'col-span-7','col-span-8','col-span-9','col-span-10','col-span-11','col-span-12'
]
```

7. After all files are created, run:
   ```
   cd packages/frontend && npm install
   ```
